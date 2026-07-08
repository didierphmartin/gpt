import { sql, Kysely, Transaction } from 'kysely';
import { db } from '../db/pools';
import { DB } from '../db/types';

/**
 * Mirrors src/Services/AffiliateRepository.php — all affiliate-related data
 * access + earnings aggregation. Controllers call this; it never decides HTTP
 * status. Commission math lives in AffiliateCommission; link/key helpers in
 * AffiliateSupport.
 *
 * Notes on type parity (PDO ATTR_EMULATE_PREPARES=false vs mysql2):
 *  - INT columns come back as JS numbers (matching PDO native ints).
 *  - DECIMAL columns and SUM(DECIMAL) aggregates come back as strings from both
 *    mysql2 and PDO — passed through untouched (never float-cast). The affiliate
 *    tables have no JSON columns, so no CAST-AS-CHAR is needed.
 *  - keyExists/insertAffiliate accept an optional executor so adminCreate can run
 *    them inside a transaction (mirrors PHP's shared-PDO beginTransaction).
 */

type Executor = Kysely<DB> | Transaction<DB>;

export class AffiliateRepository {
  // ---- Affiliates -------------------------------------------------------

  /** List affiliates with total earned + owed (pending). */
  async listAffiliates(): Promise<Record<string, any>[]> {
    return (
      await sql<any>`
        SELECT a.id, a.user_id, a.name, a.email, a.affiliate_key, a.status, a.created_at,
               COALESCE(SUM(s.commission_amount), 0) AS total_earned,
               COALESCE(SUM(CASE WHEN s.status='pending' THEN s.commission_amount ELSE 0 END), 0) AS owed,
               COUNT(DISTINCT acc.id) AS product_count
        FROM affiliates a
        LEFT JOIN affiliate_sales s    ON s.affiliate_id = a.id
        LEFT JOIN affiliate_accounts acc ON acc.affiliate_id = a.id
        GROUP BY a.id
        ORDER BY a.created_at DESC
      `.execute(db)
    ).rows;
  }

  async findAffiliate(id: number): Promise<Record<string, any> | null> {
    const row = (
      await sql<any>`SELECT * FROM affiliates WHERE id = ${id} LIMIT 1`.execute(db)
    ).rows[0];
    return row ?? null;
  }

  async findAffiliateByUserId(userId: number): Promise<Record<string, any> | null> {
    const row = (
      await sql<any>`SELECT * FROM affiliates WHERE user_id = ${userId} LIMIT 1`.execute(db)
    ).rows[0];
    return row ?? null;
  }

  async findAffiliateByKey(key: string): Promise<Record<string, any> | null> {
    const row = (
      await sql<any>`SELECT * FROM affiliates WHERE affiliate_key = ${key} LIMIT 1`.execute(db)
    ).rows[0];
    return row ?? null;
  }

  async keyExists(key: string, exec: Executor = db): Promise<boolean> {
    const row = (
      await sql<any>`SELECT 1 AS ok FROM affiliates WHERE affiliate_key = ${key} LIMIT 1`.execute(exec)
    ).rows[0];
    return !!row;
  }

  /** Insert an affiliate row. Returns new id. */
  async insertAffiliate(
    userId: number,
    name: string,
    email: string,
    key: string,
    exec: Executor = db
  ): Promise<number> {
    const res = await sql`
      INSERT INTO affiliates (user_id, name, email, affiliate_key)
      VALUES (${userId}, ${name}, ${email}, ${key})
    `.execute(exec);
    return Number((res as any).insertId ?? 0);
  }

  // ---- Products ---------------------------------------------------------

  async listProducts(): Promise<Record<string, any>[]> {
    return (
      await sql<any>`SELECT * FROM affiliate_products ORDER BY name ASC`.execute(db)
    ).rows;
  }

  async findProduct(id: number): Promise<Record<string, any> | null> {
    const row = (
      await sql<any>`SELECT * FROM affiliate_products WHERE id = ${id} LIMIT 1`.execute(db)
    ).rows[0];
    return row ?? null;
  }

  async insertProduct(p: Record<string, any>): Promise<number> {
    const res = await sql`
      INSERT INTO affiliate_products (name, app_ref, sales_page_url, commission_type, commission_value, currency, active)
      VALUES (${p['name']}, ${p['app_ref']}, ${p['sales_page_url']}, ${p['commission_type']}, ${p['commission_value']}, ${p['currency']}, ${p['active']})
    `.execute(db);
    return Number((res as any).insertId ?? 0);
  }

  async updateProduct(id: number, p: Record<string, any>): Promise<void> {
    await sql`
      UPDATE affiliate_products
      SET name=${p['name']}, app_ref=${p['app_ref']}, sales_page_url=${p['sales_page_url']}, commission_type=${p['commission_type']},
          commission_value=${p['commission_value']}, currency=${p['currency']}, active=${p['active']}
      WHERE id=${id}
    `.execute(db);
  }

  async deleteProduct(id: number): Promise<number> {
    const res = await sql`DELETE FROM affiliate_products WHERE id = ${id}`.execute(db);
    return Number(res.numAffectedRows ?? 0);
  }

  // ---- Accounts ---------------------------------------------------------

  /** Product accounts for an affiliate, joined to product + per-product earnings. */
  async accountsForAffiliate(affiliateId: number): Promise<Record<string, any>[]> {
    return (
      await sql<any>`
        SELECT acc.id AS account_id, acc.affiliate_id, acc.product_id,
               acc.commission_type AS override_type, acc.commission_value AS override_value,
               p.name AS product_name, p.sales_page_url, p.currency,
               p.commission_type AS product_type, p.commission_value AS product_value,
               af.affiliate_key,
               COALESCE(SUM(s.commission_amount), 0) AS earnings,
               COALESCE(SUM(CASE WHEN s.status='pending' THEN s.commission_amount ELSE 0 END), 0) AS owed
        FROM affiliate_accounts acc
        JOIN affiliate_products p ON p.id = acc.product_id
        JOIN affiliates af ON af.id = acc.affiliate_id
        LEFT JOIN affiliate_sales s
               ON s.affiliate_id = acc.affiliate_id AND s.product_id = acc.product_id
        WHERE acc.affiliate_id = ${affiliateId}
        GROUP BY acc.id
        ORDER BY p.name ASC
      `.execute(db)
    ).rows;
  }

  async findAccount(affiliateId: number, productId: number): Promise<Record<string, any> | null> {
    const row = (
      await sql<any>`SELECT * FROM affiliate_accounts WHERE affiliate_id = ${affiliateId} AND product_id = ${productId} LIMIT 1`.execute(
        db
      )
    ).rows[0];
    return row ?? null;
  }

  async insertAccount(
    affiliateId: number,
    productId: number,
    type: string | null,
    value: number | null
  ): Promise<number> {
    const res = await sql`
      INSERT INTO affiliate_accounts (affiliate_id, product_id, commission_type, commission_value)
      VALUES (${affiliateId}, ${productId}, ${type}, ${value})
    `.execute(db);
    return Number((res as any).insertId ?? 0);
  }

  async deleteAccount(affiliateId: number, productId: number): Promise<number> {
    const res = await sql`
      DELETE FROM affiliate_accounts WHERE affiliate_id = ${affiliateId} AND product_id = ${productId}
    `.execute(db);
    return Number(res.numAffectedRows ?? 0);
  }

  /** Set (or clear, with null/null) the per-account commission override. */
  async updateAccount(
    affiliateId: number,
    productId: number,
    type: string | null,
    value: number | null
  ): Promise<number> {
    const res = await sql`
      UPDATE affiliate_accounts SET commission_type = ${type}, commission_value = ${value}
      WHERE affiliate_id = ${affiliateId} AND product_id = ${productId}
    `.execute(db);
    return Number(res.numAffectedRows ?? 0);
  }

  // ---- Sales ------------------------------------------------------------

  async transactionsForAffiliate(affiliateId: number): Promise<Record<string, any>[]> {
    return (
      await sql<any>`
        SELECT s.id, s.product_id, p.name AS product_name, s.sale_amount, s.currency,
               s.commission_amount, s.status, s.external_ref, s.occurred_at, s.paid_at
        FROM affiliate_sales s
        JOIN affiliate_products p ON p.id = s.product_id
        WHERE s.affiliate_id = ${affiliateId}
        ORDER BY s.occurred_at DESC
      `.execute(db)
    ).rows;
  }

  async insertSale(
    affiliateId: number,
    productId: number,
    sale: number,
    currency: string,
    commission: number,
    externalRef: string | null
  ): Promise<number> {
    const res = await sql`
      INSERT INTO affiliate_sales (affiliate_id, product_id, sale_amount, currency, commission_amount, external_ref)
      VALUES (${affiliateId}, ${productId}, ${sale}, ${currency}, ${commission}, ${externalRef})
    `.execute(db);
    return Number((res as any).insertId ?? 0);
  }

  async saleByExternalRef(ref: string): Promise<Record<string, any> | null> {
    const row = (
      await sql<any>`SELECT * FROM affiliate_sales WHERE external_ref = ${ref} LIMIT 1`.execute(db)
    ).rows[0];
    return row ?? null;
  }

  async markSalePaid(affiliateId: number, saleId: number): Promise<number> {
    const res = await sql`
      UPDATE affiliate_sales SET status='paid', paid_at=NOW()
      WHERE id = ${saleId} AND affiliate_id = ${affiliateId} AND status='pending'
    `.execute(db);
    return Number(res.numAffectedRows ?? 0);
  }
}
