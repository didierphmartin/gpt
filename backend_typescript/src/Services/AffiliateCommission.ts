/**
 * Mirrors src/Services/AffiliateCommission.php — pure commission math for
 * affiliate sales. No DB access.
 */

// PHP round($v, $precision) — half away from zero, with a pre-round to ~15 sig
// digits to cancel float representation error (copied from AdminController.ts).
function phpRound(value: number, precision: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, precision);
  const scaled = parseFloat((value * f).toPrecision(15));
  return (scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)) / f;
}

// PHP (float) cast: parse leading numeric, else 0.
function phpFloatval(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const m = String(v).match(/^[ \t\n\r\v\f]*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/);
  return m ? parseFloat(m[0]) : 0;
}

export class AffiliateCommission {
  /**
   * Compute the commission for a single sale.
   *
   * @param type   'percent' or 'fixed'
   * @param value  percent (e.g. 20.0) or fixed amount
   * @param sale   the amount the prospect paid
   * @returns commission rounded to 2 decimals, never negative
   */
  static compute(type: string, value: number, sale: number): number {
    if (sale < 0) {
      sale = 0.0;
    }
    switch (type) {
      case 'percent':
        return phpRound((sale * value) / 100, 2);
      case 'fixed':
        return phpRound(Math.max(0.0, value), 2);
      default:
        throw new Error(`Unknown commission type: ${type}`);
    }
  }

  /**
   * Resolve the effective (type, value): account override wins when both of its
   * fields are non-null, otherwise the product default is used.
   */
  static resolve(
    account: Record<string, any>,
    product: Record<string, any>
  ): [string, number] {
    const type = account['commission_type'] ?? null;
    const value = account['commission_value'] ?? null;
    if (type !== null && value !== null) {
      return [String(type), phpFloatval(value)];
    }
    return [String(product['commission_type']), phpFloatval(product['commission_value'])];
  }
}
