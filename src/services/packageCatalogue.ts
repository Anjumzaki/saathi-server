/**
 * The paid packages as the app sees them. The app must never hard-code what a package opens: prices come
 * from the store, everything else comes from here, so a change in PackageConfig reaches every install.
 */
import { getEnv } from '../config/env';
import { PackageConfig } from '../models/PackageConfig';
import { TtlCache } from './configCache';
import { PREMIUM_FEATURES, PLUS_FEATURES, type Feature, type Tier } from './entitlement';
import type { PricePoint } from './pricing';

export type PaidTier = Exclude<Tier, 'free'>;
export type SubVariant = 'monthly' | 'yearly';

export interface PackageVariantView {
  variant: SubVariant;
  /** Both stores, so the app can pick without knowing our naming. */
  productIds: { android: string; ios: string };
  prices: PricePoint[];
}
export interface PackageView {
  key: string;
  tier: PaidTier;
  label: string;
  trialDays: number;
  features: Feature[];
  perks: string[];
  variants: PackageVariantView[];
}

/** Shape of the stored document, loosely typed: these documents are admin-editable. */
interface RawVariant {
  variant?: string;
  productId?: string;
  iosProductId?: string | null;
  prices?: { country?: string; currency?: string; amountMinor?: number }[];
}
interface RawPackage {
  key?: string;
  kind?: string;
  tier?: string | null;
  label?: string;
  trialDays?: number;
  features?: string[];
  perks?: string[];
  active?: boolean;
  sortOrder?: number;
  variants?: RawVariant[];
}

const KNOWN: Feature[] = PLUS_FEATURES;
const isFeature = (f: string): f is Feature => (KNOWN as string[]).includes(f);
/** A package saved before `features` existed still has to open something sensible. */
const defaultFeatures = (tier: PaidTier): Feature[] => (tier === 'plus' ? PLUS_FEATURES : PREMIUM_FEATURES);

function toVariant(v: RawVariant): PackageVariantView | null {
  if ((v.variant !== 'monthly' && v.variant !== 'yearly') || !v.productId) return null;
  return {
    variant: v.variant,
    productIds: { android: v.productId, ios: v.iosProductId ?? v.productId },
    prices: (v.prices ?? [])
      .filter((p): p is { country: string; currency: string; amountMinor: number } => !!p.country && !!p.currency && typeof p.amountMinor === 'number')
      .map((p) => ({ country: p.country, currency: p.currency, amountMinor: p.amountMinor })),
  };
}

/** Pure: the subscription packages from a set of PackageConfig documents, cheapest tier first. */
export function toPackageViews(docs: unknown[]): PackageView[] {
  return (docs as RawPackage[])
    .filter((d) => d.kind === 'premium' && d.active !== false)
    .map((d): PackageView => {
      const tier: PaidTier = d.tier === 'plus' ? 'plus' : 'premium';
      const features = (d.features ?? []).filter(isFeature);
      return {
        key: d.key ?? '',
        tier,
        label: d.label ?? (tier === 'plus' ? 'Saathi Premium Plus' : 'Saathi Premium'),
        trialDays: d.trialDays ?? 0,
        features: features.length ? features : defaultFeatures(tier),
        perks: d.perks ?? [],
        variants: (d.variants ?? []).map(toVariant).filter((v): v is PackageVariantView => !!v),
      };
    })
    .sort((a, b) => (a.tier === b.tier ? a.key.localeCompare(b.key) : a.tier === 'premium' ? -1 : 1));
}

let cache: TtlCache<PackageView[]> | undefined;

export function getPaidPackages(): Promise<PackageView[]> {
  cache ??= new TtlCache<PackageView[]>(
    async () => toPackageViews(await PackageConfig.find({ kind: 'premium', active: true }).sort({ sortOrder: 1 }).lean()),
    getEnv().CONFIG_CACHE_TTL_SECONDS * 1000,
  );
  return cache.get();
}
export const invalidatePaidPackages = () => cache?.invalidate();

/** The tier a store product id belongs to, so a purchase lands on the right package. */
export function tierOfProduct(pkgs: PackageView[], productId: string): { tier: PaidTier; plan: SubVariant } | null {
  for (const p of pkgs) {
    for (const v of p.variants) {
      if (v.productIds.android === productId || v.productIds.ios === productId) return { tier: p.tier, plan: v.variant };
    }
  }
  return null;
}
