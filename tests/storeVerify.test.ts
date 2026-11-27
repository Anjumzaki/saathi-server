import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../src/middleware/auth';
import { errorHandler, notFoundHandler } from '../src/middleware/error';
import { signAccessToken } from '../src/services/tokens';
import type { PushNotice, PushService } from '../src/services/push';

const HER = '507f1f77bcf86cd799439011';
const SOMEONE_ELSE = '507f1f77bcf86cd799439012';
const EXPIRY = '2027-01-15T10:00:00.000Z';

type Sub = Record<string, unknown> | null;

/**
 * The account rows and the order things happened in. This suite has no database: what it is really testing
 * is the order of events on the money path, which is invisible once Mongo is in the way.
 */
const db = vi.hoisted(() => ({
  users: new Map<string, { _id: string; roles: string[]; subscription: Record<string, unknown> | null }>(),
  steps: [] as string[],
}));

vi.mock('../src/models/User', () => ({
  ROLES: ['client', 'dietitian', 'partner', 'admin', 'saathi_dietitian'],
  User: {
    findById: (id: string) => {
      const u = db.users.get(String(id)) ?? null;
      const chain = { select: () => chain, lean: async () => u, then: (f: (v: unknown) => unknown) => Promise.resolve(u).then(f) };
      return chain;
    },
    exists: async (q: Record<string, unknown>) => {
      const token = q['subscription.purchaseToken'];
      const not = (q['_id'] as { $ne?: string } | undefined)?.$ne;
      for (const [id, u] of db.users) {
        if (not && String(id) === String(not)) continue;
        if ((u.subscription as { purchaseToken?: string } | null)?.purchaseToken === token) return { _id: id };
      }
      return null;
    },
    findByIdAndUpdate: async (id: string, patch: { $set: { subscription: Record<string, unknown> } }) => {
      const u = db.users.get(String(id));
      if (!u) return null;
      u.subscription = patch.$set.subscription;
      db.steps.push('entitlement saved');
      return u;
    },
  },
}));

vi.mock('../src/services/packageCatalogue', () => ({
  getPaidPackages: async () => [],
  tierOfProduct: (_pkgs: unknown, productId: string) =>
    productId === 'saathi_premium_monthly'
      ? { tier: 'premium', plan: 'monthly' }
      : productId === 'saathi_plus_yearly'
        ? { tier: 'plus', plan: 'yearly' }
        : null,
}));

vi.mock('../src/models/PartnerShare', () => ({
  VIEWER_STATUSES: ['active', 'paused'],
  PartnerShare: { findOne: async () => null },
  previewEndsAtForViewer: async () => null,
}));

import { subscriptionRoutes } from '../src/routes/subscription';
import { GooglePlayBilling } from '../src/services/playBilling';
import { AppStoreServerBilling } from '../src/services/appStore';

const subBody = (over: Record<string, unknown> = {}) => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.3301-1234',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  lineItems: [{ productId: 'saathi_premium_monthly', expiryTime: EXPIRY, autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { offerTags: [] as string[] } }],
  ...over,
});

const appleJws = (payload: unknown): string =>
  `${Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;

const appleTx = (over: Record<string, unknown> = {}) => ({
  transactionId: '2000000111',
  originalTransactionId: '1000000999',
  productId: 'saathi_premium_monthly',
  bundleId: 'com.multiware.saathi',
  environment: 'Production',
  type: 'Auto-Renewable Subscription',
  expiresDate: new Date(EXPIRY).getTime(),
  ...over,
});

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

describe('the verify endpoints, against a store that answers like Google and Apple', () => {
  const push = spyPush();
  let server: Server;
  let base: string;
  /** What the fake Play API should answer for a GET of a purchase. */
  let play: { status: number; body: unknown } = { status: 200, body: subBody() };
  /** What a fake App Store should answer. */
  let apple: { status: number; body: unknown } = { status: 404, body: null };

  beforeAll(() => {
    const playBilling = new GooglePlayBilling({
      production: true,
      packageName: 'com.multiware.saathi',
      http: {
        async call(method, path) {
          if (path.includes(':acknowledge')) {
            db.steps.push('acknowledged with Google');
            return { status: 200, body: null };
          }
          void method;
          return play;
        },
      },
    });
    const appStoreBilling = new AppStoreServerBilling({
      bundleId: 'com.multiware.saathi',
      environment: 'production',
      http: { async call() { return apple; } },
    });
    const app = express();
    app.use(express.json());
    app.use('/v1/subscription', requireAuth, subscriptionRoutes({ playBilling, appStoreBilling } as never, { push }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    push.calls.length = 0;
    db.steps.length = 0;
    db.users.clear();
    db.users.set(HER, { _id: HER, roles: ['client'], subscription: { status: 'none' } });
    play = { status: 200, body: subBody() };
    apple = { status: 404, body: null };
  });

  const token = (userId: string) => signAccessToken(userId, ['client']);
  async function call(path: string, userId: string, body: unknown) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token(userId)}` },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }
  const verifyPlay = (productId: string, purchaseToken: string, userId = HER) =>
    call('/v1/subscription/google-play/verify', userId, { productId, purchaseToken });
  const subOf = (userId: string) => db.users.get(userId)!.subscription as Record<string, unknown>;

  it('grants the tier the product id belongs to', async () => {
    const r = await verifyPlay('saathi_premium_monthly', 'tok-1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isPremium: true, subscription: { tier: 'premium', status: 'active', plan: 'monthly' } });
    expect(subOf(HER)).toMatchObject({ tier: 'premium', status: 'active', source: 'google_play', purchaseToken: 'tok-1', playOrderId: 'GPA.3301-1234' });
  });

  it('grants Premium Plus for a Plus product, from the catalogue and not from the token', async () => {
    play = { status: 200, body: subBody({ lineItems: [{ productId: 'saathi_plus_yearly', expiryTime: EXPIRY, autoRenewingPlan: { autoRenewEnabled: true } }] }) };
    const r = await verifyPlay('saathi_plus_yearly', 'tok-plus');
    expect(r.body).toMatchObject({ subscription: { tier: 'plus', plan: 'yearly' } });
    // Premium Plus opens the two features Premium does not.
    expect(r.body.subscription['features']).toContain('representative_help');
  });

  it('acknowledges the purchase with Google only after the entitlement is stored', async () => {
    await verifyPlay('saathi_premium_monthly', 'tok-1');
    expect(db.steps).toEqual(['entitlement saved', 'acknowledged with Google']);
  });

  it('still answers her purchase when the acknowledgement fails', async () => {
    const playBilling = new GooglePlayBilling({
      production: true,
      packageName: 'com.multiware.saathi',
      http: { async call(_m, path) { return path.includes(':acknowledge') ? { status: 500, body: null } : { status: 200, body: subBody() }; } },
    });
    const app = express();
    app.use(express.json());
    app.use('/v1/subscription', requireAuth, subscriptionRoutes({ playBilling, appStoreBilling: playBilling } as never, { push }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    const s2 = app.listen(0);
    const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    const r = await fetch(`${b2}/v1/subscription/google-play/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token(HER)}` },
      body: JSON.stringify({ productId: 'saathi_premium_monthly', purchaseToken: 'tok-1' }),
    });
    expect(r.status).toBe(200);
    expect(subOf(HER)).toMatchObject({ status: 'active' });
    await new Promise<void>((done) => s2.close(() => done()));
  });

  it('refuses a token Google has never heard of, and does not tell her about a payment problem', async () => {
    play = { status: 404, body: { error: { message: 'not found' } } };
    const r = await verifyPlay('saathi_premium_monthly', 'forged-or-made-up');
    expect(r.status).toBe(400);
    expect(r.body['error']).toMatchObject({ code: 'bad_request', details: { reason: 'not_found' } });
    expect(push.calls).toEqual([]);
    expect(subOf(HER)).toMatchObject({ status: 'none' });
  });

  it('refuses a stub token outright: nothing about "stub_valid" is a purchase here', async () => {
    play = { status: 404, body: null };
    expect((await verifyPlay('saathi_premium_monthly', 'stub_valid_1')).status).toBe(400);
    expect(subOf(HER)).toMatchObject({ status: 'none' });
  });

  it('tells her when it really is the payment, and only then', async () => {
    play = { status: 200, body: subBody({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }) };
    const r = await verifyPlay('saathi_premium_monthly', 'tok-1');
    expect(r.status).toBe(400);
    expect(push.calls).toEqual([{ type: 'subscription', event: 'payment_problem' }]);
  });

  it('refuses a Play Console test purchase on a production server', async () => {
    play = { status: 200, body: subBody({ testPurchase: {} }) };
    const r = await verifyPlay('saathi_premium_monthly', 'tok-test');
    expect(r.status).toBe(400);
    expect(r.body['error']).toMatchObject({ details: { reason: 'environment' } });
    expect(push.calls).toEqual([]);
    expect(subOf(HER)).toMatchObject({ status: 'none' });
  });

  it('refuses a sandbox App Store receipt on a production server', async () => {
    apple = {
      status: 200,
      body: { data: [{ lastTransactions: [{ originalTransactionId: '1000000999', status: 1, signedTransactionInfo: appleJws(appleTx({ environment: 'Sandbox' })), signedRenewalInfo: appleJws({ autoRenewStatus: 1 }) }] }] },
    };
    const r = await call('/v1/subscription/app-store/verify', HER, { productId: 'saathi_premium_monthly', transactionId: '1000000999' });
    expect(r.status).toBe(400);
    expect(r.body['error']).toMatchObject({ details: { reason: 'environment' } });
    expect(subOf(HER)).toMatchObject({ status: 'none' });
    // The identical receipt from the production environment is granted, so this is the environment and nothing else.
    apple = {
      status: 200,
      body: { data: [{ lastTransactions: [{ originalTransactionId: '1000000999', status: 1, signedTransactionInfo: appleJws(appleTx()), signedRenewalInfo: appleJws({ autoRenewStatus: 1 }) }] }] },
    };
    const ok = await call('/v1/subscription/app-store/verify', HER, { productId: 'saathi_premium_monthly', transactionId: '1000000999' });
    expect(ok.status).toBe(200);
    expect(subOf(HER)).toMatchObject({ status: 'active', source: 'app_store', purchaseToken: '1000000999' });
  });

  it('follows an upgrade onto the new token, replacing the subscription it names', async () => {
    db.users.set(HER, { _id: HER, roles: ['client'], subscription: { status: 'active', tier: 'premium', plan: 'monthly', purchaseToken: 'old-token', expiresAt: new Date(EXPIRY) } });
    play = {
      status: 200,
      body: subBody({ linkedPurchaseToken: 'old-token', lineItems: [{ productId: 'saathi_plus_yearly', expiryTime: EXPIRY, autoRenewingPlan: { autoRenewEnabled: true } }] }),
    };
    const r = await verifyPlay('saathi_plus_yearly', 'new-token');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ subscription: { tier: 'plus' } });
    expect(subOf(HER)).toMatchObject({ purchaseToken: 'new-token', tier: 'plus' });
  });

  it('refuses an upgrade that replaces somebody else\'s subscription', async () => {
    db.users.set(SOMEONE_ELSE, { _id: SOMEONE_ELSE, roles: ['client'], subscription: { status: 'active', purchaseToken: 'her-friends-token' } });
    play = { status: 200, body: subBody({ linkedPurchaseToken: 'her-friends-token' }) };
    const r = await verifyPlay('saathi_premium_monthly', 'new-token');
    expect(r.status).toBe(409);
    expect(r.body['error']).toMatchObject({ code: 'purchase_token_in_use' });
    expect(subOf(HER)).toMatchObject({ status: 'none' });
  });

  it('still refuses a token already linked to another account', async () => {
    db.users.set(SOMEONE_ELSE, { _id: SOMEONE_ELSE, roles: ['client'], subscription: { status: 'active', purchaseToken: 'tok-1' } });
    expect((await verifyPlay('saathi_premium_monthly', 'tok-1')).status).toBe(409);
  });

  it('refuses a product the catalogue does not sell, before asking the store anything', async () => {
    const r = await verifyPlay('com.someone.else.premium', 'tok-1');
    expect(r.status).toBe(400);
    expect(r.body['error']).toMatchObject({ message: 'Unknown Premium product' });
  });

  it('holds the paid-only discounts back during a free trial', async () => {
    play = {
      status: 200,
      body: subBody({ lineItems: [{ productId: 'saathi_premium_monthly', expiryTime: EXPIRY, autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { offerId: 'free-trial-7d', offerTags: ['trial'] } }] }),
    };
    const r = await verifyPlay('saathi_premium_monthly', 'tok-trial');
    expect(r.body).toMatchObject({ subscription: { status: 'trialing', tier: 'premium' } });
    expect(r.body.subscription['features']).not.toContain('dietitian_discount');
    expect(r.body.subscription['features']).not.toContain('merchant_discount');
    expect(r.body.subscription['features']).toContain('guided_routines');
  });
});
