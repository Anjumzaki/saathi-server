/** Pure subscription entitlement logic: what tier she is on and which features that opens. */
export type SubStatus = 'none' | 'trialing' | 'active' | 'expired' | 'canceled';
export type PurchaseSource = 'google_play' | 'app_store';
export type SubPlan = 'monthly' | 'yearly';
export type Tier = 'free' | 'premium' | 'plus';
export const PAID_TIERS = ['premium', 'plus'] as const;

export type Feature =
  | 'plan_read_ai'
  | 'plan_generate_ai'
  | 'guided_routines'
  | 'local_produce'
  | 'partner_view'
  | 'dietitian_discount'
  | 'representative_help'
  | 'saathi_plan_request'
  | 'merchant_discount'
  | 'watch_access';

/** Premium. Everything core (reminders, Today, building a plan, progress, BMI, recipes) stays free. */
export const PREMIUM_FEATURES: Feature[] = [
  'plan_read_ai',
  'plan_generate_ai',
  'guided_routines',
  'local_produce',
  'partner_view',
  'dietitian_discount',
  'merchant_discount',
  'watch_access',
];

/** Premium Plus adds chat and calls with Saathi's own dietitians. */
export const PLUS_ONLY_FEATURES: Feature[] = ['representative_help', 'saathi_plan_request'];
export const PLUS_FEATURES: Feature[] = [...PREMIUM_FEATURES, ...PLUS_ONLY_FEATURES];

export const TIER_FEATURES: Record<Tier, Feature[]> = { free: [], premium: PREMIUM_FEATURES, plus: PLUS_FEATURES };

/**
 * Discounts are a thank-you for paying, not part of the trial: they need a period that has actually
 * been charged ("active", or "canceled" while the paid period runs), never "trialing".
 */
export const PAID_ONLY_FEATURES: Feature[] = ['dietitian_discount', 'merchant_discount'];

export interface Entitlement {
  status: SubStatus;
  tier?: Tier | null | undefined;
  plan?: SubPlan | null | undefined;
  trialEndsAt?: Date | null | undefined;
  expiresAt?: Date | null | undefined;
  source?: PurchaseSource | null | undefined;
}

export function isPremiumActive(e: Entitlement | null | undefined, now: Date): boolean {
  if (!e) return false;
  if (e.status === 'trialing') {
    const end = e.trialEndsAt ?? e.expiresAt;
    return !!end && end.getTime() > now.getTime();
  }
  // "canceled" = auto-renew off but paid period still running
  if (e.status === 'active' || e.status === 'canceled') return !!e.expiresAt && e.expiresAt.getTime() > now.getTime();
  return false;
}

/** Status as it should be reported now (lapses to expired when the period has passed). */
export function effectiveStatus(e: Entitlement | null | undefined, now: Date): SubStatus {
  if (!e || e.status === 'none') return 'none';
  return isPremiumActive(e, now) ? e.status : 'expired';
}

/** The tier she is actually on now. Records written before tiers existed are Premium. */
export function tierOf(e: Entitlement | null | undefined, now: Date): Tier {
  if (!isPremiumActive(e, now)) return 'free';
  return e?.tier === 'plus' ? 'plus' : 'premium';
}

/** Features a tier opens at this status, with the trial exclusion applied. */
export function featuresFor(tier: Tier, status: SubStatus): Feature[] {
  const all = TIER_FEATURES[tier];
  return status === 'trialing' ? all.filter((f) => !PAID_ONLY_FEATURES.includes(f)) : all;
}

export function hasFeature(e: Entitlement | null | undefined, feature: Feature, now: Date): boolean {
  const tier = tierOf(e, now);
  return featuresFor(tier, effectiveStatus(e, now)).includes(feature);
}

/** The tier she must reach for a feature; null when no tier opens it. */
export function tierNeededFor(feature: Feature): Tier | null {
  if (PREMIUM_FEATURES.includes(feature)) return 'premium';
  if (PLUS_ONLY_FEATURES.includes(feature)) return 'plus';
  return null;
}

export interface ResolvedEntitlement {
  tier: Tier;
  status: SubStatus;
  plan: SubPlan | null;
  features: Feature[];
  expiresAt: Date | null;
  trialEndsAt: Date | null;
}

/** Everything the app needs in one shape: what GET /subscription reports. */
export function resolveEntitlement(e: Entitlement | null | undefined, now: Date): ResolvedEntitlement {
  const status = effectiveStatus(e, now);
  const tier = tierOf(e, now);
  return {
    tier,
    status,
    plan: e?.plan ?? null,
    features: featuresFor(tier, status),
    expiresAt: e?.expiresAt ?? null,
    trialEndsAt: e?.trialEndsAt ?? null,
  };
}

export interface PlayVerification {
  valid: boolean;
  productId?: string | undefined;
  orderId?: string | undefined;
  expiresAt?: Date | undefined;
  isTrial?: boolean | undefined;
  autoRenewing?: boolean | undefined;
}

export function entitlementFromPlay(
  v: PlayVerification,
  plan: SubPlan,
  now: Date,
  source: PurchaseSource = 'google_play',
  tier: Exclude<Tier, 'free'> = 'premium',
): Entitlement {
  if (!v.valid || !v.expiresAt || v.expiresAt.getTime() <= now.getTime()) {
    return { status: 'expired', tier, plan, expiresAt: v.expiresAt ?? null, source };
  }
  if (v.isTrial) return { status: 'trialing', tier, plan, trialEndsAt: v.expiresAt, expiresAt: v.expiresAt, source };
  return { status: v.autoRenewing === false ? 'canceled' : 'active', tier, plan, expiresAt: v.expiresAt, source };
}
