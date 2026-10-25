import { ToolsManager } from '../Services/ToolsManager';
import { guzzleHttpErrorMessage } from '../Providers/OpenAICompatibleProvider';

const symbolSchema = (description: string) => ({
  type: 'object',
  properties: { symbol: { type: 'string', description } },
  required: ['symbol'],
});

/**
 * Mirrors src/Functions/AnalysisFunctions.php — financial-analysis LLM tools over Financial
 * Modeling Prep (analyst grades, ratios, price targets, company profile) plus the sentiment
 * placeholder, registered into a ToolsManager. The FMP key is PHP's financial.fmp.api_key (FMP_KEY).
 */
export class AnalysisFunctions {
  constructor(private readonly apiKey: string = process.env.FMP_KEY ?? '') {}

  static register(tools: ToolsManager, apiKey?: string): void {
    const f = new AnalysisFunctions(apiKey);
    tools.registerFunction('get_analyst_ratings', (p) => f.getAnalystRatings(p), {
      description: 'Get analyst ratings and recommendations for a stock',
      input_schema: symbolSchema('Stock symbol (e.g., AAPL)'),
    });
    tools.registerFunction('get_financial_ratios', (p) => f.getFinancialRatios(p), {
      description: 'Get financial ratios for a company (P/E, P/B, ROE, etc.)',
      input_schema: symbolSchema('Stock symbol'),
    });
    tools.registerFunction('get_price_targets', (p) => f.getPriceTargets(p), {
      description: 'Get analyst price targets for a stock',
      input_schema: symbolSchema('Stock symbol'),
    });
    tools.registerFunction('get_company_profile', (p) => f.getCompanyProfile(p), {
      description: 'Get company profile and basic information',
      input_schema: symbolSchema('Stock symbol'),
    });
    tools.registerFunction('get_asset_sentiment', (p) => f.getAssetSentiment(p), {
      description: 'Get market sentiment for an asset based on news and social media',
      input_schema: symbolSchema('Asset symbol'),
    });
  }

  /** Guzzle GET with a 30s timeout; 4xx/5xx throw (http_errors). Returns the decoded JSON. */
  private async get(url: string, query: Record<string, string | number>): Promise<any> {
    const full = url + '?' + new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const res = await fetch(full, { signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    if (res.status >= 400) throw new Error(guzzleHttpErrorMessage('GET', full, res.status, res.statusText, body));
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  private static slice10(data: any): any[] {
    if (data === null || typeof data !== 'object') {
      throw new Error(`array_slice(): Argument #1 ($array) must be of type array, ${data === null ? 'null' : typeof data} given`);
    }
    return Object.values(data).slice(0, 10);
  }

  private async symbolCall(params: any, label: string, run: (symbol: string) => Promise<Record<string, any>>): Promise<any> {
    if (!this.apiKey) return { error: 'FMP API key not configured' };
    try {
      const symbol = String(params?.symbol ?? '').toUpperCase();
      if (symbol === '' || symbol === '0') return { error: 'Symbol is required' };
      return { success: true, symbol, ...(await run(symbol)) };
    } catch (e: any) {
      return { error: `Failed to fetch ${label}: ` + (e?.message ?? e) };
    }
  }

  getAnalystRatings(params: any): Promise<any> {
    return this.symbolCall(params, 'analyst ratings', async (s) => ({
      ratings: AnalysisFunctions.slice10(await this.get(`https://financialmodelingprep.com/api/v3/grade/${s}`, { apikey: this.apiKey })),
    }));
  }

  getFinancialRatios(params: any): Promise<any> {
    return this.symbolCall(params, 'financial ratios', async (s) => ({
      ratios: (await this.get(`https://financialmodelingprep.com/api/v3/ratios/${s}`, { apikey: this.apiKey, limit: 1 }))?.[0] ?? [],
    }));
  }

  getPriceTargets(params: any): Promise<any> {
    return this.symbolCall(params, 'price targets', async (s) => ({
      price_targets: AnalysisFunctions.slice10(await this.get('https://financialmodelingprep.com/api/v4/price-target', { apikey: this.apiKey, symbol: s })),
    }));
  }

  getCompanyProfile(params: any): Promise<any> {
    return this.symbolCall(params, 'company profile', async (s) => ({
      profile: (await this.get(`https://financialmodelingprep.com/api/v3/profile/${s}`, { apikey: this.apiKey }))?.[0] ?? [],
    }));
  }

  /** Placeholder (PHP: would integrate with a sentiment API). */
  getAssetSentiment(params: any): any {
    return {
      success: true,
      symbol: String(params?.symbol ?? '').toUpperCase(),
      message: 'Sentiment analysis requires integration with news/social APIs',
    };
  }
}
