import { ToolsManager } from '../Services/ToolsManager';

/**
 * Mirrors src/Functions/SearchFunctions.php — registers search/market tools into ToolsManager.
 * Phase 2 ships ONE stub (`get_trending_assets`) to exercise the server-tool loop end-to-end
 * without an external dependency. Phase 3 replaces the stub with the real handlers (and adds the
 * other ~20 tools across the Functions/* classes).
 */
export class SearchFunctions {
  static register(tools: ToolsManager): void {
    tools.registerFunction(
      'get_trending_assets',
      // STUB: fixed data, no external call. Replace with the real FMP/search call in Phase 3.
      async (params: any) => {
        const limit = Number(params?.limit ?? 5);
        const trending = [
          { symbol: 'BTC', name: 'Bitcoin', change_percent: 4.2 },
          { symbol: 'NVDA', name: 'NVIDIA', change_percent: 3.1 },
          { symbol: 'ETH', name: 'Ethereum', change_percent: 2.7 },
          { symbol: 'AAPL', name: 'Apple', change_percent: 1.4 },
          { symbol: 'TSLA', name: 'Tesla', change_percent: 1.1 },
        ].slice(0, Math.max(1, limit));
        return { trending, _stub: true };
      },
      {
        description: 'Get the current top trending assets (stocks/crypto) by recent momentum.',
        input_schema: {
          type: 'object',
          properties: { limit: { type: 'integer', description: 'Max number of assets to return (default 5).' } },
          required: [],
        },
      },
    );
  }
}
