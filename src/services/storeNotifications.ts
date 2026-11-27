/**
 * What happens to a purchase after the sale.
 *
 * Until now the server only ever learned about a purchase while she was looking at the screen that made
 * it. Everything that happens afterwards — the renewal next month, the card that stops working, the refund
 * she asks Google for, the upgrade to Premium Plus — happened silently, and either she kept Premium she
 * had stopped paying for or lost one she was still paying for. Both stores will tell us, if there is
 * somewhere to tell.
 *
 * Three rules hold this together.
 *
 * Nothing unverified is acted on. The signature check happens in the route; by the time anything here runs,
 * the notification is known to be Google's or Apple's.
 *
 * Nothing happens twice. Both stores retry until they are answered, so the audit row is written FIRST and
 * its unique (provider, eventId) index is what makes a replay a no-op. A notification we fail to apply has
 * its row removed again, so the store's next retry is a fresh attempt rather than a swallowed one.
 *
 * Nothing is taken on trust that can be asked. A notification says "something changed", so we go and read
 * the purchase again (Apple signs the new state into the notification itself, so there it is already in
 * hand). The exception is a refund or a revocation, which closes access immediately without asking.
 */
import type { AppleRenewalInfo, AppleTransaction } from './appStore';
import { mapAppleTransaction } from './appStore';
import {
  entitlementFromPlay,
  type Entitlement,
  type PurchaseSource,
  type SubPlan,
  type Tier,
} from './entitlement';
import { getPaidPackages, tierOfProduct } from './packageCatalogue';
import type { PushService, SubscriptionEvent } from './push';
import type { StoreAction, StoreChange, StoreProvider, StoreVerification } from './storeTypes';
import { Order } from '../models/Order';
import { StoreEvent, isDuplicateKey, type StoreEventOutcome } from '../models/StoreEvent';
import { User } from '../models/User';
import { canTransition } from './orderState';
import { log } from '../utils/logger';

/* ------------------------------------------------------------------ Google Play */

export interface PlayRtdnBody {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string };
  oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string; productType?: number; refundType?: number };
  testNotification?: { version?: string };
}

interface Mapping {
  name: string;
  action: StoreAction;
  notice?: SubscriptionEvent | undefined;
}

/**
 * Play's subscription notification types, by number, with what each one means for her.
 *
 * A notice is only attached where she would otherwise be surprised. A purchase, a cancellation and a
 * resubscription are all things she just did herself, so they change her entitlement quietly.
 */
export const PLAY_SUBSCRIPTION_TYPES: Record<number, Mapping> = {
  1: { name: 'SUBSCRIPTION_RECOVERED', action: 'refresh', notice: 'renewed' },
  2: { name: 'SUBSCRIPTION_RENEWED', action: 'refresh', notice: 'renewed' },
  3: { name: 'SUBSCRIPTION_CANCELED', action: 'refresh' },
  4: { name: 'SUBSCRIPTION_PURCHASED', action: 'refresh' },
  5: { name: 'SUBSCRIPTION_ON_HOLD', action: 'refresh', notice: 'payment_problem' },
  6: { name: 'SUBSCRIPTION_IN_GRACE_PERIOD', action: 'refresh', notice: 'payment_problem' },
  7: { name: 'SUBSCRIPTION_RESTARTED', action: 'refresh', notice: 'renewed' },
  8: { name: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED', action: 'none' },
  9: { name: 'SUBSCRIPTION_DEFERRED', action: 'refresh' },
  10: { name: 'SUBSCRIPTION_PAUSED', action: 'refresh' },
  11: { name: 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED', action: 'none' },
  12: { name: 'SUBSCRIPTION_REVOKED', action: 'revoke', notice: 'refunded' },
  13: { name: 'SUBSCRIPTION_EXPIRED', action: 'refresh' },
  20: { name: 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED', action: 'none' },
};

const PLAY_ONE_TIME_TYPES: Record<number, Mapping> = {
  1: { name: 'ONE_TIME_PRODUCT_PURCHASED', action: 'none' },
  2: { name: 'ONE_TIME_PRODUCT_CANCELED', action: 'none' },
};

/**
 * Pure: a decoded Real-time Developer Notification as one change. Null when the body is not one at all —
 * which, after the Pub/Sub signature has been checked, means Google changed the shape, not that anyone is
 * attacking us.
 */
export function mapPlayNotification(body: PlayRtdnBody, eventId: string): StoreChange | null {
  const occurredAt = body.eventTimeMillis && Number.isFinite(Number(body.eventTimeMillis)) ? new Date(Number(body.eventTimeMillis)) : undefined;
  const common = { provider: 'google_play' as StoreProvider, eventId, occurredAt };
  const voided = body.voidedPurchaseNotification;
  if (voided?.purchaseToken) {
    return {
      ...common,
      notificationType: 'VOIDED_PURCHASE',
      subtype: voided.refundType === 2 ? 'PARTIAL_REFUND' : 'FULL_REFUND',
      purchaseToken: voided.purchaseToken,
      action: 'revoke',
      notice: 'refunded',
      // productType 2 is a one-off buy, which for us is a dietitian plan order rather than a subscription.
      isOneOffProduct: voided.productType === 2,
    };
  }
  const sub = body.subscriptionNotification;
  if (sub?.purchaseToken) {
    const m = PLAY_SUBSCRIPTION_TYPES[sub.notificationType ?? -1] ?? { name: `SUBSCRIPTION_UNKNOWN_${String(sub.notificationType)}`, action: 'refresh' as StoreAction };
    return { ...common, notificationType: m.name, purchaseToken: sub.purchaseToken, productId: sub.subscriptionId, action: m.action, notice: m.notice };
  }
  const one = body.oneTimeProductNotification;
  if (one?.purchaseToken) {
    const m = PLAY_ONE_TIME_TYPES[one.notificationType ?? -1] ?? { name: `ONE_TIME_PRODUCT_UNKNOWN_${String(one.notificationType)}`, action: 'none' as StoreAction };
    return { ...common, notificationType: m.name, purchaseToken: one.purchaseToken, productId: one.sku, action: m.action, isOneOffProduct: true };
  }
  // Google's own "is this wired up?" message. Worth recording: it is the proof the pipe works.
  if (body.testNotification) return { ...common, notificationType: 'TEST', action: 'none' };
  return null;
}

/* ------------------------------------------------------------------ App Store */

export interface AppleNotificationPayload {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: {
    bundleId?: string;
    environment?: string;
    status?: number;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

/**
 * Apple's notification types. `EXPIRED` with subtype `BILLING_RETRY` is the one that earns a notice: her
 * subscription has ended because the card kept failing, which she will otherwise discover by losing
 * Premium for no reason she can see.
 */
export function mapAppleNotificationType(notificationType: string, subtype: string | undefined): Mapping {
  const t = notificationType;
  if (t === 'DID_RENEW') return { name: t, action: 'refresh', notice: 'renewed' };
  if (t === 'DID_FAIL_TO_RENEW') return { name: t, action: 'refresh', notice: 'payment_problem' };
  if (t === 'GRACE_PERIOD_EXPIRED') return { name: t, action: 'refresh', notice: 'payment_problem' };
  if (t === 'EXPIRED') return { name: t, action: 'refresh', notice: subtype === 'BILLING_RETRY' ? 'payment_problem' : undefined };
  if (t === 'REFUND' || t === 'REVOKE') return { name: t, action: 'revoke', notice: 'refunded' };
  if (t === 'REFUND_REVERSED') return { name: t, action: 'refresh' };
  if (t === 'SUBSCRIBED' || t === 'DID_CHANGE_RENEWAL_PREF' || t === 'DID_CHANGE_RENEWAL_STATUS') return { name: t, action: 'refresh' };
  if (t === 'OFFER_REDEEMED' || t === 'RENEWAL_EXTENDED' || t === 'RESUBSCRIBE') return { name: t, action: 'refresh' };
  // CONSUMPTION_REQUEST, PRICE_INCREASE, REFUND_DECLINED, RENEWAL_EXTENSION, TEST and anything new.
  return { name: t, action: 'none' };
}

/**
 * Pure: a verified App Store Server Notification as one change. Apple signs the new transaction and renewal
 * state into the notification, so unlike Play there is nothing to go and fetch — `verified` carries it.
 */
export function mapAppleNotification(
  payload: AppleNotificationPayload,
  verified: { transaction: AppleTransaction | null; renewal: AppleRenewalInfo | null },
): StoreChange | null {
  const type = payload.notificationType;
  if (!type || !payload.notificationUUID) return null;
  const m = mapAppleNotificationType(type, payload.subtype);
  const tx = verified.transaction;
  const originalTransactionId = tx?.originalTransactionId ?? verified.renewal?.originalTransactionId ?? undefined;
  return {
    provider: 'app_store',
    eventId: payload.notificationUUID,
    notificationType: m.name,
    subtype: payload.subtype,
    originalTransactionId,
    productId: tx?.productId,
    action: m.action,
    notice: m.notice,
    environment: payload.data?.environment === 'Sandbox' ? 'sandbox' : payload.data?.environment === 'Production' ? 'production' : undefined,
    occurredAt: typeof payload.signedDate === 'number' ? new Date(payload.signedDate) : undefined,
    isOneOffProduct: tx?.type === 'Non-Consumable' || tx?.type === 'Consumable',
  };
}

/* ------------------------------------------------------------------ applying it */

export interface AccountRow {
  userId: string;
  subscription: Entitlement & { productId?: string | null; purchaseToken?: string | null; tier?: Tier | null; plan?: SubPlan | null };
}

/** The account side, behind an interface so the tests need no database. */
export interface SubscriptionAccounts {
  byPurchaseToken(token: string): Promise<AccountRow | null>;
  save(userId: string, subscription: Record<string, unknown>): Promise<void>;
}

export const mongoAccounts: SubscriptionAccounts = {
  async byPurchaseToken(token) {
    const u = await User.findOne({ 'subscription.purchaseToken': token }).select('subscription').lean();
    if (!u) return null;
    return { userId: String(u._id), subscription: (u.subscription ?? { status: 'none' }) as AccountRow['subscription'] };
  },
  async save(userId, subscription) {
    await User.updateOne({ _id: userId }, { $set: { subscription } });
  },
};

/** The audit trail, behind an interface for the same reason. */
export interface StoreEventLog {
  /** Writes the row, or says this notification has already been handled. */
  begin(change: StoreChange): Promise<{ id: string } | 'duplicate'>;
  finish(id: string, patch: { userId?: string | null; outcome: StoreEventOutcome; statusAfter?: string | null; note?: string | null }): Promise<void>;
  /** Removes the row after a failure, so the store's next retry is a real attempt. */
  abandon(id: string): Promise<void>;
}

export const mongoStoreEvents: StoreEventLog = {
  async begin(change) {
    try {
      const row = await StoreEvent.create({
        provider: change.provider,
        eventId: change.eventId,
        notificationType: change.notificationType,
        subtype: change.subtype ?? null,
        purchaseToken: change.purchaseToken ?? null,
        originalTransactionId: change.originalTransactionId ?? null,
        productId: change.productId ?? null,
        action: change.action,
        notice: change.notice ?? null,
        environment: change.environment ?? null,
        occurredAt: change.occurredAt ?? null,
      });
      return { id: String(row._id) };
    } catch (e) {
      if (isDuplicateKey(e)) return 'duplicate';
      throw e;
    }
  },
  async finish(id, patch) {
    await StoreEvent.updateOne({ _id: id }, { $set: { ...patch, handledAt: new Date() } });
  },
  async abandon(id) {
    await StoreEvent.deleteOne({ _id: id });
  },
};

/** One-off plan purchases, which are Orders rather than subscriptions. */
export interface RefundableOrders {
  byPurchaseToken(token: string): Promise<{ orderId: string; clientId: string; status: string } | null>;
  markRefunded(orderId: string, reason: string): Promise<void>;
}

export const mongoRefundableOrders: RefundableOrders = {
  async byPurchaseToken(token) {
    const o = await Order.findOne({ purchaseToken: token }).select('clientId status').lean();
    return o ? { orderId: String(o._id), clientId: String(o.clientId), status: String(o.status) } : null;
  },
  async markRefunded(orderId, reason) {
    await Order.updateOne({ _id: orderId }, { $set: { status: 'refunded', refundedAt: new Date(), refundReason: reason } });
  },
};

export interface StoreReaders {
  /** Reads a Play subscription from its token. Null when no service account is configured. */
  play: { subscriptionByToken(token: string): Promise<StoreVerification> } | null;
  /** Only needed for a verification Apple did not sign into the notification. */
  appStore: { byOriginalTransactionId(id: string): Promise<StoreVerification> } | null;
}

export interface StoreNotificationDeps extends StoreReaders {
  push: PushService;
  accounts?: SubscriptionAccounts;
  events?: StoreEventLog;
  orders?: RefundableOrders;
  now?: () => Date;
}

export interface HandleResult {
  outcome: StoreEventOutcome | 'duplicate';
  /** False tells the route to answer 5xx so the store tries again. */
  ok: boolean;
  note?: string | undefined;
}

export interface StoreNotificationService {
  /** `verified` carries what Apple signed into the notification; Play has nothing to carry. */
  handle(change: StoreChange, verified?: { transaction: AppleTransaction | null; renewal: AppleRenewalInfo | null; status?: number | undefined; bundleId?: string; environment?: 'production' | 'sandbox' }): Promise<HandleResult>;
}

/** Which plan and tier a product id belongs to, asked of the existing catalogue rather than re-decided. */
async function packageOf(productId: string | undefined): Promise<{ tier: Exclude<Tier, 'free'>; plan: SubPlan } | null> {
  if (!productId) return null;
  return tierOfProduct(await getPaidPackages(), productId);
}

export function createStoreNotificationService(deps: StoreNotificationDeps): StoreNotificationService {
  const accounts = deps.accounts ?? mongoAccounts;
  const events = deps.events ?? mongoStoreEvents;
  const orders = deps.orders ?? mongoRefundableOrders;
  const now = deps.now ?? (() => new Date());

  /** The entitlement to store, built by the existing rules from whatever the store last said. */
  async function entitlementFor(v: StoreVerification, row: AccountRow, source: PurchaseSource): Promise<Entitlement & Record<string, unknown>> {
    const productId = v.productId ?? row.subscription.productId ?? undefined;
    const pkg = await packageOf(productId);
    // An unknown product id must not silently demote her: her stored tier and plan stand.
    const tier: Exclude<Tier, 'free'> = pkg?.tier ?? (row.subscription.tier === 'plus' ? 'plus' : 'premium');
    const plan: SubPlan = pkg?.plan ?? (row.subscription.plan === 'yearly' ? 'yearly' : 'monthly');
    if (!pkg) log.warn('store notification names a product that is not in the catalogue', { productId: productId ?? 'none' });
    return entitlementFromPlay(v, plan, now(), source, tier) as Entitlement & Record<string, unknown>;
  }

  async function apply(change: StoreChange, verified: Parameters<StoreNotificationService['handle']>[1]): Promise<HandleResult & { userId?: string | undefined; statusAfter?: string | undefined }> {
    const source: PurchaseSource = change.provider;
    const key = change.provider === 'google_play' ? change.purchaseToken : change.originalTransactionId;
    if (!key) return { ok: true, outcome: 'ignored', note: 'notification names no purchase' };

    // A refunded one-off plan is an order, not a subscription. Close the order and tell her.
    if (change.isOneOffProduct && change.action === 'revoke') {
      const order = await orders.byPurchaseToken(key);
      if (!order) return { ok: true, outcome: 'no_account', note: 'no order holds this purchase' };
      if (canTransition(order.status as never, 'refunded')) await orders.markRefunded(order.orderId, `refunded at the ${change.provider === 'google_play' ? 'Play Store' : 'App Store'}`);
      else log.warn('store refunded an order that cannot move to refunded', { status: order.status });
      if (change.notice) deps.push.notify(order.clientId, { type: 'subscription', event: change.notice });
      return { ok: true, outcome: 'applied', userId: order.clientId, statusAfter: 'refunded' };
    }
    if (change.isOneOffProduct) return { ok: true, outcome: 'ignored', note: 'a one-off purchase is handled by the order it paid for' };

    let row = await accounts.byPurchaseToken(key);
    let v: StoreVerification | null = null;

    if (change.provider === 'google_play') {
      if (!deps.play) return { ok: false, outcome: 'refused', note: 'no Play service account is configured, so nothing can be verified' };
      v = await deps.play.subscriptionByToken(key);
      // An upgrade arrives on a new token while her account still holds the old one. One hop, which is all
      // Play gives us: the purchase names the token it replaced.
      if (!row && v.linkedPurchaseToken) row = await accounts.byPurchaseToken(v.linkedPurchaseToken);
    } else if (verified?.transaction) {
      // Apple signed the new state into the notification itself, so this needs no call to Apple.
      v = mapAppleTransaction(verified.transaction, verified.renewal, {
        bundleId: verified.bundleId ?? verified.transaction.bundleId ?? '',
        environment: verified.environment ?? 'production',
        status: verified.status,
      });
    } else if (deps.appStore) {
      v = await deps.appStore.byOriginalTransactionId(key);
    } else {
      return { ok: false, outcome: 'refused', note: 'no App Store key is configured, so nothing can be verified' };
    }

    if (!row) return { ok: true, outcome: 'no_account', note: 'no account holds this purchase' };

    if (change.action === 'revoke') {
      // A refund or a revocation closes access now. The record of what she had is kept.
      const sub = {
        ...row.subscription,
        status: 'expired',
        expiresAt: now(),
        trialEndsAt: null,
        source,
        purchaseToken: key,
        updatedAt: now(),
      };
      await accounts.save(row.userId, sub as Record<string, unknown>);
      if (change.notice) deps.push.notify(row.userId, { type: 'subscription', event: change.notice });
      return { ok: true, outcome: 'applied', userId: row.userId, statusAfter: 'expired' };
    }

    if (v.invalidReason === 'unverified') return { ok: false, outcome: 'failed', note: 'the store could not be reached' };

    const ent = await entitlementFor(v, row, source);
    await accounts.save(row.userId, {
      ...ent,
      productId: v.productId ?? row.subscription.productId ?? null,
      purchaseToken: key,
      playOrderId: v.orderId ?? null,
      updatedAt: now(),
    });
    if (change.notice) deps.push.notify(row.userId, { type: 'subscription', event: change.notice });
    return { ok: true, outcome: 'applied', userId: row.userId, statusAfter: String(ent.status) };
  }

  return {
    async handle(change, verified) {
      // The row goes in first: it is both the audit trail and the thing that makes a replay do nothing.
      const started = await events.begin(change);
      if (started === 'duplicate') {
        log.info('store notification replayed, ignored', { provider: change.provider, type: change.notificationType });
        return { ok: true, outcome: 'duplicate' };
      }
      if (change.action === 'none') {
        await events.finish(started.id, { outcome: 'ignored' });
        return { ok: true, outcome: 'ignored' };
      }
      try {
        const r = await apply(change, verified);
        if (!r.ok) {
          // Nothing was applied, so the row must not stand in the way of the store trying again.
          await events.abandon(started.id);
          return { ok: false, outcome: r.outcome, note: r.note };
        }
        await events.finish(started.id, { userId: r.userId ?? null, outcome: r.outcome as StoreEventOutcome, statusAfter: r.statusAfter ?? null, note: r.note ?? null });
        log.info('store notification applied', { provider: change.provider, type: change.notificationType, outcome: r.outcome });
        return { ok: true, outcome: r.outcome, note: r.note };
      } catch (e) {
        await events.abandon(started.id).catch(() => undefined);
        throw e;
      }
    },
  };
}
