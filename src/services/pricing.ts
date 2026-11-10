/** Pure pricing helpers over PackageConfig-shaped data. */
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

/** Follow-up (bigger discount) wins over Premium, which wins over full price. */
export function chooseVariant(opts: { isPremium: boolean; hasPriorOrderWithDietitian: boolean }): PlanVariant {
  if (opts.hasPriorOrderWithDietitian) return 'followUp';
  return opts.isPremium ? 'premium' : 'full';
}

export function findPrice(v: VariantConfig, country: string): PricePoint | null {
  const c = country.toUpperCase();
  return v.prices.find((p) => p.country.toUpperCase() === c) ?? v.prices.find((p) => p.country === '*') ?? null;
}
