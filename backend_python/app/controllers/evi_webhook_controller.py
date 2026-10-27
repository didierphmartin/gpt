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

            # Check if tool exists
            if not toolsManager.hasFunction(str(toolName)):
                return {
                    'success': False,
                    'error': f"Tool not found: {toolName}",
                    'status_code': 404,
                }

            # Execute the tool
            result = toolsManager.execute(str(toolName), parameters)

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
