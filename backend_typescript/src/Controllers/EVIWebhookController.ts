import { Ctx, ControllerResult } from '../Support/Http';
import { ToolsManager } from '../Services/ToolsManager';
import { SearchFunctions } from '../Functions/SearchFunctions';

/**
 * EVIWebhookController — TS mirror of src/Controllers/EVIWebhookController.php.
 *
 * Receives tool call requests from Hume EVI and executes registered functions.
 *
 * Route (PHP src/routes.php line 262, public): POST /api/v1/evi/webhook -> handleWebhook
 *
 * Faithful-divergence notes:
 *  - PHP builds its tool registry per request via LLMProviderResolver::applyDbSettings + a full
 *    AIPortfolioAssistant (which registers the Portfolio/Watchlist/Analysis/Search function sets).
 *    Neither applyDbSettings nor AIPortfolioAssistant is ported to TS; like ChatController and
 *    ToolsController, the registry here is a plain ToolsManager with the Functions/* classes that
 *    exist so far (SearchFunctions only), so fewer tools are available until the rest are ported.
 *  - Latent PHP bug, deliberately NOT reproduced: the PHP controller calls
 *    $toolsManager->getAvailableTools() and ->executeTool(), which do not exist on ToolsManager —
 *    every payload with a valid tool_name dies with "Call to undefined method" (a 500 via
 *    index.php's Throwable handler). This port implements the evident intent using the real
 *    ToolsManager API: getRegisteredFunctions() + execute().
 */
export class EVIWebhookController {
  private readonly toolsManager: ToolsManager;

  constructor() {
    this.toolsManager = new ToolsManager();
    SearchFunctions.register(this.toolsManager);
  }

  /** POST /api/v1/evi/webhook — handle incoming webhook from Hume EVI. */
  async handleWebhook(ctx: Ctx): Promise<ControllerResult> {
    const payload = ctx.body;

    // Validate webhook payload (PHP isset(): absent OR null tool_name -> 400).
    if (!payload || payload.tool_name === undefined || payload.tool_name === null) {
      return {
        success: false,
        error: 'Invalid webhook payload: missing tool_name',
        status_code: 400,
      };
    }

    const toolName = payload.tool_name;
    const parameters = payload.parameters ?? {};

    try {
      // Check if tool exists.
      const availableTools = this.toolsManager.getRegisteredFunctions();
      if (!availableTools.includes(toolName)) {
        return {
          success: false,
          error: `Tool not found: ${toolName}`,
          status_code: 404,
        };
      }

      // Execute the tool.
      const result = await this.toolsManager.execute(toolName, parameters);

      return {
        success: true,
        result,
        status_code: 200,
      };
    } catch (e: any) {
      console.error('[EVIWebhookController] Error:', e?.message ?? e);
      return {
        success: false,
        error: e?.message ?? String(e),
        status_code: 500,
      };
    }
  }
}
