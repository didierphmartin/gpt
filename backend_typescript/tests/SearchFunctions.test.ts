import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolsManager } from '../src/Services/ToolsManager';
import { SearchFunctions } from '../src/Functions/SearchFunctions';

/**
 * src/Functions/SearchFunctions.php: the registered tools (AIPortfolioAssistantTest::
 * testSearchFunctionsAreRegisteredByDefault) and each handler against a fake fetch.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = { url: string; headers: any };
function answers(...replies: Array<{ status?: number; body: any } | Error>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    const next = replies.shift();
    if (next === undefined) throw new Error('no reply queued');
    if (next instanceof Error) throw next;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  }) as any;
  return seen;
}

const tools = (keys = { serpapi: 'serp-key', brave: 'brave-key' }) => {
  const m = new ToolsManager();
  SearchFunctions.register(m, keys);
  return m;
};

test('registers the PHP search tools in order', () => {
  assert.deepEqual(tools().getRegisteredFunctions(), [
    'serpapi_search', 'brave_search', 'search_assets', 'get_trending_assets',
    'get_top_gainers', 'get_top_losers', 'get_sec_filings', 'get_sec_filing_document',
  ]);
  const serp = tools().getToolDefinitions()[0];
  assert.deepEqual(serp.input_schema.required, ['query']);
});

test('serpapi_search needs a key', async () => {
  assert.deepEqual(await tools({ serpapi: '', brave: '' }).execute('serpapi_search', { query: 'x' }), { error: 'SerpAPI key not configured' });
});

test('serpapi_search maps the organic results and clamps count', async () => {
  const seen = answers({ body: { organic_results: [{ title: 'T', link: 'L', snippet: 'S', position: 1 }, { title: 'U' }] } });
  const r = await tools().execute('serpapi_search', { query: 'php vs ts', count: 50 });
  const url = new URL(seen[0].url);
  assert.equal(url.origin + url.pathname, 'https://serpapi.com/search');
  assert.equal(url.searchParams.get('q'), 'php vs ts');
  assert.equal(url.searchParams.get('num'), '20');
  assert.equal(url.searchParams.get('location'), 'United States');
  assert.equal(url.searchParams.get('engine'), 'google');
  assert.equal(url.searchParams.get('api_key'), 'serp-key');
  assert.deepEqual(r, {
    success: true, query: 'php vs ts', count: 2,
    results: [{ title: 'T', link: 'L', snippet: 'S', position: 1 }, { title: 'U', link: '', snippet: '', position: 0 }],
  });
});

test('serpapi_search reports an HTTP error as a failed search', async () => {
  answers({ status: 401, body: 'bad key' });
  const r = await tools().execute('serpapi_search', { query: 'x' });
  assert.match(r.error, /^Search failed: Client error: `GET https:\/\/serpapi\.com\/search\?.*` resulted in a `401 Unauthorized` response:\nbad key$/);
});

test('brave_search sends the token header and maps web results', async () => {
  const seen = answers({ body: { web: { results: [{ title: 'T', url: 'U', description: 'D' }] } } });
  const r = await tools().execute('brave_search', { query: 'q', count: 0 });
  assert.equal(seen[0].headers['X-Subscription-Token'], 'brave-key');
  assert.equal(new URL(seen[0].url).searchParams.get('count'), '1');
  assert.deepEqual(r, { success: true, query: 'q', count: 1, results: [{ title: 'T', link: 'U', snippet: 'D' }] });
});

test('brave_search needs a key', async () => {
  assert.deepEqual(await tools({ serpapi: 'x', brave: '' }).execute('brave_search', { query: 'x' }), { error: 'Brave Search API key not configured' });
});

test('the asset tools are placeholders', async () => {
  const m = tools();
  assert.deepEqual(await m.execute('search_assets', { query: 'BTC' }), { success: true, message: 'Asset search requires database connection', query: 'BTC' });
  assert.deepEqual(await m.execute('get_trending_assets', {}), { success: true, message: 'Trending assets requires market data API', limit: 10 });
  assert.deepEqual(await m.execute('get_top_gainers', { limit: 3 }), { success: true, message: 'Top gainers requires market data API', limit: 3 });
  assert.deepEqual(await m.execute('get_top_losers', {}), { success: true, message: 'Top losers requires market data API', limit: 10 });
});

test('get_sec_filings pads a CIK and fetches the company facts', async () => {
  const seen = answers({ body: { entityName: 'Apple' } });
  const r = await tools().execute('get_sec_filings', { symbol_or_cik: '320193' });
  assert.equal(seen[0].url, 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json');
  assert.equal(seen[0].headers['User-Agent'], 'GPT Chatbot admin@company.com');
  assert.deepEqual(r, { success: true, data_type: 'facts', cik: '0000320193', data: { entityName: 'Apple' } });
});

test('get_sec_filings resolves a ticker through company_tickers.json', async () => {
  const seen = answers({ body: { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple' } } }, { body: { filings: [] } });
  const r = await tools().execute('get_sec_filings', { symbol_or_cik: 'aapl', data_type: 'submissions' });
  assert.equal(seen[0].url, 'https://www.sec.gov/files/company_tickers.json');
  assert.equal(seen[1].url, 'https://data.sec.gov/submissions/CIK0000320193.json');
  assert.equal(r.cik, '0000320193');
});

test('get_sec_filings errors', async () => {
  const m = tools();
  assert.deepEqual(await m.execute('get_sec_filings', {}), { error: 'symbol_or_cik is required' });
  answers({ body: {} });
  assert.deepEqual(await m.execute('get_sec_filings', { symbol_or_cik: 'ZZZZ' }), { error: 'Could not resolve symbol/CIK: ZZZZ' });
  assert.deepEqual(await m.execute('get_sec_filings', { symbol_or_cik: '1', data_type: 'companyconcept' }), { error: 'Invalid data_type: companyconcept (concept required)' });
  assert.deepEqual(await m.execute('get_sec_filings', { symbol_or_cik: '1', data_type: 'nope' }), { error: 'Invalid data_type: nope' });
  answers({ status: 404, body: '' });
  assert.match((await m.execute('get_sec_filings', { symbol_or_cik: '1' })).error, /^SEC EDGAR API error: Client error: `GET .*` resulted in a `404 Not Found` response$/);
});

test('get_sec_filings fetches a company concept', async () => {
  const seen = answers({ body: { units: {} } });
  await tools().execute('get_sec_filings', { symbol_or_cik: '1', data_type: 'companyconcept', concept: 'us-gaap:Revenue' });
  assert.equal(seen[0].url, 'https://data.sec.gov/api/xbrl/companyconcept/CIK0000000001/us-gaap:Revenue.json');
});

test('get_sec_filing_document returns a 5000-byte preview by default', async () => {
  const doc = 'x'.repeat(6000);
  const seen = answers({ body: doc });
  const r = await tools().execute('get_sec_filing_document', { accession_number: '0000320193-24-000123' });
  assert.equal(seen[0].url, 'https://www.sec.gov/Archives/edgar/data/000032019324000123/0000320193-24-000123.txt');
  assert.equal(r.content_preview.length, 5000);
  assert.equal(r.full_length, 6000);
  assert.equal(r.document, '0000320193-24-000123.txt');
  assert.equal(r.note, 'Showing first 5000 characters. Full document available at SEC EDGAR.');
});

test('get_sec_filing_document raw format and errors', async () => {
  const m = tools();
  answers({ body: '<html/>' });
  assert.deepEqual(await m.execute('get_sec_filing_document', { accession_number: 'a-b', primary_document: 'd.htm', format: 'raw' }), {
    success: true, accession_number: 'a-b', document: 'd.htm', content: '<html/>',
  });
  assert.deepEqual(await m.execute('get_sec_filing_document', {}), { error: 'accession_number is required' });
  answers(new Error('boom'));
  assert.deepEqual(await m.execute('get_sec_filing_document', { accession_number: 'a' }), { error: 'SEC filing document error: boom' });
});
