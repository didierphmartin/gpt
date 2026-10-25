import { ToolsManager } from '../Services/ToolsManager';
import { guzzleHttpErrorMessage } from '../Providers/OpenAICompatibleProvider';

/** The search API keys PHP reads from config (ai_config.php: search.serpapi / search.brave). */
export interface SearchKeys {
  serpapi?: string;
  brave?: string;
}

const limitSchema = {
  type: 'object',
  properties: { limit: { type: 'integer', description: 'Number of results (default: 10)' } },
  required: [],
};

/** PHP (int) cast. */
function phpInt(v: any): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const m = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(v);
    return m ? Math.trunc(Number(m[0])) : 0;
  }
  return 0;
}

/** PHP is_numeric() on a string or number. */
function isNumeric(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

/** PHP empty() on a request value. */
function empty(v: any): boolean {
  return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && v.length === 0);
}

const SEC_UA = 'GPT Chatbot admin@company.com'; // Required by SEC

/**
 * Mirrors src/Functions/SearchFunctions.php — the web search (SerpAPI, Brave), asset placeholders
 * and SEC EDGAR tools, registered into a ToolsManager in PHP's order. HTTP goes through fetch with
 * Guzzle's behaviour: the request timeout, and 4xx/5xx raised as Guzzle's error message.
 */
export class SearchFunctions {
  private readonly keys: Required<SearchKeys>;

  constructor(keys: SearchKeys = {}) {
    this.keys = {
      serpapi: keys.serpapi ?? process.env.SERPAPI_KEY ?? '',
      brave: keys.brave ?? process.env.BRAVE_KEY ?? '',
    };
  }

  static register(tools: ToolsManager, keys?: SearchKeys): void {
    const f = new SearchFunctions(keys);
    tools.registerFunction('serpapi_search', (p) => f.serpApiSearch(p), {
      description: 'Search the web using SerpAPI (Google search). Use for current events, company info, product research, software tools.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'integer', description: 'Number of results (default: 10)' },
          location: { type: 'string', description: 'Search location (default: United States)' },
        },
        required: ['query'],
      },
    });
    tools.registerFunction('brave_search', (p) => f.braveSearch(p), {
      description: 'Search the web using Brave Search API. Fallback search option.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'integer', description: 'Number of results (default: 10)' },
        },
        required: ['query'],
      },
    });
    tools.registerFunction('search_assets', (p) => f.searchAssets(p), {
      description: 'Search for assets (stocks, crypto, ETFs) by name or symbol',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query (name or symbol)' } },
        required: ['query'],
      },
    });
    tools.registerFunction('get_trending_assets', (p) => f.getTrendingAssets(p), {
      description: 'Get trending/popular assets',
      input_schema: limitSchema,
    });
    tools.registerFunction('get_top_gainers', (p) => f.getTopGainers(p), {
      description: 'Get top gaining assets by percentage',
      input_schema: limitSchema,
    });
    tools.registerFunction('get_top_losers', (p) => f.getTopLosers(p), {
      description: 'Get top losing assets by percentage',
      input_schema: limitSchema,
    });
    tools.registerFunction('get_sec_filings', (p) => f.getSecFilings(p), {
      description: 'Get SEC EDGAR filings and financial data for US public companies. Returns company facts, financial statements, and filing information.',
      input_schema: {
        type: 'object',
        properties: {
          symbol_or_cik: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL) or SEC CIK number' },
          data_type: {
            type: 'string',
            description: 'Type of data: facts (company facts), submissions (filings list), or companyconcept (specific concept). Default: facts',
          },
          concept: {
            type: 'string',
            description: 'XBRL concept for companyconcept data_type (e.g., us-gaap:Revenue, dei:EntityCommonStockSharesOutstanding)',
          },
        },
        required: ['symbol_or_cik'],
      },
    });
    tools.registerFunction('get_sec_filing_document', (p) => f.getSecFilingDocument(p), {
      description: 'Get specific SEC filing document content (10-K, 10-Q, 8-K, etc.)',
      input_schema: {
        type: 'object',
        properties: {
          accession_number: { type: 'string', description: 'SEC accession number (format: 0000000000-00-000000)' },
          primary_document: { type: 'string', description: 'Primary document filename (optional, auto-detected if not provided)' },
          format: { type: 'string', description: 'Response format: summary (AI-processed summary) or raw (full HTML). Default: summary' },
        },
        required: ['accession_number'],
      },
    });
  }

  /** Guzzle GET: the timeout, query string, and http_errors (4xx/5xx throw). Returns the body text. */
  private async get(url: string, opts: { query?: Record<string, any>; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
    let full = url;
    if (opts.query) {
      full += '?' + new URLSearchParams(Object.entries(opts.query).map(([k, v]): [string, string] => [k, String(v)])).toString();
    }
    const res = await fetch(full, { headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    const body = await res.text();
    if (res.status >= 400) throw new Error(guzzleHttpErrorMessage('GET', full, res.status, res.statusText, body));
    return body;
  }

  private static json(body: string): any {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  async serpApiSearch(params: any): Promise<any> {
    const apiKey = this.keys.serpapi;
    if (empty(apiKey)) return { error: 'SerpAPI key not configured' };
    try {
      const query = params?.query ?? '';
      const count = Math.min(20, Math.max(1, phpInt(params?.count ?? 10)));
      const location = params?.location ?? 'United States';
      const data = SearchFunctions.json(
        await this.get('https://serpapi.com/search', { query: { api_key: apiKey, q: query, num: count, location, engine: 'google' } }),
      );
      const results = (Array.isArray(data?.organic_results) ? data.organic_results : []).map((r: any) => ({
        title: r?.title ?? '',
        link: r?.link ?? '',
        snippet: r?.snippet ?? '',
        position: r?.position ?? 0,
      }));
      return { success: true, query, results, count: results.length };
    } catch (e: any) {
      return { error: 'Search failed: ' + (e?.message ?? e) };
    }
  }

  async braveSearch(params: any): Promise<any> {
    const apiKey = this.keys.brave;
    if (empty(apiKey)) return { error: 'Brave Search API key not configured' };
    try {
      const query = params?.query ?? '';
      const count = Math.min(20, Math.max(1, phpInt(params?.count ?? 10)));
      const data = SearchFunctions.json(
        await this.get('https://api.search.brave.com/res/v1/web/search', {
          headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
          query: { q: query, count },
        }),
      );
      const results = (Array.isArray(data?.web?.results) ? data.web.results : []).map((r: any) => ({
        title: r?.title ?? '',
        link: r?.url ?? '',
        snippet: r?.description ?? '',
      }));
      return { success: true, query, results, count: results.length };
    } catch (e: any) {
      return { error: 'Search failed: ' + (e?.message ?? e) };
    }
  }

  /** Placeholder (PHP: would query a database or external API). */
  searchAssets(params: any): any {
    return { success: true, message: 'Asset search requires database connection', query: params?.query ?? '' };
  }

  getTrendingAssets(params: any): any {
    return { success: true, message: 'Trending assets requires market data API', limit: params?.limit ?? 10 };
  }

  getTopGainers(params: any): any {
    return { success: true, message: 'Top gainers requires market data API', limit: params?.limit ?? 10 };
  }

  getTopLosers(params: any): any {
    return { success: true, message: 'Top losers requires market data API', limit: params?.limit ?? 10 };
  }

  async getSecFilings(params: any): Promise<any> {
    const symbolOrCik = params?.symbol_or_cik ?? '';
    const dataType = params?.data_type ?? 'facts';
    const concept = params?.concept ?? null;

    if (empty(symbolOrCik)) return { error: 'symbol_or_cik is required' };

    const cik = await this.resolveToCik(String(symbolOrCik));
    if (!cik) return { error: `Could not resolve symbol/CIK: ${symbolOrCik}` };

    try {
      let url: string | null = null;
      if (dataType === 'facts') url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
      else if (dataType === 'submissions') url = `https://data.sec.gov/submissions/CIK${cik}.json`;
      else if (dataType === 'companyconcept') url = !empty(concept) ? `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${concept}.json` : null;

      if (!url) {
        return { error: `Invalid data_type: ${dataType}` + (dataType === 'companyconcept' && empty(concept) ? ' (concept required)' : '') };
      }

      const data = SearchFunctions.json(await this.get(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } }));
      return { success: true, data_type: dataType, cik, data };
    } catch (e: any) {
      return { error: 'SEC EDGAR API error: ' + (e?.message ?? e) };
    }
  }

  async getSecFilingDocument(params: any): Promise<any> {
    const accessionNumber = params?.accession_number ?? '';
    let primaryDocument = params?.primary_document ?? null;
    const format = params?.format ?? 'summary';

    if (empty(accessionNumber)) return { error: 'accession_number is required' };

    // Format accession number for URL (remove dashes)
    const accessionPath = String(accessionNumber).replace(/-/g, '');

    try {
      // No primary document: PHP's simplified fallback, `<accession>.txt`.
      if (empty(primaryDocument)) primaryDocument = `${accessionNumber}.txt`;

      const docUrl = `https://www.sec.gov/Archives/edgar/data/${accessionPath}/${primaryDocument}`;
      const content = await this.get(docUrl, { headers: { 'User-Agent': SEC_UA } });

      if (format === 'summary') {
        // substr / strlen count bytes.
        const bytes = Buffer.from(content, 'utf8');
        return {
          success: true,
          accession_number: accessionNumber,
          document: primaryDocument,
          content_preview: bytes.subarray(0, 5000).toString('utf8'),
          full_length: bytes.length,
          note: 'Showing first 5000 characters. Full document available at SEC EDGAR.',
        };
      }
      return { success: true, accession_number: accessionNumber, document: primaryDocument, content };
    } catch (e: any) {
      return { error: 'SEC filing document error: ' + (e?.message ?? e) };
    }
  }

  /** A ticker or CIK as the 10-digit padded CIK, or null. */
  private async resolveToCik(symbolOrCik: string): Promise<string | null> {
    if (isNumeric(symbolOrCik)) return symbolOrCik.padStart(10, '0');

    try {
      const tickers = SearchFunctions.json(
        await this.get('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': SEC_UA }, timeoutMs: 10_000 }),
      );
      const symbolUpper = symbolOrCik.toUpperCase();
      for (const company of Object.values(tickers ?? {}) as any[]) {
        if (company?.ticker !== undefined && company?.ticker !== null && String(company.ticker).toUpperCase() === symbolUpper) {
          return String(company.cik_str).padStart(10, '0');
        }
      }
    } catch {
      // If ticker lookup fails, return null
    }
    return null;
  }
}
