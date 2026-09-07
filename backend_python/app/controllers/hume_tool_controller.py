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
now lives in app/services/hume_tool_sync_service.py (Phase 7 final-review wave, B6 —
previously ported here as the module-private `_HumeToolSyncService` class, with a note
that no `app/services/*` module existed yet for it). Imported below under its old
module-private name so existing call sites and tests (which monkeypatch
`app.controllers.hume_tool_controller._HumeToolSyncService`) keep working unchanged.
"""
from __future__ import annotations

import httpx

from app.config_.configuration import Configuration
from app.functions.analysis_functions import AnalysisFunctions
from app.functions.portfolio_functions import PortfolioFunctions
from app.functions.search_functions import SearchFunctions
from app.functions.watchlist_functions import WatchlistFunctions
from app.providers._http import SHARED_SSL_CONTEXT
from app.services.hume_tool_sync_service import HumeToolSyncService as _HumeToolSyncService
from app.services.hume_tool_sync_service import guzzleErrorMessage as _guzzleErrorMessage
from app.services.tools_manager import ToolsManager
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_now
from app.support.phpjson import dumps_pretty, php_json_decode


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
