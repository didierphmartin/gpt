"""Port of Controllers/EVIWebhookController.php (1-79).

EVI Webhook Controller

Receives tool call requests from Hume EVI and executes registered functions.

Route (routes.php:302) is `POST /api/v1/evi/webhook`, PUBLIC (no auth): it is
already in MiddlewareProcessor.php's PUBLIC_ROUTES and this port's mirror,
`app/middleware/processor.py::PUBLIC_ROUTES` — no change needed there.

No signature/HMAC verification exists anywhere in this PHP controller (or in
AIPortfolioAssistant/ToolsManager) despite the endpoint being an external
webhook — grep confirms no `hash_hmac`/`X-Hume-Signature` handling anywhere
under backend/src. Ported as-is (no signature check added); see
task-6-report.md for the brief-vs-PHP note.
"""
from __future__ import annotations

from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.llm_provider_resolver import LLMProviderResolver
from app.support.logger import error_log


class EVIWebhookController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config

    # ─── POST /api/v1/evi/webhook ────────────────────────────────────────────

    def handleWebhook(self, request) -> dict:
        """Handle incoming webhook from Hume EVI."""
        payload = request.get('body') if request.get('body') is not None else {}

        # Validate webhook payload
        if not payload or payload.get('tool_name') is None:
            return {
                'success': False,
                'error': 'Invalid webhook payload: missing tool_name',
                'status_code': 400,
            }

        toolName = payload['tool_name']
        parameters = payload.get('parameters') if payload.get('parameters') is not None else {}

        assistant = None
        try:
            config = LLMProviderResolver.applyDbSettings(self.db, self.config)
            assistant = AIPortfolioAssistant(config)
            toolsManager = assistant.getToolsManager()

            # PHP BUG (EVIWebhookController.php:53,63): calls `getAvailableTools()`
            # and `executeTool()` on the ToolsManager returned by getToolsManager().
            # Neither method exists on ToolsManager — its interface
            # (Contracts/FunctionExecutorInterface.php) only declares
            # execute/hasFunction/getRegisteredFunctions/getToolDefinitions/
            # registerFunction/isMCPTool; `executeTool()` only exists on the
            # unrelated MCPToolsLoader class. In PHP this is a "Call to
            # undefined method" \Error, which `catch (Exception $e)` below does
            # NOT catch (Error doesn't extend Exception) — it propagates to
            # index.php's outer `catch (Throwable $e)` (index.php:192-206),
            # which returns the SAME {'success': false, 'error': <message>,
            # status_code: 500} shape this method's own catch block returns for
            # any other exception. So any payload whose tool_name clears
            # validation above always ends in a 500 today; only the literal
            # exception-message text differs between "Call to undefined
            # method ToolsManager::getAvailableTools()" (PHP) and Python's
            # AttributeError text. Reproduced literally rather than "fixed"
            # (e.g. by routing through hasFunction()/execute() like
            # HumeToolController and ToolsController do) because the intended
            # design here is genuinely ambiguous (executeTool() takes no
            # userId/context arg, unlike ToolsManager.execute()) and this is a
            # public, unauthenticated, external-callback endpoint — silently
            # changing its behavior during a port is riskier than preserving
            # the crash for whoever eventually fixes the PHP bug. Unlike PHP,
            # Python's AttributeError IS an Exception subclass, so it IS
            # caught by the `except Exception` below (still a 500 either way).
            availableTools = toolsManager.getAvailableTools()

            if toolName not in availableTools:
                return {
                    'success': False,
                    'error': f"Tool not found: {toolName}",
                    'status_code': 404,
                }

            result = toolsManager.executeTool(toolName, parameters)

            return {
                'success': True,
                'result': result,
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            error_log(f"[EVIWebhookController] Error: {e}")
            return {
                'success': False,
                'error': str(e),
                'status_code': 500,
            }
        finally:
            # Python-only: PHP has no equivalent — Guzzle clients (via the
            # search/analysis functions AIPortfolioAssistant registers) die
            # with the request; this long-lived process must close them
            # explicitly (same pattern as ToolsController/HumeToolController).
            if assistant is not None:
                try:
                    assistant.close()
                except Exception as closeErr:  # noqa: BLE001
                    error_log(f"[EVIWebhookController] assistant.close() failed: {closeErr}")
