/** Pure subscription entitlement logic. */
export type SubStatus = 'none' | 'trialing' | 'active' | 'expired' | 'canceled';
export type PurchaseSource = 'google_play' | 'app_store';
export type SubPlan = 'monthly' | 'yearly';

export interface Entitlement {
  status: SubStatus;
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

export interface PlayVerification {
  valid: boolean;
  productId?: string | undefined;
  orderId?: string | undefined;
  expiresAt?: Date | undefined;
  isTrial?: boolean | undefined;
  autoRenewing?: boolean | undefined;
}

export function entitlementFromPlay(v: PlayVerification, plan: SubPlan, now: Date, source: PurchaseSource = 'google_play'): Entitlement {
  if (!v.valid || !v.expiresAt || v.expiresAt.getTime() <= now.getTime()) {
    return { status: 'expired', plan, expiresAt: v.expiresAt ?? null, source };
  }
  if (v.isTrial) return { status: 'trialing', plan, trialEndsAt: v.expiresAt, expiresAt: v.expiresAt, source };
  return { status: v.autoRenewing === false ? 'canceled' : 'active', plan, expiresAt: v.expiresAt, source };
}
