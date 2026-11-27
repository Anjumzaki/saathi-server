/** Pure pricing helpers over PackageConfig-shaped data. */
import type { SubStatus } from './entitlement';

export type PlanVariant = 'full' | 'premium' | 'followUp';

export interface PricePoint {
  country: string; // ISO-3166 alpha-2, or "*" fallback
  currency: string;
  amountMinor: number;
}
export interface VariantConfig {
  variant: string;
  productId: string;
  prices: PricePoint[];
}

/**
 * Follow-up (bigger discount) wins over Premium, which wins over full price. The Premium price is a
 * thank-you for paying, so a trial does not get it: pass `status` and a trialing account pays full.
 */
export function chooseVariant(opts: { isPremium: boolean; hasPriorOrderWithDietitian: boolean; status?: SubStatus | null }): PlanVariant {
  if (opts.hasPriorOrderWithDietitian) return 'followUp';
  const discountEarned = opts.isPremium && opts.status !== 'trialing';
  return discountEarned ? 'premium' : 'full';
}

export function findPrice(v: VariantConfig, country: string): PricePoint | null {
  const c = country.toUpperCase();
  return v.prices.find((p) => p.country.toUpperCase() === c) ?? v.prices.find((p) => p.country === '*') ?? null;
}
