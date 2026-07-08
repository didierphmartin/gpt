import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { AffiliateRepository } from '../Services/AffiliateRepository';
import { AffiliateCommission } from '../Services/AffiliateCommission';
import { AffiliateSupport } from '../Services/AffiliateSupport';

/**
 * Mirrors src/Controllers/AffiliateController.php — affiliate management.
 *
 * Admin (existing admin JWT):      /api/v1/admin/affiliates*, /api/v1/admin/affiliate-products*
 * Affiliate self-scope (role=affiliate): /api/v1/affiliate/me, /api/v1/affiliate/me/transactions
 * Conversion (any authenticated caller / selling app): POST /api/v1/affiliate/conversions
 *
 * Faithful-mirror notes:
 *  - Responses use the standard handle() (res.json), like every other controller. PHP's
 *    json_encode emits escaped slashes / \u-escaped unicode / serialize_precision=100 float
 *    expansion, but the frontend consumes responses via .json() which normalizes all of that
 *    away, so parse-equality is the fidelity bar (verified against live PHP). Computed floats
 *    (commission_amount, effective_value, totals) and DECIMAL-column strings both round-trip
 *    identically once parsed.
 *  - PHP password_hash($pw, PASSWORD_DEFAULT) = bcrypt cost 10 -> bcrypt.hashSync.
 *  - Route params (:id/:productId/:saleId) arrive on ctx.params as strings; the
 *    PHP router casts them to int, so we Number() them.
 *  - Runtime DDL (ensure*Exists) is skipped per convention.
 */

// PHP trim() default character mask (" \t\n\r\0\x0B").
function phpTrim(v: any): string {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  return s.replace(/^[ \t\n\r\0\x0B]+/, '').replace(/[ \t\n\r\0\x0B]+$/, '');
}

// PHP (int) cast semantics (truncating; bool->1/0; leading-numeric, else 0).
function phpIntVal(v: any): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

// PHP (float) cast: parse leading numeric, else 0.
function phpFloatval(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const m = String(v).match(/^[ \t\n\r\v\f]*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/);
  return m ? parseFloat(m[0]) : 0;
}

// PHP (string) cast (bool->"1"/""; null->""; number->decimal string).
function phpStrVal(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '';
  return String(v);
}

// PHP empty(): true for null/undefined, false, 0, 0.0, '', '0', [].
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === '' || v === '0') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// PHP `$x ?: $y` for strings: $x truthy unless '' or '0'.
function phpElvisStr(x: string, fallback: string): string {
  return x !== '' && x !== '0' ? x : fallback;
}

// PHP strtoupper() in the live server's C locale — ASCII a-z only.
function phpStrtoupper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

// PHP round($v, 2) — half away from zero, pre-rounded to ~15 sig digits.
function phpRound(value: number, precision: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, precision);
  const scaled = parseFloat((value * f).toPrecision(15));
  return (scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)) / f;
}

export class AffiliateController {
  private repo = new AffiliateRepository();

  // ===== Admin: affiliates ==============================================

  async adminList(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    return { success: true, affiliates: await this.repo.listAffiliates() };
  }

  async adminGet(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    const affiliate = await this.repo.findAffiliate(id);
    if (!affiliate) return this.notFound('Affiliate');
    return {
      success: true,
      affiliate,
      accounts: this.decorateAccounts(await this.repo.accountsForAffiliate(id)),
    };
  }

  async adminCreate(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const body = ctx.body ?? {};
    const name = phpTrim(body['name'] ?? '');
    const email = phpTrim(body['email'] ?? '');
    const password = phpStrVal(body['password'] ?? '');
    if (name === '' || email === '') {
      return this.badRequest('name and email are required');
    }

    // Is this email already a registered user (client, prospect, affiliate…)?
    // Affiliate status lives in the `affiliates` table, independent of the
    // user's role — so an existing user just needs an affiliate row added,
    // not a brand-new account.
    const existingRow = (
      await sql<any>`SELECT id FROM users WHERE email = ${email} LIMIT 1`.execute(db)
    ).rows[0];
    const isExisting = existingRow !== undefined;

    if (isExisting) {
      if (await this.repo.findAffiliateByUserId(Number(existingRow.id))) {
        return this.badRequest('This user is already an affiliate');
      }
    } else if (password === '') {
      // Only a brand-new person needs a login provisioned, so the
      // password is required only in that case.
      return this.badRequest('password is required to register a new affiliate user');
    }

    // Provision the auth user only if new, then the affiliate row, atomically.
    let affiliateId: number;
    let key: string;
    try {
      const out = await db.transaction().execute(async (trx) => {
        let userId: number;
        if (isExisting) {
          userId = Number(existingRow.id);
        } else {
          const res = await sql`
            INSERT INTO users (email, password, first_name, role, provider, created_at, updated_at)
            VALUES (${email}, ${bcrypt.hashSync(password, 10)}, ${name}, 'affiliate', 'email', NOW(), NOW())
          `.execute(trx);
          userId = Number((res as any).insertId ?? 0);
        }

        let k: string;
        do {
          k = AffiliateSupport.generateKey();
        } while (await this.repo.keyExists(k, trx));
        const aid = await this.repo.insertAffiliate(userId, name, email, k, trx);
        return { aid, k };
      });
      affiliateId = out.aid;
      key = out.k;
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (msg.includes('Duplicate') || msg.includes('1062')) {
        return this.badRequest('A user with that email already exists');
      }
      throw e;
    }

    return {
      success: true,
      affiliate_id: affiliateId,
      affiliate_key: key,
      existing_user: isExisting,
    };
  }

  async adminDelete(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    const affiliate = await this.repo.findAffiliate(id);
    if (!affiliate) return this.notFound('Affiliate');
    const userId = phpIntVal(affiliate['user_id']);

    // Always remove the affiliate row (cascades to its accounts + sales via the
    // affiliate-internal FKs). There is no FK from affiliates.user_id to users
    // (id types differ), so the user row is handled separately below.
    await sql`DELETE FROM affiliates WHERE id = ${id}`.execute(db);

    // Remove the auth login ONLY if the account exists solely for affiliate use
    // (role = 'affiliate'). A shared account that is also a client or prospect
    // keeps its login so we don't destroy their other access/data.
    const roleRow = (
      await sql<any>`SELECT role FROM users WHERE id = ${userId} LIMIT 1`.execute(db)
    ).rows[0];
    if (roleRow && roleRow.role === 'affiliate') {
      await sql`DELETE FROM users WHERE id = ${userId}`.execute(db);
    }
    return { success: true };
  }

  // ===== Admin: accounts ================================================

  async adminAddAccount(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    if (!(await this.repo.findAffiliate(id))) return this.notFound('Affiliate');
    const body = ctx.body ?? {};
    const productId = phpIntVal(body['product_id'] ?? 0);
    if (!(await this.repo.findProduct(productId))) return this.badRequest('Unknown product');
    if (await this.repo.findAccount(id, productId)) return this.badRequest('Account already exists');

    const [type, value] = this.readOptionalOverride(body);
    await this.repo.insertAccount(id, productId, type, value);
    return { success: true };
  }

  async adminUpdateAccount(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    const productId = Number(ctx.params.productId);
    if (!(await this.repo.findAffiliate(id))) return this.notFound('Affiliate');
    if (!(await this.repo.findAccount(id, productId))) return this.notFound('Account');

    // Empty/missing override clears it (account then inherits the product default).
    const [type, value] = this.readOptionalOverride(ctx.body ?? {});
    await this.repo.updateAccount(id, productId, type, value);
    return { success: true };
  }

  async adminDeleteAccount(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    const productId = Number(ctx.params.productId);
    await this.repo.deleteAccount(id, productId);
    return { success: true };
  }

  // ===== Admin: transactions ============================================

  async adminTransactions(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    if (!(await this.repo.findAffiliate(id))) return this.notFound('Affiliate');
    return this.transactionsPayload(id);
  }

  async adminMarkPaid(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    const saleId = Number(ctx.params.saleId);
    const updated = await this.repo.markSalePaid(id, saleId);
    return { success: true, updated };
  }

  // ===== Admin: products ================================================

  async adminListProducts(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    return { success: true, products: await this.repo.listProducts() };
  }

  async adminCreateProduct(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const p = this.validateProduct(ctx.body ?? {});
    if ((p as any).error !== undefined) return p as ControllerResult;
    const pid = await this.repo.insertProduct(p);
    return { success: true, product_id: pid };
  }

  async adminUpdateProduct(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    if (!(await this.repo.findProduct(id))) return this.notFound('Product');
    const p = this.validateProduct(ctx.body ?? {});
    if ((p as any).error !== undefined) return p as ControllerResult;
    await this.repo.updateProduct(id, p);
    return { success: true };
  }

  async adminDeleteProduct(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const id = Number(ctx.params.id);
    await this.repo.deleteProduct(id);
    return { success: true };
  }

  // ===== Affiliate self-scope ===========================================

  async me(ctx: Ctx): Promise<ControllerResult> {
    const affiliate = await this.requireAffiliate(ctx);
    if ((affiliate as any).error !== undefined) return affiliate as ControllerResult;
    return {
      success: true,
      affiliate: {
        id: affiliate['id'],
        name: affiliate['name'],
        email: affiliate['email'],
        affiliate_key: affiliate['affiliate_key'],
        status: affiliate['status'],
      },
      accounts: this.decorateAccounts(await this.repo.accountsForAffiliate(phpIntVal(affiliate['id']))),
    };
  }

  async myTransactions(ctx: Ctx): Promise<ControllerResult> {
    const affiliate = await this.requireAffiliate(ctx);
    if ((affiliate as any).error !== undefined) return affiliate as ControllerResult;
    return this.transactionsPayload(phpIntVal(affiliate['id']));
  }

  // ===== Conversion (selling apps) ======================================

  async recordConversion(ctx: Ctx): Promise<ControllerResult> {
    if (!(ctx.user_id ?? null)) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    const body = ctx.body ?? {};
    const ref = phpTrim(phpStrVal(body['ref'] ?? ''));
    const productId = phpIntVal(body['product'] ?? 0);
    const amount = phpFloatval(body['amount'] ?? 0);
    const currency = phpElvisStr(phpStrtoupper(phpTrim(phpStrVal(body['currency'] ?? 'USD'))), 'USD');
    let externalRef: string | null =
      body['external_ref'] !== undefined ? phpTrim(phpStrVal(body['external_ref'])) : null;
    if (externalRef === '') externalRef = null;

    if (ref === '' || productId <= 0 || amount <= 0) {
      return this.badRequest('ref, product and a positive amount are required');
    }

    // Idempotency: if this external_ref was already recorded, return it.
    if (externalRef !== null) {
      const existing = await this.repo.saleByExternalRef(externalRef);
      if (existing) {
        return { success: true, sale_id: phpIntVal(existing['id']), duplicate: true };
      }
    }

    const affiliate = await this.repo.findAffiliateByKey(ref);
    if (!affiliate) return this.badRequest('Unknown affiliate ref');
    const product = await this.repo.findProduct(productId);
    if (!product) return this.badRequest('Unknown product');
    const account = await this.repo.findAccount(phpIntVal(affiliate['id']), productId);
    if (!account) return this.badRequest('Affiliate has no account on this product');

    const [type, value] = AffiliateCommission.resolve(account, product);
    const commission = AffiliateCommission.compute(type, value, amount);
    let saleId: number;
    try {
      saleId = await this.repo.insertSale(
        phpIntVal(affiliate['id']),
        productId,
        amount,
        currency,
        commission,
        externalRef
      );
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (externalRef !== null && (msg.includes('Duplicate') || msg.includes('1062'))) {
        const existing = await this.repo.saleByExternalRef(externalRef);
        if (existing) {
          return { success: true, sale_id: phpIntVal(existing['id']), duplicate: true };
        }
      }
      throw e;
    }

    return { success: true, sale_id: saleId, commission_amount: commission };
  }

  // ===== Helpers ========================================================

  private async transactionsPayload(affiliateId: number): Promise<ControllerResult> {
    const rows = await this.repo.transactionsForAffiliate(affiliateId);
    let paid = 0.0;
    let owed = 0.0;
    for (const r of rows) {
      if (r['status'] === 'paid') paid += phpFloatval(r['commission_amount']);
      else owed += phpFloatval(r['commission_amount']);
    }
    return {
      success: true,
      transactions: rows,
      totals: {
        paid: phpRound(paid, 2),
        owed: phpRound(owed, 2),
        total: phpRound(paid + owed, 2),
      },
    };
  }

  /** Add effective commission + generated link to each account row. */
  private decorateAccounts(accounts: Record<string, any>[]): Record<string, any>[] {
    for (const a of accounts) {
      const [type, value] = AffiliateCommission.resolve(
        { commission_type: a['override_type'], commission_value: a['override_value'] },
        { commission_type: a['product_type'], commission_value: a['product_value'] }
      );
      a['effective_type'] = type;
      a['effective_value'] = value;
      a['link'] =
        a['affiliate_key'] !== undefined && a['affiliate_key'] !== null
          ? AffiliateSupport.buildLink(a['sales_page_url'], a['affiliate_key'])
          : null;
    }
    return accounts;
  }

  private readOptionalOverride(body: Record<string, any>): [string | null, number | null] {
    const type = body['commission_type'] ?? null;
    const value = body['commission_value'] ?? null;
    if (type === '' || type === null || value === '' || value === null) {
      return [null, null];
    }
    if (type !== 'percent' && type !== 'fixed') return [null, null];
    return [String(type), phpFloatval(value)];
  }

  private validateProduct(body: Record<string, any>): Record<string, any> {
    const name = phpTrim(body['name'] ?? '');
    const url = phpTrim(body['sales_page_url'] ?? '');
    const type = body['commission_type'] ?? 'percent';
    if (name === '' || url === '') return this.badRequest('name and sales_page_url are required');
    if (type !== 'percent' && type !== 'fixed')
      return this.badRequest('commission_type must be percent or fixed');
    const appRef = phpTrim(body['app_ref'] ?? '');
    return {
      name,
      app_ref: appRef !== '' && appRef !== '0' ? appRef : null,
      sales_page_url: url,
      commission_type: type,
      commission_value: phpFloatval(body['commission_value'] ?? 0),
      currency: phpElvisStr(phpStrtoupper(phpTrim(body['currency'] ?? 'USD')), 'USD'),
      active: !phpEmpty(body['active']) ? 1 : 0,
    };
  }

  private async requireAdmin(ctx: Ctx): Promise<ControllerResult | null> {
    const userId = ctx.user_id ?? null;
    if (!userId) return { success: false, error: 'Authentication required', status_code: 401 };
    const user = (
      await sql<any>`SELECT role FROM users WHERE id = ${userId} LIMIT 1`.execute(db)
    ).rows[0];
    if (!user || (user['role'] ?? '') !== 'admin') {
      return { success: false, error: 'Admin access required', status_code: 403 };
    }
    return null;
  }

  /** Returns the affiliate row for the authenticated user, or an error array. */
  private async requireAffiliate(ctx: Ctx): Promise<Record<string, any>> {
    const userId = ctx.user_id ?? null;
    if (!userId)
      return { error: true, success: false, message: 'Authentication required', status_code: 401 };
    const affiliate = await this.repo.findAffiliateByUserId(phpIntVal(userId));
    if (!affiliate)
      return { error: true, success: false, message: 'Affiliate access required', status_code: 403 };
    return affiliate;
  }

  private notFound(what: string): ControllerResult {
    return { success: false, error: `${what} not found`, status_code: 404 };
  }

  private badRequest(msg: string): ControllerResult {
    return { success: false, error: msg, status_code: 400 };
  }
}
