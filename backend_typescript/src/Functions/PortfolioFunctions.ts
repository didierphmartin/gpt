import { sql } from 'kysely';
import { db } from '../db/pools';
import { ToolsManager } from '../Services/ToolsManager';

const NO_DB = { error: 'Database connection or user ID not available' };
const errorOf = (e: any) => ({ error: e?.message ?? String(e) });
const num = (v: any) => {
  const n = parseFloat(String(v ?? 0));
  return Number.isNaN(n) ? 0 : n;
};
const intVal = (v: any) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * Mirrors src/Functions/PortfolioFunctions.php — the portfolio LLM tools (portfolios,
 * holdings with gain/loss, diversification by asset type, paged transactions), registered into a
 * ToolsManager. Handlers get (params, userId).
 */
export class PortfolioFunctions {
  static register(tools: ToolsManager): void {
    const f = new PortfolioFunctions();
    tools.registerFunction('get_portfolios', (p, u) => f.getPortfolios(p, u), {
      description: 'Get all portfolios for the current user',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
    tools.registerFunction('get_portfolio_assets_with_discovery', (p, u) => f.getPortfolioAssetsWithDiscovery(p, u), {
      description: 'PRIMARY FUNCTION FOR PORTFOLIO ANALYSIS - Get comprehensive portfolio holdings with current prices, values, and performance metrics. Automatically discovers the default portfolio.',
      input_schema: {
        type: 'object',
        properties: { portfolio_id: { type: 'integer', description: 'Optional specific portfolio ID. If not provided, uses default portfolio.' } },
        required: [],
      },
    });
    tools.registerFunction('get_portfolio_diversification', (p, u) => f.getPortfolioDiversification(p, u), {
      description: 'Get portfolio diversification breakdown by asset type, sector, and currency',
      input_schema: { type: 'object', properties: { portfolio_id: { type: 'integer', description: 'Portfolio ID to analyze' } }, required: [] },
    });
    tools.registerFunction('get_all_transactions', (p, u) => f.getAllTransactions(p, u), {
      description: 'Get all transactions for the user with pagination',
      input_schema: {
        type: 'object',
        properties: {
          page: { type: 'integer', description: 'Page number (default: 1)' },
          limit: { type: 'integer', description: 'Items per page (default: 50)' },
          sort: { type: 'string', description: 'Sort field (default: date)' },
          order: { type: 'string', description: 'Sort order: asc or desc (default: desc)' },
        },
        required: [],
      },
    });
  }

  async getPortfolios(_params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      const portfolios = (await sql<any>`SELECT id, name, description, is_default, currency, created_at
                 FROM portfolios WHERE user_id = ${userId} ORDER BY is_default DESC, name ASC`.execute(db)).rows;
      return { success: true, portfolios, count: portfolios.length };
    } catch (e) {
      return errorOf(e);
    }
  }

  async getPortfolioAssetsWithDiscovery(params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      let portfolioId: any = params?.portfolio_id ?? null;
      if (!portfolioId) {
        const def = (await sql<any>`SELECT id FROM portfolios WHERE user_id = ${userId} AND is_default = 1 LIMIT 1`.execute(db)).rows[0];
        portfolioId = def?.id ?? null;
        if (!portfolioId) {
          const first = (await sql<any>`SELECT id FROM portfolios WHERE user_id = ${userId} ORDER BY id ASC LIMIT 1`.execute(db)).rows[0];
          portfolioId = first?.id ?? null;
        }
      }
      if (!portfolioId) return { success: false, message: 'No portfolio found for user', assets: [] };

      const assets = (await sql<any>`SELECT pa.*, a.name as asset_name, a.symbol, a.type as asset_type,
                        a.exchange, a.currency
                 FROM portfolio_assets pa
                 JOIN assets a ON pa.asset_id = a.id
                 WHERE pa.portfolio_id = ${portfolioId}
                 ORDER BY pa.current_value DESC`.execute(db)).rows;
      let totalValue = 0;
      let totalCost = 0;
      for (const asset of assets) {
        const value = num(asset.current_value);
        const cost = num(asset.total_cost);
        totalValue += value;
        totalCost += cost;
        asset.gain_loss = value - cost;
        asset.gain_loss_percent = cost > 0 ? ((value - cost) / cost) * 100 : 0;
      }
      return {
        success: true,
        portfolio_id: portfolioId,
        assets,
        summary: {
          total_value: totalValue,
          total_cost: totalCost,
          total_gain_loss: totalValue - totalCost,
          total_gain_loss_percent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
          asset_count: assets.length,
        },
      };
    } catch (e) {
      return errorOf(e);
    }
  }

  async getPortfolioDiversification(params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      let portfolioId: any = params?.portfolio_id ?? null;
      if (!portfolioId) portfolioId = (await this.getPortfolioAssetsWithDiscovery({}, userId)).portfolio_id ?? null;
      if (!portfolioId) return { error: 'No portfolio found' };
      const byType = (await sql<any>`SELECT a.type as asset_type,
                        SUM(pa.current_value) as total_value,
                        COUNT(*) as asset_count
                 FROM portfolio_assets pa
                 JOIN assets a ON pa.asset_id = a.id
                 WHERE pa.portfolio_id = ${portfolioId}
                 GROUP BY a.type
                 ORDER BY total_value DESC`.execute(db)).rows;
      const total = byType.reduce((s: number, r: any) => s + num(r.total_value), 0);
      for (const item of byType) item.percentage = total > 0 ? (num(item.total_value) / total) * 100 : 0;
      return { success: true, portfolio_id: portfolioId, by_asset_type: byType, total_value: total };
    } catch (e) {
      return errorOf(e);
    }
  }

  async getAllTransactions(params: any, userId: any): Promise<any> {
    if (!userId) return NO_DB;
    try {
      const page = Math.max(1, intVal(params?.page ?? 1));
      const limit = Math.min(100, Math.max(1, intVal(params?.limit ?? 50)));
      const offset = (page - 1) * limit;
      // PHP: in_array($params['sort'] ?? 'date', [...]) ? $params['sort'] : 'date' — an absent sort
      // passes the check and leaves the column empty, as PHP does.
      const sort = ['date', 'amount', 'type'].includes(params?.sort ?? 'date') ? String(params?.sort ?? '') : 'date';
      const order = String(params?.order ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const transactions = (await sql<any>`SELECT t.*, a.name as asset_name, a.symbol
                 FROM transactions t
                 JOIN assets a ON t.asset_id = a.id
                 JOIN portfolios p ON t.portfolio_id = p.id
                 WHERE p.user_id = ${userId}
                 ORDER BY t.${sql.raw(sort)} ${sql.raw(order)}
                 LIMIT ${limit} OFFSET ${offset}`.execute(db)).rows;
      const c = (await sql<any>`SELECT COUNT(*) AS c FROM transactions t
                 JOIN portfolios p ON t.portfolio_id = p.id
                 WHERE p.user_id = ${userId}`.execute(db)).rows[0];
      const totalCount = intVal(c?.c ?? 0);
      return {
        success: true,
        transactions,
        pagination: { page, limit, total: totalCount, total_pages: Math.ceil(totalCount / limit) },
      };
    } catch (e) {
      return errorOf(e);
    }
  }
}
