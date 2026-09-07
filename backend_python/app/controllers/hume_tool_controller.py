"""Port of Controllers/HumeToolController.php (1-270).

Hume Tool Controller

Handles Hume EVI tool operations:
- Execute tool functions
- List available tools
- Sync tools to Hume API
- Get sync status
- Test Hume connection
- Get Hume config

`private` PHP methods -> `_name`. `HumeToolSyncService` (Services/HumeToolSyncService.php)
is ported here as the module-private `_HumeToolSyncService` class rather than a
separate `app/services/*` module: it is instantiated fresh by this controller only
(never shared — PHP:123/156/181 all do `new HumeToolSyncService(...)`), and the task's
file-staging guard lists only the two controllers + routes.py + tests, not a new
service module.
"""
from __future__ import annotations

import hashlib

import httpx

from app.config_.configuration import Configuration
from app.functions.analysis_functions import AnalysisFunctions
from app.functions.portfolio_functions import PortfolioFunctions
from app.functions.search_functions import SearchFunctions
from app.functions.watchlist_functions import WatchlistFunctions
from app.providers._http import SHARED_SSL_CONTEXT, guzzle_body_summary
from app.services.tools_manager import ToolsManager
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_now
from app.support.phpjson import dumps_pretty, php_json_decode, php_json_encode


def _guzzleErrorMessage(request: httpx.Request, response: httpx.Response) -> str:
    """Port of GuzzleHttp\\Exception\\RequestException::create()'s message format
    (Guzzle's default, no http_errors=false anywhere in HumeToolSyncService.php /
    HumeToolController.php, so every non-2xx response reaches Guzzle's own
    exception message that `$e->getMessage()` returns)."""
    status = response.status_code
    level = status // 100
    if level == 4:
        label = 'Client error'
    elif level == 5:
        label = 'Server error'
    else:
        label = 'Unsuccessful request'
    message = f"{label}: `{request.method} {request.url}` resulted in a `{status} {response.reason_phrase}` response"
    summary = guzzle_body_summary(response.text)
    if summary:
        message += f":\n{summary}\n"
    return message


class _HumeToolSyncService:
    """Port of Services/HumeToolSyncService.php. Module-private (see file docstring)."""

    def __init__(self, config: dict, db=None):
        self.config = config
        humeCfg = config.get('hume_evi') if isinstance(config.get('hume_evi'), dict) else {}
        self.apiKey = humeCfg.get('api_key') if humeCfg.get('api_key') is not None else ''
        self.baseUrl = humeCfg.get('base_url') if humeCfg.get('base_url') is not None else 'https://api.hume.ai/v0/evi'
        self.db = db

        if php_empty(self.apiKey):
            raise RuntimeError('Hume API key not configured')

        self.httpClient = httpx.Client(
            timeout=30,
            verify=SHARED_SSL_CONTEXT,
            headers={'X-Hume-Api-Key': self.apiKey, 'Content-Type': 'application/json'},
        )

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request."""
        self.httpClient.close()

    def syncAllTools(self, toolsManager: ToolsManager) -> dict:
        localTools = toolsManager.getToolDefinitions()
        humeTools = self.listHumeTools()

        results = {
            'total_local': len(localTools),
            'total_hume': len(humeTools),
            'created': [],
            'updated': [],
            'unchanged': [],
            'errors': [],
            'tool_mapping': {},
        }

        humeToolsMap = {t.get('name'): t for t in humeTools if isinstance(t, dict)}

        for localTool in localTools:
            toolName = localTool.get('name', 'unknown')
            try:
                if toolName in humeToolsMap:
                    humeTool = humeToolsMap[toolName]
                    if self._toolNeedsUpdate(localTool, humeTool):
                        updated = self.updateTool(humeTool.get('id'), localTool)
                        results['updated'].append(toolName)
                        results['tool_mapping'][toolName] = self._toolIdFrom(updated)
                    else:
                        results['unchanged'].append(toolName)
                        results['tool_mapping'][toolName] = humeTool.get('id')
                else:
                    created = self.createTool(localTool)
                    results['created'].append(toolName)
                    results['tool_mapping'][toolName] = self._toolIdFrom(created)

                if self.db is not None and results['tool_mapping'].get(toolName) is not None:
                    self._storeToolMapping(toolName, results['tool_mapping'][toolName], localTool)

            except Exception as e:  # noqa: BLE001
                results['errors'].append({'tool': toolName, 'error': str(e)})

        humeCfg = self.config.get('hume_evi') if isinstance(self.config.get('hume_evi'), dict) else {}
        cleanupOrphaned = humeCfg.get('cleanup_orphaned_tools') if humeCfg.get('cleanup_orphaned_tools') is not None else False
        if cleanupOrphaned:
            results['deleted'] = self._cleanupOrphanedTools(localTools, humeTools)

        return results

    @staticmethod
    def _toolIdFrom(data) -> object:
        """`$data['tool_id'] ?? $data['id']` — null-safe against a non-array
        decode (PHP8 warns but yields null for both, same as here)."""
        if not isinstance(data, dict):
            return None
        return data.get('tool_id') if data.get('tool_id') is not None else data.get('id')

    def getSyncStatus(self, toolsManager: ToolsManager) -> dict:
        localTools = toolsManager.getToolDefinitions()
        humeTools = self.listHumeTools()

        localNames = [t.get('name') for t in localTools]
        humeNames = [t.get('name') for t in humeTools if isinstance(t, dict)]

        missingInHume = [n for n in localNames if n not in humeNames]
        missingInLocal = [n for n in humeNames if n not in localNames]

        return {
            'local_count': len(localTools),
            'hume_count': len(humeTools),
            'missing_in_hume': missingInHume,
            'missing_in_local': missingInLocal,
            'needs_sync': len(missingInHume) > 0,
            'local_tools': localNames,
            'hume_tools': humeNames,
        }

    def listHumeTools(self) -> list:
        try:
            response = self.httpClient.get(
                f"{self.baseUrl}/tools",
                params={'page_size': 100, 'restrict_to_most_recent': 'true'},
            )
            response.raise_for_status()
            data = php_json_decode(response.text)
            return data.get('tools_page') if isinstance(data, dict) and data.get('tools_page') is not None else []
        except httpx.HTTPStatusError as e:
            raise RuntimeError('Failed to list Hume tools: ' + _guzzleErrorMessage(e.request, e.response)) from e
        except httpx.RequestError as e:
            raise RuntimeError('Failed to list Hume tools: ' + str(e)) from e

    def createTool(self, toolDefinition: dict) -> dict | None:
        try:
            cleanedSchema = self._removeDefaultFields(toolDefinition.get('input_schema') or {})
            payload = {
                'name': toolDefinition.get('name'),
                'parameters': php_json_encode(cleanedSchema),
                'description': toolDefinition.get('description') if toolDefinition.get('description') is not None else '',
                'version_description': 'Auto-synced from backend',
            }
            response = self.httpClient.post(f"{self.baseUrl}/tools", json=payload)
            response.raise_for_status()
            return php_json_decode(response.text)
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"Failed to create tool '{toolDefinition.get('name')}': " + _guzzleErrorMessage(e.request, e.response)
            ) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Failed to create tool '{toolDefinition.get('name')}': " + str(e)) from e

    def updateTool(self, toolId, toolDefinition: dict) -> dict | None:
        """Hume uses versioning — creating a new version updates the tool."""
        return self.createTool(toolDefinition)

    def deleteTool(self, toolId) -> bool:
        try:
            response = self.httpClient.delete(f"{self.baseUrl}/tools/{toolId}")
            response.raise_for_status()
            return True
        except httpx.HTTPStatusError as e:
            raise RuntimeError('Failed to delete tool: ' + _guzzleErrorMessage(e.request, e.response)) from e
        except httpx.RequestError as e:
            raise RuntimeError('Failed to delete tool: ' + str(e)) from e

    def linkToolsToConfig(self, configId: str, toolIds: list) -> dict | None:
        try:
            tools = [{'id': tid} for tid in toolIds]
            response = self.httpClient.post(f"{self.baseUrl}/configs/{configId}", json={'tools': tools})
            response.raise_for_status()
            return php_json_decode(response.text)
        except httpx.HTTPStatusError as e:
            raise RuntimeError('Failed to link tools to config: ' + _guzzleErrorMessage(e.request, e.response)) from e
        except httpx.RequestError as e:
            raise RuntimeError('Failed to link tools to config: ' + str(e)) from e

    def _toolNeedsUpdate(self, localTool: dict, humeTool: dict) -> bool:
        cleanedLocalSchema = self._removeDefaultFields(localTool.get('input_schema') or {})
        localParams = php_json_encode(cleanedLocalSchema)
        humeParams = humeTool.get('parameters') if humeTool.get('parameters') is not None else '{}'

        if localParams != humeParams:
            return True

        localDesc = localTool.get('description') if localTool.get('description') is not None else ''
        humeDesc = humeTool.get('description') if humeTool.get('description') is not None else ''

        return localDesc != humeDesc

    def _removeDefaultFields(self, schema):
        """Remove 'default' fields from schema (Hume doesn't support them)."""
        if isinstance(schema, dict):
            result = {}
            for key, value in schema.items():
                if key == 'default':
                    continue
                result[key] = self._removeDefaultFields(value) if isinstance(value, (dict, list)) else value
            return result
        if isinstance(schema, list):
            return [self._removeDefaultFields(v) if isinstance(v, (dict, list)) else v for v in schema]
        return schema

    def _cleanupOrphanedTools(self, localTools: list, humeTools: list) -> list:
        localNames = [t.get('name') for t in localTools]
        deleted = []

        for humeTool in humeTools:
            if not isinstance(humeTool, dict):
                continue
            if humeTool.get('name') not in localNames:
                try:
                    self.deleteTool(humeTool.get('tool_id'))
                    deleted.append(humeTool.get('name'))
                except Exception as e:  # noqa: BLE001
                    error_log(f"Failed to delete orphaned tool {humeTool.get('name')}: {e}")

        return deleted

    def _storeToolMapping(self, toolName: str, humeToolId, definition: dict) -> None:
        if self.db is None:
            return

        try:
            definitionHash = hashlib.md5(php_json_encode(definition).encode('utf-8')).hexdigest()

            self.db.execute(
                "INSERT INTO hume_tool_mapping (tool_name, hume_tool_id, definition_hash, last_synced)\n"
                " VALUES (?, ?, ?, NOW())\n"
                " ON DUPLICATE KEY UPDATE\n"
                "    hume_tool_id = VALUES(hume_tool_id),\n"
                "    definition_hash = VALUES(definition_hash),\n"
                "    last_synced = NOW()",
                [toolName, humeToolId, definitionHash],
            )
        except Exception as e:  # noqa: BLE001
            # Table might not exist yet, that's okay
            error_log(f"Could not store tool mapping: {e}")

    def getStoredMappings(self) -> list:
        if self.db is None:
            return []

        try:
            return self.db.fetch_all("SELECT * FROM hume_tool_mapping ORDER BY tool_name")
        except Exception:  # noqa: BLE001
            return []

    def testConnection(self) -> dict:
        try:
            tools = self.listHumeTools()
            return {
                'success': True,
                'message': 'Connected to Hume API successfully',
                'tools_count': len(tools),
            }
        except Exception as e:  # noqa: BLE001
            return {
                'success': False,
                'message': f'Failed to connect: {e}',
            }


class HumeToolController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        self._searchFunctions: SearchFunctions | None = None
        self._analysisFunctions: AnalysisFunctions | None = None
        self.toolsManager = self._initializeToolsManager()

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Releases the httpx connection pools opened by
        SearchFunctions/AnalysisFunctions during _initializeToolsManager()."""
        for fns in (self._searchFunctions, self._analysisFunctions):
            if fns is not None:
                try:
                    fns.close()
                except Exception as closeErr:  # noqa: BLE001
                    error_log(f"[HumeToolController] close() failed: {closeErr}")

    # ─── POST /api/v1/hume/tools/execute ────────────────────────────────────

    def execute(self, request) -> dict:
        """Execute a tool function."""
        try:
            input_ = request.get('body') if request.get('body') is not None else {}

            toolCallId = input_.get('toolCallId')
            toolName = input_.get('toolName')
            parameters = input_.get('parameters') if input_.get('parameters') is not None else {}

            if php_empty(toolCallId) or php_empty(toolName):
                return {
                    'success': False,
                    'error': 'Missing toolCallId or toolName',
                    'status_code': 400,
                }

            # Get user ID from session or input
            userId = input_.get('userId')
            if userId is None:
                userId = request.get('user_id')
            if userId is None:
                userId = 'demo-user'

            # Check if function exists
            if not self.toolsManager.hasFunction(toolName):
                return {
                    'success': False,
                    'error': f"Function not found: {toolName}",
                    'toolCallId': toolCallId,
                    'availableFunctions': self.toolsManager.getRegisteredFunctions(),
                    'status_code': 404,
                }

            # Execute the tool
            result = self.toolsManager.execute(toolName, parameters, userId)

            # Format response for Hume EVI (content must be a string)
            content = dumps_pretty(result, unescaped=False)  # json_encode($result, JSON_PRETTY_PRINT)

            return {
                'success': True,
                'toolCallId': toolCallId,
                'toolName': toolName,
                'content': content,
                'result': result,
                'status_code': 200,
            }
        finally:
            self.close()

    # ─── GET /api/v1/hume/tools/list ────────────────────────────────────────

    def list(self, request) -> dict:
        """List available tools in Hume format."""
        try:
            claudeDefinitions = self.toolsManager.getToolDefinitions()

            humeTools = []
            for tool in claudeDefinitions:
                humeTools.append({
                    'name': tool['name'],
                    'description': tool['description'],
                    'parameters': tool['input_schema'],
                })

            return {
                'success': True,
                'tools': humeTools,
                'count': len(humeTools),
                'note': 'Copy these tool definitions to your Hume EVI configuration',
                'status_code': 200,
            }
        finally:
            self.close()

    # ─── POST /api/v1/hume/tools/sync ───────────────────────────────────────

    def sync(self, request) -> dict:
        """Sync tools to Hume API."""
        try:
            try:
                syncService = _HumeToolSyncService(self.config, self.db)
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 500}
            try:
                results = syncService.syncAllTools(self.toolsManager)

                return {
                    'success': True,
                    'message': 'Tools synchronized successfully',
                    'stats': {
                        'total_local': results['total_local'],
                        'total_hume': results['total_hume'],
                        'created': len(results['created']),
                        'updated': len(results['updated']),
                        'unchanged': len(results['unchanged']),
                        'errors': len(results['errors']),
                    },
                    'details': results,
                    'timestamp': php_now(),
                    'status_code': 200,
                }
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 500}
            finally:
                syncService.close()
        finally:
            self.close()

    # ─── GET /api/v1/hume/tools/status ──────────────────────────────────────

    def getStatus(self, request) -> dict:
        """Get sync status."""
        try:
            try:
                syncService = _HumeToolSyncService(self.config, self.db)
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 500}
            try:
                status = syncService.getSyncStatus(self.toolsManager)

                return {
                    'success': True,
                    'status': status,
                    'needs_action': (not php_empty(status['missing_in_hume'])) or (not php_empty(status['missing_in_local'])),
                    'timestamp': php_now(),
                    'status_code': 200,
                }
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'error': str(e), 'status_code': 500}
            finally:
                syncService.close()
        finally:
            self.close()

    # ─── GET /api/v1/hume/tools/test-connection ─────────────────────────────

    def testConnection(self, request) -> dict:
        """Test Hume API connection."""
        try:
            try:
                syncService = _HumeToolSyncService(self.config, self.db)
            except Exception as e:  # noqa: BLE001
                return {'success': False, 'message': f'Connection failed: {e}', 'status_code': 500}
            try:
                result = syncService.testConnection()
                return {**result, 'status_code': 200 if result.get('success') else 500}
            finally:
                syncService.close()
        finally:
            self.close()

    # ─── GET /api/v1/hume/config ─────────────────────────────────────────────

    def getConfig(self, request) -> dict:
        """Get current Hume EVI configuration."""
        try:
            humeCfg = self.config.get('hume_evi') if isinstance(self.config.get('hume_evi'), dict) else {}
            configId = humeCfg.get('config_id') if humeCfg.get('config_id') is not None else ''

            if php_empty(configId):
                return {
                    'success': False,
                    'error': 'No config_id set in ai_config.php',
                    'status_code': 400,
                }

            apiKey = humeCfg.get('api_key') if humeCfg.get('api_key') is not None else ''
            baseUrl = humeCfg.get('base_url') if humeCfg.get('base_url') is not None else 'https://api.hume.ai/v0/evi'

            httpClient = httpx.Client(timeout=30, verify=SHARED_SSL_CONTEXT)
            try:
                response = httpClient.get(
                    f"{baseUrl}/configs/{configId}",
                    headers={'X-Hume-Api-Key': apiKey},
                )
                response.raise_for_status()

                configData = php_json_decode(response.text)

                return {
                    'success': True,
                    'config': configData,
                    'status_code': 200,
                }
            except httpx.HTTPStatusError as e:
                return {'success': False, 'error': _guzzleErrorMessage(e.request, e.response), 'status_code': 500}
            except httpx.RequestError as e:
                return {'success': False, 'error': str(e), 'status_code': 500}
            finally:
                httpClient.close()
        finally:
            self.close()

    # ─── internals ───────────────────────────────────────────────────────────

    def _initializeToolsManager(self) -> ToolsManager:
        """Initialize and register all functions."""
        toolsManager = ToolsManager()

        # Create Configuration object from array
        config = Configuration(self.config)

        # Register functions that need PDO
        try:
            watchlistFunctions = WatchlistFunctions(self.db)
            toolsManager.registerFunctions(watchlistFunctions.getAllFunctions())

            portfolioFunctions = PortfolioFunctions(self.db)
            toolsManager.registerFunctions(portfolioFunctions.getAllFunctions())
        except Exception as e:  # noqa: BLE001
            error_log(f"[HumeToolController] Failed to register DB functions: {e}")

        # Register functions that need configuration
        searchFunctions = SearchFunctions(config)
        self._searchFunctions = searchFunctions
        toolsManager.registerFunctions(searchFunctions.getAllFunctions())

        analysisFunctions = AnalysisFunctions(config)
        self._analysisFunctions = analysisFunctions
        toolsManager.registerFunctions(analysisFunctions.getAllFunctions())

        # Financial News, Crypto News, PubMed, and Battery News functions disabled - using external MCP servers instead
        # (battery_news_get_all, battery_news_search)

        return toolsManager
