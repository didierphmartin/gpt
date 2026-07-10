import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Single source of truth for LLM token pricing: system_llm_settings.
 * resolvePricing() returns [input_per_1m, output_per_1m] or throws.
 * A price of 0 is valid; NULL / missing / query error throws.
 */
export class PricingUnavailableError extends Error {}

export type PriceRow = { price_input_per_1m: unknown; price_output_per_1m: unknown };

const ALIASES: Record<string, string> = { anthropic: 'claude', google: 'gemini' };

/** Pure: a fetched row (or undefined) → rates or throw. DB-free for testing. */
export function classifyRow(row: PriceRow | undefined, key: string): [number, number] {
  if (!row) {
    throw new PricingUnavailableError(`No price configured for provider '${key}' in system_llm_settings`);
  }
  if (row.price_input_per_1m === null || row.price_input_per_1m === undefined ||
      row.price_output_per_1m === null || row.price_output_per_1m === undefined) {
    throw new PricingUnavailableError(
      `Null price for provider '${key}' in system_llm_settings (set price_input_per_1m / price_output_per_1m)`,
    );
  }
  return [Number(row.price_input_per_1m), Number(row.price_output_per_1m)];
}

/** DB-backed lookup by provider_key (aliased). Throws PricingUnavailableError when unavailable. */
export async function resolvePricing(provider: string): Promise<[number, number]> {
  const p = provider.toLowerCase();
  const key = ALIASES[p] ?? p;
  let row: PriceRow | undefined;
  try {
    row = (
      await sql<PriceRow>`SELECT price_input_per_1m, price_output_per_1m
        FROM system_llm_settings WHERE provider_key = ${key} LIMIT 1`.execute(db)
    ).rows[0];
  } catch (e: any) {
    throw new PricingUnavailableError(
      `Pricing lookup failed for provider '${key}' in system_llm_settings: ${e?.message ?? e}`,
    );
  }
  return classifyRow(row, key);
}
