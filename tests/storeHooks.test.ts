import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { CompactSign, importPKCS8 } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler, notFoundHandler } from '../src/middleware/error';
import type { PushNotice, PushService } from '../src/services/push';
import { verifyAppleJws } from '../src/services/storeJws';
import type { StoreChange, StoreVerification } from '../src/services/storeTypes';
import { LEAF_KEY_PKCS8, ROGUE_LEAF_KEY_PKCS8, ROGUE_X5C, ROOT_CERT_PEM, X5C } from './fixtures/appleCerts';

const HER = '507f1f77bcf86cd799439011';
const EXPIRY = new Date('2027-01-15T10:00:00.000Z');
const LATER = new Date('2027-02-15T10:00:00.000Z');

vi.mock('../src/services/packageCatalogue', () => ({
  getPaidPackages: async () => [],
  tierOfProduct: (_pkgs: unknown, productId: string) =>
    productId === 'saathi_premium_monthly'
      ? { tier: 'premium', plan: 'monthly' }
      : productId === 'saathi_plus_yearly'
        ? { tier: 'plus', plan: 'yearly' }
        : null,
}));

import {
  PLAY_SUBSCRIPTION_TYPES,
  createStoreNotificationService,
  mapAppleNotification,
  mapAppleNotificationType,
  mapPlayNotification,
  type StoreNotificationService,
} from '../src/services/storeNotifications';
import { storeHookRoutes } from '../src/routes/storeHooks';

type Notifications = StoreNotificationService;

const rtdn = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64');

const playSub = (notificationType: number, over: Record<string, unknown> = {}) => ({
  version: '1.0',
  packageName: 'com.multiware.saathi',
  eventTimeMillis: String(Date.now()),
  subscriptionNotification: { version: '1.0', notificationType, purchaseToken: 'tok-1', subscriptionId: 'saathi_premium_monthly' },
  ...over,
});

async function signApple(payload: unknown, opts: { x5c?: string[]; key?: string } = {}): Promise<string> {
  const key = await importPKCS8(opts.key ?? LEAF_KEY_PKCS8, 'ES256');
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'ES256', x5c: opts.x5c ?? X5C })
    .sign(key);
}

const appleTx = (over: Record<string, unknown> = {}) => ({
  transactionId: '2000000222',
  originalTransactionId: '1000000999',
  productId: 'saathi_premium_monthly',
  bundleId: 'com.multiware.saathi',
  environment: 'Production',
  type: 'Auto-Renewable Subscription',
  expiresDate: LATER.getTime(),
  ...over,
});

/** A whole App Store notification, signed for real, inner payloads included. */
async function appleNotification(
  notificationType: string,
  opts: { subtype?: string; uuid?: string; status?: number; tx?: Record<string, unknown>; renewal?: Record<string, unknown>; environment?: string; bundleId?: string; x5c?: string[]; key?: string; innerKey?: string } = {},
): Promise<string> {
  const data = {
    bundleId: opts.bundleId ?? 'com.multiware.saathi',
    environment: opts.environment ?? 'Production',
    status: opts.status ?? 1,
    signedTransactionInfo: await signApple(appleTx(opts.tx), { x5c: opts.x5c, key: opts.innerKey ?? opts.key }),
    signedRenewalInfo: await signApple({ autoRenewStatus: 1, originalTransactionId: '1000000999', ...(opts.renewal ?? {}) }, { x5c: opts.x5c, key: opts.innerKey ?? opts.key }),
  };
  return signApple({ notificationType, subtype: opts.subtype, notificationUUID: opts.uuid ?? 'uuid-1', version: '2.0', signedDate: Date.now(), data }, { x5c: opts.x5c, key: opts.key });
}

function spyPush(): PushService & { calls: PushNotice[] } {
  const calls: PushNotice[] = [];
  return {
    calls,
    configured: true,
    async register() {},
    async unregister() {},
    notify: (_u, notice) => void calls.push(notice),
    notifyOnce: (_u, notice) => void calls.push(notice),
    deliver: async () => ({ sent: 0, dropped: [] }),
  };
}

/** The account rows, the audit rows and the orders, in memory: this suite has no database. */
function memoryWorld() {
  const accounts = new Map<string, Record<string, unknown>>();
  accounts.set(HER, { status: 'active', tier: 'premium', plan: 'monthly', purchaseToken: 'tok-1', productId: 'saathi_premium_monthly', expiresAt: EXPIRY, source: 'google_play' });
  const rows: { id: string; provider: string; eventId: string; outcome?: string; userId?: string | null; statusAfter?: string | null }[] = [];
  const orders = new Map<string, { orderId: string; clientId: string; status: string }>();
  let n = 0;
  return {
    accounts,
    rows,
    orders,
    store: {
      async byPurchaseToken(token: string) {
        for (const [userId, subscription] of accounts) {
          if ((subscription as { purchaseToken?: string }).purchaseToken === token) return { userId, subscription: subscription as never };
        }
        return null;
      },
      async save(userId: string, subscription: Record<string, unknown>) {
        accounts.set(userId, subscription);
      },
    },
    events: {
      async begin(change: StoreChange) {
        if (rows.some((r) => r.provider === change.provider && r.eventId === change.eventId)) return 'duplicate' as const;
        n += 1;
        const row = { id: `row-${n}`, provider: change.provider, eventId: change.eventId };
        rows.push(row);
        return { id: row.id };
      },
      async finish(id: string, patch: { outcome: string; userId?: string | null; statusAfter?: string | null }) {
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
      },
      async abandon(id: string) {
        const at = rows.findIndex((r) => r.id === id);
        if (at >= 0) rows.splice(at, 1);
      },
    },
    orderStore: {
      async byPurchaseToken(token: string) {
        return orders.get(token) ?? null;
      },
      async markRefunded(orderId: string, _reason: string) {
        for (const [, o] of orders) if (o.orderId === orderId) o.status = 'refunded';
      },
    },
  };
}

describe('what Google is telling us', () => {
  it('reads a renewal as a renewal, and tells her about it', () => {
    const c = mapPlayNotification(playSub(2), 'msg-1')!;
    expect(c).toMatchObject({ provider: 'google_play', notificationType: 'SUBSCRIPTION_RENEWED', action: 'refresh', notice: 'renewed', purchaseToken: 'tok-1', productId: 'saathi_premium_monthly' });
  });

  it('says nothing about things she did herself, and speaks up about the ones she did not', () => {
    const notice = (t: number) => mapPlayNotification(playSub(t), `m${t}`)?.notice ?? null;
    expect(notice(4)).toBeNull(); // she just bought it, on the screen in front of her
    expect(notice(3)).toBeNull(); // she cancelled it herself
    expect(notice(2)).toBe('renewed');
    expect(notice(1)).toBe('renewed');
    expect(notice(7)).toBe('renewed');
    expect(notice(5)).toBe('payment_problem'); // on hold
    expect(notice(6)).toBe('payment_problem'); // grace period
    expect(notice(12)).toBe('refunded'); // revoked
    expect(notice(13)).toBeNull(); // expired in the ordinary way
  });

  it('closes access on a revocation rather than going back to ask', () => {
    expect(mapPlayNotification(playSub(12), 'm12')!.action).toBe('revoke');
    expect(PLAY_SUBSCRIPTION_TYPES[12]!.name).toBe('SUBSCRIPTION_REVOKED');
  });

  it('reads a voided purchase, and knows a plan order from a subscription', () => {
    const sub = mapPlayNotification({ voidedPurchaseNotification: { purchaseToken: 'tok-1', orderId: 'GPA.1', productType: 1, refundType: 1 } }, 'v1')!;
    expect(sub).toMatchObject({ notificationType: 'VOIDED_PURCHASE', subtype: 'FULL_REFUND', action: 'revoke', notice: 'refunded', isOneOffProduct: false });
    const one = mapPlayNotification({ voidedPurchaseNotification: { purchaseToken: 'tok-2', productType: 2, refundType: 2 } }, 'v2')!;
    expect(one).toMatchObject({ isOneOffProduct: true, subtype: 'PARTIAL_REFUND' });
  });

  it('records Google\'s test notification and acts on nothing it does not understand', () => {
    expect(mapPlayNotification({ testNotification: { version: '1.0' } }, 't1')).toMatchObject({ notificationType: 'TEST', action: 'none' });
    expect(mapPlayNotification({}, 'x')).toBeNull();
    // A type Google adds later is refreshed rather than ignored: re-reading the purchase is always safe.
    expect(mapPlayNotification(playSub(99), 'm99')).toMatchObject({ action: 'refresh', notificationType: 'SUBSCRIPTION_UNKNOWN_99' });
  });
});

describe('what Apple is telling us', () => {
  it('maps the types that change what she has', () => {
    expect(mapAppleNotificationType('DID_RENEW', 'BILLING_RECOVERY')).toMatchObject({ action: 'refresh', notice: 'renewed' });
    expect(mapAppleNotificationType('DID_FAIL_TO_RENEW', 'GRACE_PERIOD')).toMatchObject({ action: 'refresh', notice: 'payment_problem' });
    expect(mapAppleNotificationType('GRACE_PERIOD_EXPIRED', undefined)).toMatchObject({ notice: 'payment_problem' });
    expect(mapAppleNotificationType('REFUND', undefined)).toMatchObject({ action: 'revoke', notice: 'refunded' });
    expect(mapAppleNotificationType('REVOKE', undefined)).toMatchObject({ action: 'revoke', notice: 'refunded' });
    // These three change what she has without being worth a notification: she did them, or nothing was lost.
    for (const [t, sub] of [['REFUND_REVERSED', undefined], ['DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED'], ['SUBSCRIBED', 'INITIAL_BUY']] as const) {
      expect(mapAppleNotificationType(t, sub)).toMatchObject({ action: 'refresh' });
      expect(mapAppleNotificationType(t, sub).notice).toBeUndefined();
    }
    expect(mapAppleNotificationType('CONSUMPTION_REQUEST', undefined)).toMatchObject({ action: 'none' });
    expect(mapAppleNotificationType('TEST', undefined)).toMatchObject({ action: 'none' });
  });

  it('tells her about a subscription lost to a failing card, which she cannot otherwise explain', () => {
    expect(mapAppleNotificationType('EXPIRED', 'BILLING_RETRY').notice).toBe('payment_problem');
    expect(mapAppleNotificationType('EXPIRED', 'VOLUNTARY').notice).toBeUndefined();
  });

  it('keys on the original transaction id and needs the notification\'s own id', () => {
    const c = mapAppleNotification({ notificationType: 'DID_RENEW', notificationUUID: 'u-1', data: { environment: 'Production' } }, { transaction: appleTx(), renewal: null })!;
    expect(c).toMatchObject({ provider: 'app_store', eventId: 'u-1', originalTransactionId: '1000000999', environment: 'production' });
    expect(mapAppleNotification({ notificationType: 'DID_RENEW' }, { transaction: null, renewal: null })).toBeNull();
    expect(mapAppleNotification({ notificationUUID: 'u-2' }, { transaction: null, renewal: null })).toBeNull();
  });
});

describe('acting on a change, once and only once', () => {
  const push = spyPush();
  let world: ReturnType<typeof memoryWorld>;
  let service: Notifications;
  let playState: StoreVerification;

  beforeEach(() => {
    push.calls.length = 0;
    world = memoryWorld();
    playState = { valid: true, state: 'active', productId: 'saathi_premium_monthly', orderId: 'GPA.next', expiresAt: LATER, autoRenewing: true };
    service = createStoreNotificationService({
      push,
      play: { async subscriptionByToken() { return playState; } },
      appStore: null,
      accounts: world.store,
      events: world.events,
      orders: world.orderStore,
    });
  });

  it('moves the period forward on a renewal and tells her', async () => {
    const r = await service.handle(mapPlayNotification(playSub(2), 'msg-renew')!);
    expect(r).toMatchObject({ ok: true, outcome: 'applied' });
    expect(world.accounts.get(HER)).toMatchObject({ status: 'active', tier: 'premium', expiresAt: LATER, playOrderId: 'GPA.next' });
    expect(push.calls).toEqual([{ type: 'subscription', event: 'renewed' }]);
    expect(world.rows).toHaveLength(1);
    expect(world.rows[0]).toMatchObject({ outcome: 'applied', userId: HER, statusAfter: 'active' });
  });

  it('does nothing at all the second time the same notification arrives', async () => {
    const change = mapPlayNotification(playSub(2), 'msg-renew')!;
    await service.handle(change);
    // Both stores retry until they are answered, so the same message can arrive several times over.
    const again = await service.handle(change);
    const third = await service.handle({ ...change, occurredAt: new Date() });
    expect(again).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(third.outcome).toBe('duplicate');
    expect(push.calls).toHaveLength(1);
    expect(world.rows).toHaveLength(1);
  });

  it('closes access the moment a refund arrives, without asking the store anything', async () => {
    const r = await service.handle(mapPlayNotification(playSub(12), 'msg-revoke')!);
    expect(r.outcome).toBe('applied');
    const sub = world.accounts.get(HER)!;
    expect(sub).toMatchObject({ status: 'expired' });
    expect((sub['expiresAt'] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(push.calls).toEqual([{ type: 'subscription', event: 'refunded' }]);
  });

  it('turns auto-renew off without taking away the period she paid for', async () => {
    playState = { ...playState, state: 'canceled', autoRenewing: false, expiresAt: LATER };
    await service.handle(mapPlayNotification(playSub(3), 'msg-cancel')!);
    expect(world.accounts.get(HER)).toMatchObject({ status: 'canceled', expiresAt: LATER });
    // Cancelling is her own doing: no notification.
    expect(push.calls).toEqual([]);
  });

  it('warns her when the card fails and keeps her Premium through the grace period', async () => {
    playState = { ...playState, state: 'in_grace', inGracePeriod: true };
    await service.handle(mapPlayNotification(playSub(6), 'msg-grace')!);
    expect(world.accounts.get(HER)).toMatchObject({ status: 'active' });
    expect(push.calls).toEqual([{ type: 'subscription', event: 'payment_problem' }]);
  });

  it('lets her lapse when the store says it is over', async () => {
    playState = { valid: false, state: 'expired', expiresAt: EXPIRY, productId: 'saathi_premium_monthly' };
    await service.handle(mapPlayNotification(playSub(13), 'msg-expired')!);
    expect(world.accounts.get(HER)).toMatchObject({ status: 'expired' });
  });

  it('follows an upgrade from the token it replaced', async () => {
    playState = { ...playState, productId: 'saathi_plus_yearly', linkedPurchaseToken: 'tok-1' };
    // The notification arrives on the NEW token, which no account holds yet.
    const change = mapPlayNotification({ ...playSub(4), subscriptionNotification: { notificationType: 4, purchaseToken: 'tok-new', subscriptionId: 'saathi_plus_yearly' } }, 'msg-upgrade')!;
    expect((await service.handle(change)).outcome).toBe('applied');
    expect(world.accounts.get(HER)).toMatchObject({ tier: 'plus', plan: 'yearly', purchaseToken: 'tok-new' });
  });

  it('does not demote her because a product id is not in the catalogue', async () => {
    playState = { ...playState, productId: 'saathi_legacy_lifetime' };
    world.accounts.set(HER, { status: 'active', tier: 'plus', plan: 'yearly', purchaseToken: 'tok-1' });
    await service.handle(mapPlayNotification(playSub(2), 'msg-odd')!);
    expect(world.accounts.get(HER)).toMatchObject({ tier: 'plus', plan: 'yearly' });
  });

  it('records a notification for a purchase no account holds, and tells nobody', async () => {
    const change = mapPlayNotification({ ...playSub(2), subscriptionNotification: { notificationType: 2, purchaseToken: 'someone-elses', subscriptionId: 'x' } }, 'msg-orphan')!;
    playState = { ...playState, linkedPurchaseToken: null };
    expect(await service.handle(change)).toMatchObject({ ok: true, outcome: 'no_account' });
    expect(push.calls).toEqual([]);
    expect(world.rows[0]).toMatchObject({ outcome: 'no_account' });
  });

  it('records the ones that change nothing and asks the store nothing', async () => {
    let asked = 0;
    const s = createStoreNotificationService({
      push,
      play: { async subscriptionByToken() { asked += 1; return playState; } },
      appStore: null,
      accounts: world.store,
      events: world.events,
      orders: world.orderStore,
    });
    expect(await s.handle(mapPlayNotification(playSub(8), 'msg-price')!)).toMatchObject({ ok: true, outcome: 'ignored' });
    expect(asked).toBe(0);
    expect(world.rows[0]).toMatchObject({ outcome: 'ignored' });
  });

  it('refuses to act with no Play credentials, and leaves no row in the way of a retry', async () => {
    const s = createStoreNotificationService({ push, play: null, appStore: null, accounts: world.store, events: world.events, orders: world.orderStore });
    const r = await s.handle(mapPlayNotification(playSub(2), 'msg-nocreds')!);
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    // Nothing was applied, so the next delivery must be a fresh attempt rather than a swallowed duplicate.
    expect(world.rows).toEqual([]);
    expect(push.calls).toEqual([]);
  });

  it('leaves no row behind when the store cannot be reached either', async () => {
    const s = createStoreNotificationService({
      push,
      play: { async subscriptionByToken() { return { valid: false, invalidReason: 'unverified' as const }; } },
      appStore: null,
      accounts: world.store,
      events: world.events,
      orders: world.orderStore,
    });
    expect(await s.handle(mapPlayNotification(playSub(2), 'msg-down')!)).toMatchObject({ ok: false, outcome: 'failed' });
    expect(world.rows).toEqual([]);
  });

  it('refunds the plan order behind a one-off purchase and tells her', async () => {
    world.orders.set('order-token', { orderId: 'order-1', clientId: HER, status: 'paid' });
    const change = mapPlayNotification({ voidedPurchaseNotification: { purchaseToken: 'order-token', orderId: 'GPA.1', productType: 2, refundType: 1 } }, 'msg-void')!;
    expect((await service.handle(change)).outcome).toBe('applied');
    expect(world.orders.get('order-token')).toMatchObject({ status: 'refunded' });
    expect(push.calls).toEqual([{ type: 'subscription', event: 'refunded' }]);
    // Her subscription is untouched: a plan order is not Premium.
    expect(world.accounts.get(HER)).toMatchObject({ status: 'active' });
  });

  it('applies what Apple signed into the notification without calling Apple at all', async () => {
    world.accounts.set(HER, { status: 'active', tier: 'premium', plan: 'monthly', purchaseToken: '1000000999', source: 'app_store', expiresAt: EXPIRY });
    const s = createStoreNotificationService({ push, play: null, appStore: null, accounts: world.store, events: world.events, orders: world.orderStore });
    const change = mapAppleNotification({ notificationType: 'DID_RENEW', notificationUUID: 'u-apple', data: { environment: 'Production' } }, { transaction: appleTx(), renewal: { autoRenewStatus: 1 } })!;
    const r = await s.handle(change, { transaction: appleTx(), renewal: { autoRenewStatus: 1 }, status: 1, bundleId: 'com.multiware.saathi', environment: 'production' });
    expect(r.outcome).toBe('applied');
    expect(world.accounts.get(HER)).toMatchObject({ status: 'active', source: 'app_store', expiresAt: LATER });
    expect(push.calls).toEqual([{ type: 'subscription', event: 'renewed' }]);
  });
});

describe('Apple\'s signature, checked properly', () => {
  it('accepts a payload signed by a chain that reaches the configured root', async () => {
    const r = await verifyAppleJws<{ hello: string }>(await signApple({ hello: 'world' }), [ROOT_CERT_PEM]);
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({ hello: 'world' });
  });

  it('refuses a perfectly valid chain to a root we were never given', async () => {
    const jws = await signApple({ hello: 'world' }, { x5c: ROGUE_X5C, key: ROGUE_LEAF_KEY_PKCS8 });
    const r = await verifyAppleJws(jws, [ROOT_CERT_PEM]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/configured Apple root/);
  });

  it('refuses Apple\'s own chain with somebody else\'s signature under it', async () => {
    const jws = await signApple({ hello: 'world' }, { x5c: X5C, key: ROGUE_LEAF_KEY_PKCS8 });
    expect(await verifyAppleJws(jws, [ROOT_CERT_PEM])).toMatchObject({ ok: false });
  });

  it('refuses a tampered payload', async () => {
    const parts = (await signApple({ amount: 1 })).split('.');
    parts[1] = Buffer.from(JSON.stringify({ amount: 1000 })).toString('base64url');
    expect(await verifyAppleJws(parts.join('.'), [ROOT_CERT_PEM])).toMatchObject({ ok: false });
  });

  it('refuses everything when no trust anchor is configured, which is where Saathi is today', async () => {
    expect(await verifyAppleJws(await signApple({ hello: 'world' }), [])).toMatchObject({ ok: false, error: expect.stringContaining('no Apple trust anchor') });
  });

  it('refuses a signature with no chain, an unreadable chain, or a weaker algorithm', async () => {
    const noChain = await new CompactSign(new TextEncoder().encode('{}')).setProtectedHeader({ alg: 'ES256' }).sign(await importPKCS8(LEAF_KEY_PKCS8, 'ES256'));
    expect(await verifyAppleJws(noChain, [ROOT_CERT_PEM])).toMatchObject({ ok: false, error: expect.stringContaining('no certificate chain') });
    const junk = `${Buffer.from(JSON.stringify({ alg: 'ES256', x5c: ['not-a-certificate'] })).toString('base64url')}.e30.x`;
    expect(await verifyAppleJws(junk, [ROOT_CERT_PEM])).toMatchObject({ ok: false, error: expect.stringContaining('unreadable') });
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256', x5c: X5C })).toString('base64url')}.e30.x`;
    expect(await verifyAppleJws(hs, [ROOT_CERT_PEM])).toMatchObject({ ok: false, error: expect.stringContaining('algorithm') });
    expect(await verifyAppleJws('not a jws at all', [ROOT_CERT_PEM])).toMatchObject({ ok: false });
  });
});

describe('the two store hooks', () => {
  /** A notifications service that records what it was asked to do. */
  function spyNotifications(ok = true) {
    const seen: StoreChange[] = [];
    const service: Notifications = {
      async handle(change) {
        seen.push(change);
        return ok ? { ok: true, outcome: 'applied' } : { ok: false, outcome: 'failed', note: 'nope' };
      },
    };
    return { service, seen };
  }

  const serve = (router: express.Router) => {
    const app = express();
    app.use(express.json());
    app.use('/v1/store', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    const server = app.listen(0);
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };

  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  describe('Google Play notifications', () => {
    let server: Server;
    let base: string;
    let spy = spyNotifications();
    /** The claims the Pub/Sub token verifies to; null stands for a token that does not verify at all. */
    let claims: { email?: string; emailVerified?: boolean } | null = null;
    const SA = 'rtdn@saathi.iam.gserviceaccount.com';
    const auth = { authorization: 'Bearer pretend-oidc-token' };

    beforeAll(() => {
      spy = spyNotifications();
      const started = serve(
        storeHookRoutes({
          notifications: spy.service,
          pubSub: { async verify() { return claims; } },
          pubSubServiceAccount: SA,
          packageName: 'com.multiware.saathi',
        }),
      );
      server = started.server;
      base = started.base;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    beforeEach(() => {
      spy.seen.length = 0;
      claims = { email: SA, emailVerified: true };
    });

    it('acts on a notification that proves it is Google\'s', async () => {
      const r = await post(base, '/v1/store/google/rtdn', { message: { data: rtdn(playSub(2)), messageId: 'pubsub-1' }, subscription: 'projects/x/subscriptions/y' }, auth);
      expect(r.status).toBe(200);
      expect(spy.seen).toHaveLength(1);
      expect(spy.seen[0]).toMatchObject({ eventId: 'pubsub-1', notificationType: 'SUBSCRIPTION_RENEWED' });
    });

    it('refuses one with no token, an unverifiable token, or the wrong service account', async () => {
      expect((await post(base, '/v1/store/google/rtdn', { message: { data: rtdn(playSub(2)) } })).status).toBe(401);
      claims = null;
      expect((await post(base, '/v1/store/google/rtdn', { message: { data: rtdn(playSub(2)) } }, auth)).status).toBe(401);
      claims = { email: 'anyone@gmail.com', emailVerified: true };
      expect((await post(base, '/v1/store/google/rtdn', { message: { data: rtdn(playSub(2)) } }, auth)).status).toBe(401);
      claims = { email: SA, emailVerified: false };
      expect((await post(base, '/v1/store/google/rtdn', { message: { data: rtdn(playSub(2)) } }, auth)).status).toBe(401);
      // Not one of them reached the handler.
      expect(spy.seen).toEqual([]);
    });

    it('ignores a notification about another app', async () => {
      const r = await post(base, '/v1/store/google/rtdn', { message: { data: rtdn({ ...playSub(2), packageName: 'com.other.app' }), messageId: 'm' } }, auth);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ignored: 'package' });
      expect(spy.seen).toEqual([]);
    });

    it('answers Pub/Sub\'s empty check and refuses unreadable data', async () => {
      expect((await post(base, '/v1/store/google/rtdn', { message: {} }, auth)).status).toBe(200);
      expect((await post(base, '/v1/store/google/rtdn', { message: { data: 'bm90IGpzb24=' } }, auth)).status).toBe(400);
      expect(spy.seen).toEqual([]);
    });

    it('recognises a retry with no message id by its content', async () => {
      const body = { message: { data: rtdn(playSub(2)) } };
      await post(base, '/v1/store/google/rtdn', body, auth);
      await post(base, '/v1/store/google/rtdn', body, auth);
      expect(spy.seen).toHaveLength(2);
      expect(spy.seen[0]!.eventId).toBe(spy.seen[1]!.eventId);
      expect(spy.seen[0]!.eventId).toMatch(/^sha256:/);
    });

    it('asks Google to try again when it could not be applied', async () => {
      const failing = spyNotifications(false);
      const { server: s2, base: b2 } = serve(storeHookRoutes({ notifications: failing.service, pubSub: { async verify() { return claims; } }, pubSubServiceAccount: SA }));
      expect((await post(b2, '/v1/store/google/rtdn', { message: { data: rtdn(playSub(2)), messageId: 'm' } }, auth)).status).toBe(503);
      await new Promise<void>((done) => s2.close(() => done()));
    });

    it('refuses everything with no Pub/Sub audience configured, which is where Saathi is today', async () => {
      const { server: s3, base: b3 } = serve(storeHookRoutes({ notifications: spy.service, pubSub: null }));
      const r = await post(b3, '/v1/store/google/rtdn', { message: { data: rtdn(playSub(2)), messageId: 'm' } }, auth);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: { code: 'not_configured' } });
      expect(spy.seen).toEqual([]);
      await new Promise<void>((done) => s3.close(() => done()));
    });
  });

  describe('App Store notifications', () => {
    let server: Server;
    let base: string;
    let spy = spyNotifications();

    beforeAll(() => {
      spy = spyNotifications();
      const started = serve(
        storeHookRoutes({ notifications: spy.service, appleAnchors: [ROOT_CERT_PEM], appleBundleId: 'com.multiware.saathi', appleEnvironment: 'production' }),
      );
      server = started.server;
      base = started.base;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    beforeEach(() => void (spy.seen.length = 0));

    it('acts on a notification Apple signed', async () => {
      const r = await post(base, '/v1/store/apple/notifications', { signedPayload: await appleNotification('DID_RENEW', { uuid: 'apple-1' }) });
      expect(r.status).toBe(200);
      expect(spy.seen[0]).toMatchObject({ provider: 'app_store', eventId: 'apple-1', notificationType: 'DID_RENEW', notice: 'renewed', originalTransactionId: '1000000999' });
    });

    it('refuses a forged notification and reads nothing out of it', async () => {
      const forged = await appleNotification('REFUND', { uuid: 'apple-forged', x5c: ROGUE_X5C, key: ROGUE_LEAF_KEY_PKCS8 });
      expect((await post(base, '/v1/store/apple/notifications', { signedPayload: forged })).status).toBe(401);
      expect(spy.seen).toEqual([]);
    });

    it('refuses a genuine notification carrying an inner payload somebody swapped', async () => {
      const mixed = await appleNotification('REFUND', { uuid: 'apple-mixed', innerKey: ROGUE_LEAF_KEY_PKCS8 });
      expect((await post(base, '/v1/store/apple/notifications', { signedPayload: mixed })).status).toBe(401);
      expect(spy.seen).toEqual([]);
    });

    it('ignores a sandbox notification and another app\'s notification', async () => {
      const sandbox = await post(base, '/v1/store/apple/notifications', { signedPayload: await appleNotification('DID_RENEW', { uuid: 'a-sb', environment: 'Sandbox' }) });
      expect(sandbox.status).toBe(200);
      expect(await sandbox.json()).toMatchObject({ ignored: 'environment' });
      const other = await post(base, '/v1/store/apple/notifications', { signedPayload: await appleNotification('DID_RENEW', { uuid: 'a-other', bundleId: 'com.someone.else' }) });
      expect(await other.json()).toMatchObject({ ignored: 'bundle' });
      expect(spy.seen).toEqual([]);
    });

    it('refuses a body that is not a signed payload at all', async () => {
      expect((await post(base, '/v1/store/apple/notifications', { signedPayload: 'nonsense-but-long-enough' })).status).toBe(401);
      expect((await post(base, '/v1/store/apple/notifications', {})).status).toBe(400);
    });

    it('refuses everything with no Apple root configured, which is where Saathi is today', async () => {
      const { server: s2, base: b2 } = serve(storeHookRoutes({ notifications: spy.service, appleAnchors: [], appleBundleId: 'com.multiware.saathi' }));
      const r = await post(b2, '/v1/store/apple/notifications', { signedPayload: await appleNotification('DID_RENEW') });
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: { code: 'not_configured' } });
      expect(spy.seen).toEqual([]);
      await new Promise<void>((done) => s2.close(() => done()));
    });
  });
});
