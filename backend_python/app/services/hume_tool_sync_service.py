"""Port of Services/HumeToolSyncService.php.

Extracted from app/controllers/hume_tool_controller.py (Phase 7 final-review
wave, B6) — previously ported as that module's private `_HumeToolSyncService`
class with a note that no `app/services/*` module existed for it yet in this
task's file-staging guard. `hume_tool_controller.py` re-imports `HumeToolSyncService`
under its old module-private name (`_HumeToolSyncService`) so existing call
sites and tests keep working unchanged.

`guzzleErrorMessage` (a free function, no PHP class of its own) moves here
too — it exists only to format the same GuzzleHttp\\Exception\\RequestException
message this service's HTTP calls raise, and the controller's own error
handling (HumeToolController.executeTool) borrows it for the same purpose.
"""
from __future__ import annotations

import hashlib

import httpx

from app.providers._http import SHARED_SSL_CONTEXT, guzzle_body_summary
from app.services.tools_manager import ToolsManager
from app.support.logger import error_log
from app.support.phpcompat import php_empty
from app.support.phpjson import php_json_decode, php_json_encode


def guzzleErrorMessage(request: httpx.Request, response: httpx.Response) -> str:
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


class HumeToolSyncService:
    """Port of Services/HumeToolSyncService.php."""

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
            raise RuntimeError('Failed to list Hume tools: ' + guzzleErrorMessage(e.request, e.response)) from e
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
                f"Failed to create tool '{toolDefinition.get('name')}': " + guzzleErrorMessage(e.request, e.response)
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
            raise RuntimeError('Failed to delete tool: ' + guzzleErrorMessage(e.request, e.response)) from e
        except httpx.RequestError as e:
            raise RuntimeError('Failed to delete tool: ' + str(e)) from e

    def linkToolsToConfig(self, configId: str, toolIds: list) -> dict | None:
        try:
            tools = [{'id': tid} for tid in toolIds]
            response = self.httpClient.post(f"{self.baseUrl}/configs/{configId}", json={'tools': tools})
            response.raise_for_status()
            return php_json_decode(response.text)
        except httpx.HTTPStatusError as e:
            raise RuntimeError('Failed to link tools to config: ' + guzzleErrorMessage(e.request, e.response)) from e
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
