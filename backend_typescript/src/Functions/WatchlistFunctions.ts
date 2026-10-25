import { sql } from 'kysely';
import { db } from '../db/pools';
import { ToolsManager } from '../Services/ToolsManager';

const NO_DB = { error: 'Database connection or user ID not available' };
const errorOf = (e: any) => ({ error: e?.message ?? String(e) });
const truthy = (v: any) => !(v === null || v === undefined || v === false || v === 0 || v === '' || v === '0');

/**
 * Mirrors src/Functions/WatchlistFunctions.php — the watchlist LLM tools (list, list with market
 * data and price-alert status, add, remove), registered into a ToolsManager. Handlers get
 * (params, userId).
 */
export class WatchlistFunctions {
  static register(tools: ToolsManager): void {
    const f = new WatchlistFunctions();
    tools.registerFunction('get_user_watchlist', (p, u) => f.getUserWatchlist(p, u), {
      description: 'Get the user watchlist of tracked assets (NOT owned, just tracked for monitoring)',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
    tools.registerFunction('get_watchlist_with_market_data', (p, u) => f.getWatchlistWithMarketData(p, u), {
      description: 'Get watchlist with current market prices, changes, and performance metrics',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
    tools.registerFunction('add_to_watchlist', (p, u) => f.addToWatchlist(p, u), {
      description: 'Add an asset to the user watchlist',
      input_schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Asset symbol (e.g., AAPL, BTC)' },
          name: { type: 'string', description: 'Asset name' },
          type: { type: 'string', description: 'Asset type (stock, crypto, etf, etc.)' },
          exchange: { type: 'string', description: 'Exchange where the asset is traded' },
          currency: { type: 'string', description: 'Currency (default: USD)' },
        },
        required: ['symbol', 'name', 'type'],
      },
    });
    tools.registerFunction('remove_from_watchlist', (p, u) => f.removeFromWatchlist(p, u), {
      description: 'Remove an asset from the user watchlist',
      input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'Asset symbol to remove' } }, required: ['symbol'] },
    });
  }

  async getUserWatchlist(_params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      const items = (await sql<any>`SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency
                 FROM watchlist w
                 JOIN assets a ON w.asset_id = a.id
                 WHERE w.user_id = ${userId}
                 ORDER BY w.created_at DESC`.execute(db)).rows;
      return { success: true, watchlist: items, count: items.length };
    } catch (e) {
      return errorOf(e);
    }
  }

  async getWatchlistWithMarketData(_params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      const items = (await sql<any>`SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency,
                        ap.price as current_price, ap.change_24h, ap.change_percent_24h,
                        ap.volume_24h, ap.market_cap, ap.updated_at as price_updated_at
                 FROM watchlist w
                 JOIN assets a ON w.asset_id = a.id
                 LEFT JOIN asset_prices ap ON a.id = ap.asset_id
                 WHERE w.user_id = ${userId}
                 ORDER BY w.created_at DESC`.execute(db)).rows;
      for (const item of items) {
        item.alert_triggered = false;
        if (truthy(item.alert_price_above) && Number(item.current_price ?? 0) >= Number(item.alert_price_above)) {
          item.alert_triggered = true;
          item.alert_type = 'above';
        }
        if (truthy(item.alert_price_below) && Number(item.current_price ?? 0) <= Number(item.alert_price_below)) {
          item.alert_triggered = true;
          item.alert_type = 'below';
        }
      }
      return { success: true, watchlist: items, count: items.length };
    } catch (e) {
      return errorOf(e);
    }
  }

  async addToWatchlist(params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      const symbol = String(params?.symbol ?? '').toUpperCase();
      const name = params?.name ?? symbol;
      const type = params?.type ?? 'stock';
      const exchange = params?.exchange ?? null;
      const currency = params?.currency ?? 'USD';
      if (!truthy(symbol)) return { error: 'Symbol is required' };

      const asset = (await sql<any>`SELECT id FROM assets WHERE symbol = ${symbol}`.execute(db)).rows[0];
      let assetId: any;
      if (!asset) {
        const ins = await sql`INSERT INTO assets (symbol, name, type, exchange, currency, created_at)
                     VALUES (${symbol}, ${name}, ${type}, ${exchange}, ${currency}, NOW())`.execute(db);
        assetId = String(ins.insertId ?? 0);
      } else {
        assetId = asset.id;
      }

      const existing = (await sql<any>`SELECT id FROM watchlist WHERE user_id = ${userId} AND asset_id = ${assetId}`.execute(db)).rows[0];
      if (existing) return { success: false, message: `${symbol} is already in your watchlist` };

      const added = await sql`INSERT INTO watchlist (user_id, asset_id, created_at) VALUES (${userId}, ${assetId}, NOW())`.execute(db);
      return { success: true, message: `${symbol} (${name}) added to watchlist`, watchlist_id: String(added.insertId ?? 0) };
    } catch (e) {
      return errorOf(e);
    }
  }

  async removeFromWatchlist(params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      const symbol = String(params?.symbol ?? '').toUpperCase();
      if (!truthy(symbol)) return { error: 'Symbol is required' };
      const res = await sql`DELETE w FROM watchlist w
                 JOIN assets a ON w.asset_id = a.id
                 WHERE w.user_id = ${userId} AND a.symbol = ${symbol}`.execute(db);
      if (Number(res.numAffectedRows ?? 0) > 0) return { success: true, message: `${symbol} removed from watchlist` };
      return { success: false, message: `${symbol} was not found in your watchlist` };
    } catch (e) {
      return errorOf(e);
    }
  }
}
