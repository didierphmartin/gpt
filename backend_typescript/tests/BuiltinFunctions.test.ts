import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { ToolsManager } from '../src/Services/ToolsManager';
import { PortfolioFunctions } from '../src/Functions/PortfolioFunctions';
import { WatchlistFunctions } from '../src/Functions/WatchlistFunctions';
import { AnalysisFunctions } from '../src/Functions/AnalysisFunctions';
import { RootController } from '../src/Controllers/RootController';

/**
 * src/Functions/PortfolioFunctions.php, WatchlistFunctions.php and AnalysisFunctions.php (the
 * HumeToolController registry) and RootController.php. Fake Kysely executor; fetch replaced.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the Hume registry order and tool names match PHP', () => {
  const t = new ToolsManager();
  WatchlistFunctions.register(t);
  PortfolioFunctions.register(t);
  AnalysisFunctions.register(t, 'k');
  assert.deepEqual(t.getRegisteredFunctions(), [
    'get_user_watchlist', 'get_watchlist_with_market_data', 'add_to_watchlist', 'remove_from_watchlist',
    'get_portfolios', 'get_portfolio_assets_with_discovery', 'get_portfolio_diversification', 'get_all_transactions',
    'get_analyst_ratings', 'get_financial_ratios', 'get_price_targets', 'get_company_profile', 'get_asset_sentiment',
  ]);
});

test('every DB tool refuses without a user id', async () => {
  const p = new PortfolioFunctions();
  const w = new WatchlistFunctions();
  for (const r of [await p.getPortfolios({}, null), await w.getUserWatchlist({}, 0), await w.addToWatchlist({ symbol: 'x' }, null)]) {
    assert.deepEqual(r, { error: 'Database connection or user ID not available' });
  }
});

test('portfolio holdings: default portfolio discovery, gain/loss and summary', async () => {
  installFakeDb((sql) => {
    if (sql.includes('is_default = 1')) return [];
    if (sql.includes('ORDER BY id ASC')) return [{ id: 9 }];
    if (sql.includes('FROM portfolio_assets pa')) return [{ current_value: '150.00', total_cost: '100.00' }, { current_value: '50', total_cost: '0' }];
    return [];
  });
  const r = await new PortfolioFunctions().getPortfolioAssetsWithDiscovery({}, 3);
  assert.equal(r.portfolio_id, 9);
  assert.deepEqual(r.assets.map((a: any) => [a.gain_loss, a.gain_loss_percent]), [[50, 50], [50, 0]]);
  assert.deepEqual(r.summary, { total_value: 200, total_cost: 100, total_gain_loss: 100, total_gain_loss_percent: 100, asset_count: 2 });
});

test('transactions: clamped paging, whitelisted sort and order', async () => {
  installFakeDb((sql) => (sql.startsWith('SELECT COUNT(*)') ? [{ c: 120 }] : []));
  const r = await new PortfolioFunctions().getAllTransactions({ page: 2, limit: 500, sort: 'amount', order: 'asc' }, 3);
  assert.deepEqual(r.pagination, { page: 2, limit: 100, total: 120, total_pages: 2 });
  assert.match(queries[0].sql, /ORDER BY t\.amount ASC\s+LIMIT \? OFFSET \?$/);
  assert.deepEqual(queries[0].parameters, [3, 100, 100]);
  installFakeDb(() => []);
  await new PortfolioFunctions().getAllTransactions({ sort: 'evil; DROP' }, 3);
  assert.match(queries[0].sql, /ORDER BY t\.date DESC/);
});

test('watchlist alerts flag above/below thresholds', async () => {
  installFakeDb(() => [
    { symbol: 'A', current_price: '10', alert_price_above: '9', alert_price_below: null },
    { symbol: 'B', current_price: '5', alert_price_above: null, alert_price_below: '6' },
    { symbol: 'C', current_price: '5', alert_price_above: '0', alert_price_below: null },
  ]);
  const r = await new WatchlistFunctions().getWatchlistWithMarketData({}, 3);
  assert.deepEqual(r.watchlist.map((i: any) => [i.alert_triggered, i.alert_type]), [[true, 'above'], [true, 'below'], [false, undefined]]);
});

test('add_to_watchlist creates the asset, refuses a duplicate; remove reports not found', async () => {
  installFakeDb((sql) => {
    if (sql.startsWith('SELECT id FROM assets')) return [];
    if (sql.startsWith('INSERT INTO assets')) return { insertId: 11 };
    if (sql.startsWith('SELECT id FROM watchlist')) return [];
    if (sql.startsWith('INSERT INTO watchlist')) return { insertId: 21 };
    return [];
  });
  assert.deepEqual(await new WatchlistFunctions().addToWatchlist({ symbol: 'btc', name: 'Bitcoin', type: 'crypto' }, 3),
    { success: true, message: 'BTC (Bitcoin) added to watchlist', watchlist_id: '21' });
  installFakeDb((sql) => (sql.startsWith('SELECT id FROM assets') || sql.startsWith('SELECT id FROM watchlist') ? [{ id: 1 }] : []));
  assert.deepEqual(await new WatchlistFunctions().addToWatchlist({ symbol: 'btc' }, 3), { success: false, message: 'BTC is already in your watchlist' });
  installFakeDb(() => ({ numAffectedRows: 0 }));
  assert.deepEqual(await new WatchlistFunctions().removeFromWatchlist({ symbol: 'eth' }, 3), { success: false, message: 'ETH was not found in your watchlist' });
  assert.deepEqual(await new WatchlistFunctions().removeFromWatchlist({}, 3), { error: 'Symbol is required' });
});

test('analysis tools: key required, last 10 ratings, first profile, HTTP errors as Guzzle words them', async () => {
  assert.deepEqual(await new AnalysisFunctions('').getAnalystRatings({ symbol: 'aapl' }), { error: 'FMP API key not configured' });
  const urls: string[] = [];
  globalThis.fetch = (async (u: any) => {
    urls.push(String(u));
    if (String(u).includes('/profile/')) return new Response('[{"companyName":"Apple"}]', { status: 200 });
    if (String(u).includes('/ratios/')) return new Response('{"Error Message":"bad key"}', { status: 401, statusText: 'Unauthorized' });
    return new Response(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ i }))), { status: 200 });
  }) as any;
  const a = new AnalysisFunctions('K');
  const ratings = await a.getAnalystRatings({ symbol: 'aapl' });
  assert.equal(ratings.symbol, 'AAPL');
  assert.equal(ratings.ratings.length, 10);
  assert.equal(urls[0], 'https://financialmodelingprep.com/api/v3/grade/AAPL?apikey=K');
  assert.deepEqual(await a.getCompanyProfile({ symbol: 'aapl' }), { success: true, symbol: 'AAPL', profile: { companyName: 'Apple' } });
  const err = await a.getFinancialRatios({ symbol: 'aapl' });
  assert.equal(err.error, 'Failed to fetch financial ratios: Client error: `GET https://financialmodelingprep.com/api/v3/ratios/AAPL?apikey=K&limit=1` resulted in a `401 Unauthorized` response:\n{"Error Message":"bad key"}');
  assert.deepEqual(a.getAssetSentiment({ symbol: 'btc' }), { success: true, symbol: 'BTC', message: 'Sentiment analysis requires integration with news/social APIs' });
});

test('RootController answers PHP\'s health payload', () => {
  const r = new RootController().index();
  assert.equal(r.message, 'GPT Chat Backend API');
  assert.equal(r.version, '2.0.0');
  assert.equal(r.endpoints.drive, '/api/v1/drive/*');
  assert.equal(r.status_code, 200);
});
