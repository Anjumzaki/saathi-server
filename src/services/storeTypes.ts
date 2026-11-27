/**
 * The shapes the two store clients share, and the one place that says what "the store said" means.
 *
 * `PlayVerification` (in entitlement.ts) is what the routes already store an entitlement from, so it stays
 * the base: everything added here is optional, which keeps the development stubs valid and lets the real
 * clients report the rest of the truth — whether the purchase was acknowledged, whether she is in a grace
 * period, and which purchase an upgrade replaced.
 */
import type { PlayVerification } from './entitlement';

/** Which store, named the way the User.subscription.source enum already names it. */
export type StoreProvider = 'google_play' | 'app_store';

/** Apple sells the same product in two worlds. A sandbox receipt must never open a production account. */
export type StoreEnvironment = 'production' | 'sandbox';

/**
 * What the store says about the purchase now, flattened to the few states that change what she can do.
 * `in_grace` and `on_hold` are both "payment failed": in a grace period she keeps Premium while Google or
 * Apple retries the card, on hold she does not.
 */
export type StorePurchaseState =
  | 'active'
  | 'in_grace'
  | 'on_hold'
  | 'paused'
  | 'canceled'
  | 'expired'
  | 'revoked'
  | 'pending'
  | 'unknown';

/** Why a purchase was refused. Only `payment` is worth buzzing her about; the rest are our problem or a forgery. */
export type StoreInvalidReason =
  /** The card failed or the purchase is on hold. */
  | 'payment'
  /** The store has never heard of this token. A forged or recycled token lands here. */
  | 'not_found'
  /** A sandbox purchase sent to a production server, or the wrong app's bundle id. */
  | 'environment'
  /** Refunded, revoked or charged back. */
  | 'revoked'
  /** No credentials configured, or the store could not be reached: we do not know, so we do not grant. */
  | 'unverified';

/**
 * A verified purchase. The base fields are what `entitlementFromPlay` reads; the rest is reported so a
 * route can acknowledge, follow an upgrade, or notice a payment problem.
 */
export interface StoreVerification extends PlayVerification {
  invalidReason?: StoreInvalidReason | undefined;
  state?: StorePurchaseState | undefined;
  /** False means Google is still waiting to be told we have honoured the purchase (it refunds after three days). */
  acknowledged?: boolean | undefined;
  /** Play, on an upgrade or downgrade: the token of the subscription this one replaces. */
  linkedPurchaseToken?: string | null | undefined;
  /** Apple: the identity that survives every renewal. */
  originalTransactionId?: string | null | undefined;
  environment?: StoreEnvironment | undefined;
  /** Set when she has turned auto-renew off but the paid period is still running. */
  canceledAt?: Date | null | undefined;
  /** True while the store is retrying the card and she still has access. */
  inGracePeriod?: boolean | undefined;
}

/** States in which the purchase still entitles her to something. */
export const ENTITLING_STATES: StorePurchaseState[] = ['active', 'in_grace', 'canceled'];

/** True when the store's state should keep Premium open. Pure, so both clients and the hooks agree. */
export function stateEntitles(state: StorePurchaseState | undefined): boolean {
  return !!state && ENTITLING_STATES.includes(state);
}

/**
 * A store told us a purchase changed. One shape for both stores so the handler has one job: record it,
 * apply it, and tell her if it is worth telling.
 */
export interface StoreChange {
  provider: StoreProvider;
  /** The store's own id for this notification. The idempotency key: a replay carries the same one. */
  eventId: string;
  /** The store's name for what happened, kept verbatim for the audit trail. */
  notificationType: string;
  subtype?: string | undefined;
  /** How to find the account: Play by purchase token, Apple by original transaction id. */
  purchaseToken?: string | undefined;
  originalTransactionId?: string | undefined;
  productId?: string | undefined;
  /** What this does to her entitlement. */
  action: StoreAction;
  /** Which of the four notices, if any, she should get. */
  notice?: 'renewed' | 'payment_problem' | 'trial_ending' | 'refunded' | undefined;
  environment?: StoreEnvironment | undefined;
  occurredAt?: Date | undefined;
  /** One-off product purchases (a dietitian plan), which are orders rather than subscriptions. */
  isOneOffProduct?: boolean | undefined;
}

/**
 * What the handler does about it.
 *
 * `refresh` is the normal one: ask the store what the purchase looks like now and store that, rather than
 * trusting a notification's own summary of it. `revoke` closes access without asking, because a refund or a
 * revocation is not something to go and double-check. `none` is recorded and nothing else.
 */
export type StoreAction = 'refresh' | 'revoke' | 'none';
