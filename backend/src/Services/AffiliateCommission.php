<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use InvalidArgumentException;

/**
 * Pure commission math for affiliate sales. No DB access — fully unit-tested.
 */
final class AffiliateCommission
{
    /**
     * Compute the commission for a single sale.
     *
     * @param string $type   'percent' or 'fixed'
     * @param float  $value  percent (e.g. 20.0) or fixed amount
     * @param float  $sale   the amount the prospect paid
     * @return float commission rounded to 2 decimals, never negative
     */
    public static function compute(string $type, float $value, float $sale): float
    {
        if ($sale < 0) {
            $sale = 0.0;
        }
        switch ($type) {
            case 'percent':
                return round($sale * $value / 100, 2);
            case 'fixed':
                return round(max(0.0, $value), 2);
            default:
                throw new InvalidArgumentException("Unknown commission type: {$type}");
        }
    }

    /**
     * Resolve the effective (type, value): account override wins when both of
     * its fields are non-null, otherwise the product default is used.
     *
     * @return array{0:string,1:float}
     */
    public static function resolve(array $account, array $product): array
    {
        $type  = $account['commission_type'] ?? null;
        $value = $account['commission_value'] ?? null;
        if ($type !== null && $value !== null) {
            return [(string) $type, (float) $value];
        }
        return [(string) $product['commission_type'], (float) $product['commission_value']];
    }
}
