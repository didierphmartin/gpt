"""Port of Controllers/ProviderController.php.

Provider Controller

Handles AI provider listing and switching.
"""
from __future__ import annotations

import json

from app.agent_team.functions.agent_delegation_functions import AgentDelegationFunctions
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.llm_provider_resolver import LLMProviderResolver
from app.services.mcp_tools_loader import MCPToolsLoader
from app.services.package_resolver import PackageResolver
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_empty, php_intval


class ProviderController:
    def __init__(self, db, config):
        self.db = db
        self.config = config

    def list(self, request) -> dict:
        """List all available AI providers.

        If user is authenticated and has custom API keys, marks those providers
        as user-enabled. Otherwise, returns all system-available providers.
        """
        try:
            # Apply DB-backed LLM provider settings (system_llm_settings is the
            # source of truth post-cutover; ai_config.php no longer carries
            # provider blocks). Without this, the assistant has no providers.
            config = LLMProviderResolver.applyDbSettings(self.db, self.config)
            assistant = AIPortfolioAssistant(config)
            try:
                # First try to load providers from database (system_llm_settings)
                allProviders = self._getProvidersFromDatabase()
                currentProvider = None

                if php_empty(allProviders):
                    # Fallback to config file for providers
                    allProviders = assistant.getAllProviders()

                # Package-based allowlist: keep only providers that the caller's
                # role-based package has enabled. Guests / unauthenticated callers
                # fall through to the guest package via PackageResolver.
                userIdForPackage = request.get('user_id')
                allowedProviders = self._resolvePackageAllowedProviders(
                    php_intval(userIdForPackage) if is_numeric(userIdForPackage) else None
                )
                if allowedProviders is not None:
                    allProviders = [
                        p for p in allProviders
                        if (p.get('name') if p.get('name') is not None else '') in allowedProviders
                    ]

                # Note: there is no longer a "current/default" provider concept.
                # Callers must specify provider explicitly; missing provider is a bug.

                # Get registered functions (built-in)
                functions = list(assistant.getToolsManager().getRegisteredFunctions())

                # Load MCP tools and merge with built-in functions.
                # The package-based allowlist limits tools to servers the caller's
                # role is permitted to see.
                mcpLoader = None
                try:
                    mcpLoader = MCPToolsLoader(self.db)
                    mcpAllowlist = PackageResolver(self.db).allowedMcpServers(
                        php_intval(userIdForPackage) if is_numeric(userIdForPackage) else None
                    )
                    mcpLoader.loadToolsForUser(None, mcpAllowlist)
                    if mcpLoader.hasTools():
                        mcpTools = mcpLoader.getTools()
                        for toolName in mcpTools:
                            functions.append(toolName)
                except Exception as e:  # noqa: BLE001
                    # Log but don't fail if MCP loading fails
                    error_log("ProviderController: Failed to load MCP tools: " + str(e))
                finally:
                    # Python-only: PHP has no equivalent — Guzzle clients die
                    # with the request. Guarded on construction: the
                    # MCPToolsLoader(...) call itself can be what raised.
                    # Same idiom as chat_controller.py:1764/2112.
                    if mcpLoader is not None:
                        try:
                            mcpLoader.close()
                        except Exception as closeErr:  # noqa: BLE001
                            error_log("ProviderController: mcpLoader.close() failed: " + str(closeErr))

                # Add delegation tools (for agent teams feature)
                delegationTools = AgentDelegationFunctions.getToolNames()
                for toolName in delegationTools:
                    functions.append(toolName)

                # Check if user has custom API keys
                userId = request.get('user_id')
                userHasCustomKeys = False
                userEnabledProviders = []

                if not php_empty(userId):   # PHP `if ($userId)`
                    # Get user's custom API keys
                    sql = "SELECT provider FROM user_api_keys WHERE user_id = :user_id AND api_key IS NOT NULL AND api_key != ''"
                    userKeys = self.db.fetch_column(sql, {':user_id': userId})

                    if not php_empty(userKeys):
                        userHasCustomKeys = True
                        userEnabledProviders = userKeys

                # If user has custom keys, mark which providers they have enabled
                # All system providers remain available, but user-enabled ones are marked
                for provider in allProviders:
                    provider['user_has_key'] = provider.get('name') in userEnabledProviders
                    # Provider is available if: system has it configured OR user has their own key
                    if userHasCustomKeys:
                        # When user has custom keys, only show as available if they have a key for it
                        # OR if it's a system default provider
                        provider['available'] = bool(provider['available']) or bool(provider['user_has_key'])

                return {
                    'success': True,
                    'providers': allProviders,
                    'current_provider': currentProvider,
                    'user_has_custom_keys': userHasCustomKeys,
                    'user_enabled_providers': userEnabledProviders,
                    'functions': functions,
                    'function_count': len(functions),
                    'status_code': 200
                }
            finally:
                # Python-only: PHP's Guzzle clients die with the request; here the
                # assistant holds up to eight httpx.Clients that must be closed.
                assistant.close()
        except Exception as e:  # noqa: BLE001
            return {
                'success': False,
                'error': str(e),
                'status_code': 500
            }

    def switch(self, request) -> dict:
        """Switch to a different AI provider."""
        newProvider = (request.get('body') or {}).get('provider')

        if php_empty(newProvider):
            return {
                'success': False,
                'error': 'Provider name is required',
                'status_code': 400
            }

        try:
            config = LLMProviderResolver.applyDbSettings(self.db, self.config)
            assistant = AIPortfolioAssistant(config)
            try:
                assistant.setProvider(newProvider)
            finally:
                assistant.close()   # Python-only (see list())

            return {
                'success': True,
                'message': f"Switched to provider: {newProvider}",
                'current_provider': newProvider,
                'status_code': 200
            }
        except Exception as e:  # noqa: BLE001
            return {
                'success': False,
                'error': str(e),
                'status_code': 400
            }

    def _resolvePackageAllowedProviders(self, userId: int | None) -> list | None:
        """Resolve the caller's role-based package and return the list of provider
        names it allows (providers[name].enabled === true). Returns None when
        the package has no providers entry so the caller can fall back to
        "show everything" instead of "hide everything".
        """
        try:
            resolver = PackageResolver(self.db)
            package = resolver.resolveForUser(userId)
            capabilities = package.get('capabilities') if isinstance(package, dict) else None
            providers = capabilities.get('providers') if isinstance(capabilities, dict) else None

            if not isinstance(providers, (dict, list)):
                return None

            allowed = []
            items = providers.items() if isinstance(providers, dict) else enumerate(providers)
            for name, cfg in items:
                if isinstance(cfg, (dict, list)) and not php_empty(
                        cfg.get('enabled') if isinstance(cfg, dict) else None):
                    allowed.append(name)
            return allowed
        except Exception as e:  # noqa: BLE001
            error_log("[ProviderController] Package allowlist resolution failed: " + str(e))
            return None

    def _getProvidersFromDatabase(self) -> list:
        """Load providers from database (system_llm_settings table)."""
        try:
            sql = "SELECT * FROM system_llm_settings WHERE enabled = 1 ORDER BY sort_order ASC, display_name ASC"
            rows = self.db.fetch_all(sql)

            if php_empty(rows):
                return []

            providers = []
            for row in rows:
                raw = row['supported_models'] if row.get('supported_models') is not None else '[]'
                try:
                    supported = json.loads(raw)
                except (ValueError, TypeError):
                    supported = None   # PHP json_decode returns null on invalid JSON
                providers.append({
                    'name': row['provider_key'],
                    'display_name': row['display_name'],
                    'model': row['model'],
                    'available': True,
                    'supported_models': supported,
                    'max_tokens': php_intval(row['max_tokens']),
                    'api_format': row['api_format'],
                })

            return providers
        except Exception as e:  # noqa: BLE001
            error_log("[ProviderController] Error loading providers from DB: " + str(e))
            return []
