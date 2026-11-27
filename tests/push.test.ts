import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../src/middleware/auth';
import { errorHandler, notFoundHandler } from '../src/middleware/error';
import {
  NOTICE_REPEAT_MS,
  PushChannels,
  SUBSCRIPTION_EVENTS,
  TRIAL_NOTICE_HOURS,
  buildPushMessage,
  createPushService,
  firebaseCredentials,
  firebaseTransport,
  subscriptionNoticeFor,
  trialEndingDue,
  type DeviceTokenStore,
  type PushNotice,
  type PushService,
  type PushTarget,
  type PushTransport,
} from '../src/services/push';
import { pushRoutes } from '../src/routes/push';
import { threadRoutes } from '../src/routes/threads';
import { partnerRoutes } from '../src/routes/partner';
import { subscriptionRoutes } from '../src/routes/subscription';
import { createMemoryThreadStore } from '../src/services/threadStore';
import { signAccessToken } from '../src/services/tokens';
import { paymentRequired } from '../src/utils/errors';

const HER = '507f1f77bcf86cd799439011';
const DIETITIAN = '507f1f77bcf86cd799439012';
const PARTNER = '507f1f77bcf86cd799439013';
const ORDER = '507f1f77bcf86cd79943a001';
const SHARE = '507f1f77bcf86cd79943b001';

/** The account rows the partner and subscription routes read, stood up in memory: this suite has no database. */
const db = vi.hoisted(() => ({
  users: new Map<string, { _id: string; roles: string[]; subscription: unknown; save?: () => Promise<void> }>(),
  share: null as Record<string, unknown> | null,
  cheers: [] as { toUserId: string }[],
}));

vi.mock('../src/models/User', () => ({
  ROLES: ['client', 'dietitian', 'partner', 'admin', 'saathi_dietitian'],
  User: {
    findById: (id: string) => {
      const u = db.users.get(String(id)) ?? null;
      const chain = { select: () => chain, lean: async () => u, then: (f: (v: unknown) => unknown) => Promise.resolve(u).then(f) };
      return chain;
    },
    exists: async () => null,
    findByIdAndUpdate: async (id: string, patch: { $set: { subscription: unknown } }) => {
      const u = db.users.get(String(id));
      if (!u) return null;
      u.subscription = patch.$set.subscription;
      return u;
    },
  },
}));

vi.mock('../src/services/packageCatalogue', () => ({
  getPaidPackages: async () => [],
  tierOfProduct: (_packages: unknown, productId: string) =>
    productId === 'saathi_premium_monthly' ? { tier: 'premium', plan: 'monthly' } : null,
}));

vi.mock('../src/models/PartnerShare', () => ({
  VIEWER_STATUSES: ['active', 'paused'],
  PartnerShare: {
    findOne: async () => db.share,
    updateOne: async () => ({ modifiedCount: 1 }),
    find: async () => [],
  },
  Cheer: { create: async (c: { toUserId: string }) => void db.cheers.push(c), find: async () => [] },
  previewEndsAtForViewer: async () => null,
  earliestPreviewEndsAtForViewer: async () => null,
}));

/** Remembers what was sent, and can play FCM saying a phone is gone. */
function fakeTransport() {
  const sent: { targets: PushTarget[]; message: ReturnType<typeof buildPushMessage> }[] = [];
  let gone: string[] = [];
  const transport: PushTransport = {
    async send(targets, message) {
      sent.push({ targets, message });
      return { unregistered: targets.filter((t) => gone.includes(t.token)).map((t) => t.token) };
    },
  };
  return { transport, sent, setGone: (t: string[]) => { gone = t; } };
}

function memoryTokens() {
  const rows: { userId: string; token: string; platform: 'android' | 'ios'; appVersion: string }[] = [];
  const store: DeviceTokenStore = {
    async tokensFor(userId) {
      return rows.filter((r) => r.userId === userId).map((r) => ({ token: r.token, platform: r.platform }));
    },
    async save({ userId, token, platform, appVersion }) {
      const at = rows.findIndex((r) => r.token === token);
      const row = { userId, token, platform, appVersion };
      if (at >= 0) rows[at] = row; else rows.push(row);
    },
    async forget(userId, token) {
      const at = rows.findIndex((r) => r.userId === userId && r.token === token);
      if (at >= 0) rows.splice(at, 1);
    },
    async drop(tokens) {
      for (const t of tokens) {
        const at = rows.findIndex((r) => r.token === t);
        if (at >= 0) rows.splice(at, 1);
      }
    },
  };
  return { store, rows };
}

/** Records the hooks without sending anything, so a route test can see exactly who would be told. */
function spyPush(): PushService & { calls: { userId: string; notice: PushNotice; once: boolean }[] } {
  const calls: { userId: string; notice: PushNotice; once: boolean }[] = [];
  return {
    calls,
    configured: true,
    async register() {},
    async unregister() {},
    notify: (userId, notice) => void calls.push({ userId, notice, once: false }),
    notifyOnce: (userId, notice) => void calls.push({ userId, notice, once: true }),
    deliver: async () => ({ sent: 0, dropped: [] }),
  };
}

describe('what a push is allowed to say', () => {
  const notices: PushNotice[] = [
    { type: 'chat_message', threadId: ORDER, threadKind: 'order', orderId: ORDER },
    { type: 'chat_message', threadId: SHARE, threadKind: 'representative' },
    { type: 'partner_cheer' },
    ...SUBSCRIPTION_EVENTS.map((event) => ({ type: 'subscription', event }) as PushNotice),
  ];

  it('carries a type and a title and nothing private', () => {
    for (const n of notices) {
      const m = buildPushMessage(n);
      // No body at all: the words are fetched in the app, never put on a lock screen or through Google.
      expect(Object.keys(m)).toEqual(['title', 'channelId', 'data', 'collapseKey']);
      expect(m.title.length).toBeGreaterThan(0);
      // Ids and enums only. A free-text key here is the bug this test exists to catch.
      expect(Object.keys(m.data).every((k) => ['type', 'threadId', 'threadKind', 'orderId', 'event'].includes(k))).toBe(true);
      expect(Object.values(m.data).every((v) => typeof v === 'string')).toBe(true);
      // No key that could ever hold what she ate, where she is in her cycle, or words anyone typed.
      expect(Object.keys(m.data).some((k) => /body|text|emoji|meal|cycle|weight|name|phone|email/i.test(k))).toBe(false);
      expect(m).not.toHaveProperty('body');
    }
  });

  it('uses the channels the phone already has', () => {
    expect(buildPushMessage({ type: 'chat_message', threadId: ORDER, threadKind: 'order' }).channelId).toBe(PushChannels.ACCOUNT);
    expect(buildPushMessage({ type: 'partner_cheer' }).channelId).toBe(PushChannels.TOGETHER);
    expect(buildPushMessage({ type: 'subscription', event: 'trial_ending' }).channelId).toBe(PushChannels.ACCOUNT);
  });

  it('collapses a storm of messages on one thread into one notification', () => {
    expect(buildPushMessage({ type: 'chat_message', threadId: ORDER, threadKind: 'order' }).collapseKey)
      .toBe(buildPushMessage({ type: 'chat_message', threadId: ORDER, threadKind: 'order' }).collapseKey);
    expect(buildPushMessage({ type: 'chat_message', threadId: SHARE, threadKind: 'representative' }).collapseKey)
      .not.toBe(buildPushMessage({ type: 'chat_message', threadId: ORDER, threadKind: 'order' }).collapseKey);
  });

  it('names a thread but never quotes it', () => {
    const m = buildPushMessage({ type: 'chat_message', threadId: ORDER, threadKind: 'order', orderId: ORDER });
    expect(m.data['threadId']).toBe(ORDER);
    expect(m.data['threadKind']).toBe('order');
    expect(m.data['orderId']).toBe(ORDER);
    expect(m.title).toBe('You have a new message');
  });
});

describe('with no Firebase credentials', () => {
  it('reads no credentials out of an empty environment', () => {
    expect(firebaseCredentials({})).toBeNull();
    expect(firebaseCredentials({ FIREBASE_PROJECT_ID: 'p' })).toBeNull();
    expect(firebaseCredentials({ FIREBASE_SERVICE_ACCOUNT_JSON: 'not json' })).toBeNull();
    expect(firebaseCredentials({ FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}' })).toBeNull();
  });

  it('takes the service-account JSON and unescapes the key', () => {
    const c = firebaseCredentials({
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'p', client_email: 'a@b.c', private_key: '-----A-----\\nkey\\n' }),
    });
    expect(c).toEqual({ projectId: 'p', clientEmail: 'a@b.c', privateKey: '-----A-----\nkey\n' });
  });

  it('builds no transport, and the service logs and no-ops rather than throwing', async () => {
    expect(firebaseTransport({})).toBeNull();
    const { store, rows } = memoryTokens();
    const push = createPushService({ transport: null, tokens: store });
    expect(push.configured).toBe(false);
    await push.register({ userId: HER, token: 'tok-1', platform: 'android' });
    // The token is still kept, so the day Anjum adds the credentials nobody has to re-register.
    expect(rows).toHaveLength(1);
    await expect(push.deliver(HER, { type: 'partner_cheer' })).resolves.toEqual({ sent: 0, dropped: [] });
    expect(() => push.notify(HER, { type: 'partner_cheer' })).not.toThrow();
  });
});

describe('registering a phone', () => {
  it('keeps a row per phone and moves a phone that signs in as someone else', async () => {
    const { store, rows } = memoryTokens();
    const push = createPushService({ transport: null, tokens: store });
    await push.register({ userId: HER, token: 'tok-old', platform: 'android', appVersion: '1.0' });
    await push.register({ userId: HER, token: 'tok-new', platform: 'ios' });
    expect(await store.tokensFor(HER)).toHaveLength(2);
    await push.register({ userId: PARTNER, token: 'tok-new', platform: 'ios' });
    expect(await store.tokensFor(HER)).toEqual([{ token: 'tok-old', platform: 'android' }]);
    expect(await store.tokensFor(PARTNER)).toEqual([{ token: 'tok-new', platform: 'ios' }]);
    expect(rows).toHaveLength(2);
  });

  it('forgets only her row when she signs out, not the phone\'s other account', async () => {
    const { store } = memoryTokens();
    const push = createPushService({ transport: null, tokens: store });
    await push.register({ userId: HER, token: 'tok-1', platform: 'android' });
    await push.unregister(PARTNER, 'tok-1');
    expect(await store.tokensFor(HER)).toHaveLength(1);
    await push.unregister(HER, 'tok-1');
    expect(await store.tokensFor(HER)).toHaveLength(0);
  });
});

describe('sending', () => {
  it('sends to every phone she has', async () => {
    const { store } = memoryTokens();
    const { transport, sent } = fakeTransport();
    const push = createPushService({ transport, tokens: store });
    await push.register({ userId: HER, token: 'a', platform: 'android' });
    await push.register({ userId: HER, token: 'b', platform: 'ios' });
    await push.register({ userId: PARTNER, token: 'c', platform: 'android' });
    const r = await push.deliver(HER, { type: 'partner_cheer' });
    expect(r.sent).toBe(2);
    expect(sent[0]?.targets.map((t) => t.token)).toEqual(['a', 'b']);
  });

  it('drops a token FCM says is no longer registered, and keeps the rest', async () => {
    const { store } = memoryTokens();
    const { transport, setGone } = fakeTransport();
    const push = createPushService({ transport, tokens: store });
    await push.register({ userId: HER, token: 'live', platform: 'android' });
    await push.register({ userId: HER, token: 'dead', platform: 'android' });
    setGone(['dead']);
    const r = await push.deliver(HER, { type: 'partner_cheer' });
    expect(r).toEqual({ sent: 1, dropped: ['dead'] });
    expect(await store.tokensFor(HER)).toEqual([{ token: 'live', platform: 'android' }]);
  });

  it('does not reach the transport when she has no phone registered', async () => {
    const { transport, sent } = fakeTransport();
    const push = createPushService({ transport, tokens: memoryTokens().store });
    expect(await push.deliver(HER, { type: 'partner_cheer' })).toEqual({ sent: 0, dropped: [] });
    expect(sent).toHaveLength(0);
  });

  it('never lets a broken transport reach the caller', async () => {
    const push = createPushService({
      transport: { send: async () => { throw new Error('FCM is down'); } },
      tokens: (await (async () => { const m = memoryTokens(); await m.store.save({ userId: HER, token: 'a', platform: 'android', appVersion: '', now: new Date() }); return m; })()).store,
    });
    expect(() => push.notify(HER, { type: 'partner_cheer' })).not.toThrow();
    await expect(push.deliver(HER, { type: 'partner_cheer' })).rejects.toThrow('FCM is down');
  });

  it('does not repeat a notifyOnce notice inside its window', async () => {
    const { store } = memoryTokens();
    const { transport, sent } = fakeTransport();
    const push = createPushService({ transport, tokens: store });
    await push.register({ userId: HER, token: 'a', platform: 'android' });
    const n: PushNotice = { type: 'subscription', event: 'trial_ending' };
    push.notifyOnce(HER, n);
    push.notifyOnce(HER, n);
    push.notifyOnce(HER, n);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    // A different woman, and a different notice, are not held back by hers.
    push.notifyOnce(PARTNER, n);
    push.notifyOnce(HER, { type: 'subscription', event: 'payment_problem' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(2);
    expect(NOTICE_REPEAT_MS).toBeLessThan(24 * 3_600_000);
  });
});

describe('when she should be told about her subscription', () => {
  const now = new Date('2026-11-27T10:00:00.000Z');
  const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);

  it('warns inside the notice period and not before or after', () => {
    expect(trialEndingDue({ status: 'trialing', trialEndsAt: inHours(TRIAL_NOTICE_HOURS - 1) }, now)).toBe(true);
    expect(trialEndingDue({ status: 'trialing', trialEndsAt: inHours(TRIAL_NOTICE_HOURS + 1) }, now)).toBe(false);
    expect(trialEndingDue({ status: 'trialing', trialEndsAt: inHours(-1) }, now)).toBe(false);
    expect(trialEndingDue({ status: 'active', trialEndsAt: inHours(1) }, now)).toBe(false);
    expect(trialEndingDue({ status: 'trialing' }, now)).toBe(false);
    expect(trialEndingDue(null, now)).toBe(false);
  });

  it('calls a longer period a renewal and a first purchase nothing', () => {
    expect(subscriptionNoticeFor({ expiresAt: inHours(24) }, { expiresAt: inHours(24 * 31) })).toBe('renewed');
    expect(subscriptionNoticeFor(null, { expiresAt: inHours(24 * 31) })).toBeNull();
    expect(subscriptionNoticeFor({ expiresAt: null }, { expiresAt: inHours(24) })).toBeNull();
    expect(subscriptionNoticeFor({ expiresAt: inHours(24 * 31) }, { expiresAt: inHours(24 * 31) })).toBeNull();
  });
});

describe('the endpoints and the three hooks', () => {
  const store = createMemoryThreadStore();
  const orders = new Map<string, { clientId: string; dietitianId: string; status: string }>();
  const push = spyPush();
  const tokens = memoryTokens();
  const registering = createPushService({ transport: null, tokens: tokens.store });
  let server: Server;
  let base: string;

  const billing = {
    valid: true,
    verify: async () => ({ valid: billing.valid, expiresAt: new Date(Date.now() + 31 * 86_400_000), orderId: 'o1' }),
  };

  beforeAll(() => {
    const app = express();
    app.use(express.json());
    app.use('/v1/push', requireAuth, pushRoutes({ push: registering }));
    app.use('/v1/threads', requireAuth, threadRoutes({
      store,
      push,
      order: async (id) => orders.get(id) ?? null,
      phoneOf: async () => null,
      nameOf: async () => 'Dr Sara',
      plusGate: (req, _res, next) => (req.auth!.userId === HER ? next() : next(paymentRequired('Premium Plus required'))),
    }));
    app.use('/v1/partner', requireAuth, partnerRoutes({ push }));
    app.use('/v1/subscription', requireAuth, subscriptionRoutes(
      { playBilling: billing, appStoreBilling: billing } as never,
      { push },
    ));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    push.calls.length = 0;
    db.users.clear();
    db.cheers.length = 0;
    billing.valid = true;
  });

  const tok = (userId: string, roles: string[] = ['client']) => signAccessToken(userId, roles);
  async function call(method: string, path: string, token: string, body?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }

  it('registers and unregisters a phone', async () => {
    const r = await call('POST', '/v1/push/register', tok(HER), { token: 'fcm-token-aaaaaaaa', platform: 'android', appVersion: '1.0' });
    expect(r.status).toBe(200);
    // Honest about itself, so the app does not ask for a permission that would do nothing.
    expect(r.body.push).toBe(false);
    expect(await tokens.store.tokensFor(HER)).toHaveLength(1);
    expect((await call('POST', '/v1/push/unregister', tok(HER), { token: 'fcm-token-aaaaaaaa' })).status).toBe(204);
    expect(await tokens.store.tokensFor(HER)).toHaveLength(0);
  });

  it('refuses a platform it cannot send to, and a token that is not one', async () => {
    expect((await call('POST', '/v1/push/register', tok(HER), { token: 'fcm-token-aaaaaaaa', platform: 'blackberry' })).status).toBe(400);
    expect((await call('POST', '/v1/push/register', tok(HER), { token: 'short', platform: 'android' })).status).toBe(400);
  });

  it('needs her to be signed in', async () => {
    const r = await fetch(`${base}/v1/push/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('hook 1: a new message tells the other side of the thread, and only them', async () => {
    orders.set(ORDER, { clientId: HER, dietitianId: DIETITIAN, status: 'in_progress' });
    const id = (await call('POST', `/v1/threads/order/${ORDER}`, tok(HER))).body.thread.id as string;

    await call('POST', `/v1/threads/${id}/messages`, tok(HER), { text: 'Is rice alright at dinner?' });
    expect(push.calls).toEqual([
      { userId: DIETITIAN, notice: { type: 'chat_message', threadId: id, threadKind: 'order', orderId: ORDER }, once: false },
    ]);

    push.calls.length = 0;
    await call('POST', `/v1/threads/${id}/messages`, tok(DIETITIAN), { text: 'Half a cup is fine.' });
    expect(push.calls).toEqual([
      { userId: HER, notice: { type: 'chat_message', threadId: id, threadKind: 'order', orderId: ORDER }, once: false },
    ]);
  });

  it('hook 1: tells nobody while a Premium Plus thread is still waiting in the queue', async () => {
    const id = (await call('POST', '/v1/threads/representative', tok(HER))).body.thread.id as string;
    const r = await call('POST', `/v1/threads/${id}/messages`, tok(HER), { text: 'Hello, is anyone there?' });
    expect(r.status).toBe(201);
    expect(push.calls).toHaveLength(0);
  });

  it('hook 2: a cheer tells her, and says nothing about who sent it', async () => {
    db.users.set(PARTNER, { _id: PARTNER, roles: ['partner'], subscription: { status: 'active', expiresAt: new Date(Date.now() + 86_400_000) } });
    db.share = {
      _id: SHARE, ownerId: HER, partnerId: PARTNER, status: 'active',
      previewEndsAt: new Date(Date.now() + 86_400_000), lastCheerAt: null, permissions: {},
      save: async () => {},
      set: () => {},
    };
    const r = await call('POST', `/v1/partner/shares/${SHARE}/cheer`, tok(PARTNER), { emoji: '👏' });
    expect(r.status).toBe(201);
    expect(db.cheers).toHaveLength(1);
    expect(push.calls).toEqual([{ userId: HER, notice: { type: 'partner_cheer' }, once: false }]);
  });

  it('hook 3: a renewal is announced, a first purchase is not', async () => {
    db.users.set(HER, { _id: HER, roles: ['client'], subscription: null });
    await call('POST', '/v1/subscription/google-play/verify', tok(HER), { productId: 'saathi_premium_monthly', purchaseToken: 'p1' });
    expect(push.calls).toHaveLength(0);

    // The same phone, a month later: the period has moved forward, which she may not have noticed.
    db.users.set(HER, { _id: HER, roles: ['client'], subscription: { expiresAt: new Date(Date.now() + 86_400_000) } });
    await call('POST', '/v1/subscription/google-play/verify', tok(HER), { productId: 'saathi_premium_monthly', purchaseToken: 'p1' });
    expect(push.calls).toEqual([{ userId: HER, notice: { type: 'subscription', event: 'renewed' }, once: false }]);
  });

  it('hook 3: a payment that cannot be verified is a notice, not a silent lapse', async () => {
    db.users.set(HER, { _id: HER, roles: ['client'], subscription: null });
    billing.valid = false;
    const r = await call('POST', '/v1/subscription/google-play/verify', tok(HER), { productId: 'saathi_premium_monthly', purchaseToken: 'p1' });
    expect(r.status).toBe(400);
    expect(push.calls).toEqual([{ userId: HER, notice: { type: 'subscription', event: 'payment_problem' }, once: false }]);
  });

  it('hook 3: a trial about to end is warned about once, when the app asks what she is entitled to', async () => {
    db.users.set(HER, {
      _id: HER,
      roles: ['client'],
      subscription: { status: 'trialing', tier: 'premium', plan: 'monthly', trialEndsAt: new Date(Date.now() + 3_600_000), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const r = await call('GET', '/v1/subscription', tok(HER));
    expect(r.status).toBe(200);
    expect(push.calls).toEqual([{ userId: HER, notice: { type: 'subscription', event: 'trial_ending' }, once: true }]);
  });

  it('hook 3: says nothing about a subscription with months to run', async () => {
    db.users.set(HER, {
      _id: HER,
      roles: ['client'],
      subscription: { status: 'active', tier: 'premium', plan: 'yearly', expiresAt: new Date(Date.now() + 300 * 86_400_000) },
    });
    expect((await call('GET', '/v1/subscription', tok(HER))).status).toBe(200);
    expect(push.calls).toHaveLength(0);
  });
});
