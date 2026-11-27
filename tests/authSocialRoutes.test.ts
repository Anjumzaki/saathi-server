import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler, notFoundHandler } from '../src/middleware/error';
import { authRoutes } from '../src/routes/auth';
import type { IdTokenVerifier, Services, SmsProvider, VerifiedIdentity } from '../src/interfaces';
import { signAccessToken } from '../src/services/tokens';
import { SMS_LIMITS, checkSmsQuota } from '../src/services/otpLogic';
import { createSmsQuota } from '../src/services/sms';
import { UnavailableSms } from '../src/services/sms';

const HER = '507f1f77bcf86cd799439011';

interface Row {
  _id: string;
  email?: string | null;
  displayName?: string | null;
  googleSub?: string | null;
  appleSub?: string | null;
  passwordHash?: string | null;
  emailVerifiedAt?: Date | null;
  termsAcceptedAt?: Date | null;
  phone?: string | null;
  phoneVerified?: boolean;
  deletedAt?: Date | null;
  roles: string[];
  saved: number;
}

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], nextId: 1 }));

/** Just enough of a mongoose document for these routes: get/set, save, and fields read by serializeUser. */
const doc = (row: Record<string, unknown>) => ({
  ...row,
  get(k: string) { return row[k]; },
  set(k: string, v: unknown) { row[k] = v; (this as Record<string, unknown>)[k] = v; },
  async save() {
    for (const k of Object.keys(this as object)) {
      if (typeof (this as Record<string, unknown>)[k] !== 'function') row[k] = (this as Record<string, unknown>)[k];
    }
    row.saved = ((row.saved as number) ?? 0) + 1;
  },
});

vi.mock('../src/models/User', () => ({
  ROLES: ['client', 'dietitian', 'saathi_dietitian', 'partner', 'admin'],
  User: {
    findOne: (q: Record<string, unknown>) => {
      const match = db.rows.find((r) =>
        Object.entries(q).every(([k, v]) => (v === null ? (r[k] ?? null) === null : r[k] === v)));
      const found = match ? doc(match) : null;
      const chain = { select: () => chain, then: (f: (v: unknown) => unknown) => Promise.resolve(found).then(f) };
      return chain;
    },
    findById: (id: string) => {
      const match = db.rows.find((r) => r._id === String(id));
      const found = match ? doc(match) : null;
      const chain = { select: () => chain, then: (f: (v: unknown) => unknown) => Promise.resolve(found).then(f) };
      return chain;
    },
    async create(obj: Record<string, unknown>) {
      const row = { _id: `507f1f77bcf86cd79943${String(db.nextId++).padStart(4, '0')}`, roles: ['client'], saved: 0, ...obj };
      db.rows.push(row);
      return doc(row);
    },
  },
}));

vi.mock('../src/models/RefreshToken', () => ({ RefreshToken: { create: async () => ({}), updateMany: async () => ({}) } }));

/** The code machinery itself is tested in otp.test.ts; here it only has to be counted. */
const otp = vi.hoisted(() => ({ issued: [] as string[], code: '123456' }));
vi.mock('../src/services/otp', () => ({
  issueOtp: async (key: string) => { otp.issued.push(key); return { code: otp.code, resendAfterSeconds: 60 }; },
  checkOtp: async () => undefined,
}));



/** A verifier that hands back whatever identity the test wants, standing in for Google or Apple. */
function fakeVerifier(provider: 'google' | 'apple') {
  const state = { identity: null as VerifiedIdentity | null, lastOpts: undefined as unknown, configured: true };
  const verifier: IdTokenVerifier = {
    get configured() { return state.configured; },
    async verify(_token, opts) {
      state.lastOpts = opts;
      if (!state.identity) throw new Error('no identity set');
      return state.identity;
    },
  };
  return { verifier, state, provider };
}

function fakeSms() {
  const sent: { to: string; text: string }[] = [];
  const state = { available: true };
  const sms: SmsProvider = {
    get available() { return state.available; },
    async send(m) { sent.push(m); },
  };
  return { sms, sent, state };
}

const google = fakeVerifier('google');
const apple = fakeVerifier('apple');
const sms = fakeSms();

describe('social sign-in and phone verification over HTTP', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    const app = express();
    app.use(express.json());
    const services = {
      googleVerifier: google.verifier,
      appleVerifier: apple.verifier,
      sms: sms.sms,
      mailer: { send: async () => undefined },
    } as unknown as Services;
    app.use('/auth', authRoutes(services));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    db.rows.length = 0;
    db.nextId = 1;
    otp.issued.length = 0;
    sms.sent.length = 0;
    sms.state.available = true;
    google.state.identity = null;
    apple.state.identity = null;
  });

  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, never> & { error?: { code?: string; message?: string } } };
  };
  const passwordAccount = (over: Partial<Row> = {}) => {
    const row = { _id: HER, email: 'anjum@gmail.com', passwordHash: 'scrypt$x$x', displayName: 'Anjum', emailVerifiedAt: new Date('2026-01-01'), termsAcceptedAt: new Date('2026-01-01'), roles: ['client'], saved: 0, deletedAt: null, phoneVerified: false, ...over };
    db.rows.push(row as unknown as Record<string, unknown>);
    return row;
  };

  it('creates an account on a first Google sign-in, with the verified address already confirmed', async () => {
    google.state.identity = { provider: 'google', subject: 'g-1', email: 'new@gmail.com', emailVerified: true, name: 'Anjum' };
    const r = await post('/auth/google', { idToken: 'x', nonce: 'nonce-12345' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isNewUser: true, user: { email: 'new@gmail.com', emailVerified: true, displayName: 'Anjum' } });
    expect(db.rows[0]).toMatchObject({ googleSub: 'g-1', email: 'new@gmail.com' });
    // The nonce the app declared is handed to the verifier, not checked in the route.
    expect(google.state.lastOpts).toMatchObject({ nonce: 'nonce-12345' });
  });

  it('joins a verified Google address to the password account that already has it, and keeps the password', async () => {
    const row = passwordAccount();
    google.state.identity = { provider: 'google', subject: 'g-1', email: 'anjum@gmail.com', emailVerified: true, name: 'Anjum' };
    const r = await post('/auth/google', { idToken: 'x' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isNewUser: false, user: { id: HER } });
    expect(db.rows).toHaveLength(1); // no second account
    expect(row.googleSub).toBe('g-1');
    expect(row.passwordHash).toBe('scrypt$x$x');
  });

  it('never joins on an address the provider has not verified: that would be a way in from a forged claim', async () => {
    passwordAccount();
    google.state.identity = { provider: 'google', subject: 'g-2', email: 'anjum@gmail.com', emailVerified: false };
    const r = await post('/auth/google', { idToken: 'x' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isNewUser: true });
    expect(db.rows).toHaveLength(2);
    // The new account keeps no address at all, rather than an unproven one.
    expect(db.rows[1]).toMatchObject({ googleSub: 'g-2', emailVerifiedAt: null });
    expect(db.rows[1]!.email).toBeUndefined();
  });

  it('refuses to move a link that another provider account already holds', async () => {
    passwordAccount({ googleSub: 'g-already-here' });
    google.state.identity = { provider: 'google', subject: 'g-someone-else', email: 'anjum@gmail.com', emailVerified: true };
    const r = await post('/auth/google', { idToken: 'x' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { code: 'email_in_use' } });
  });

  it('confirms the address of a sign-up she abandoned before entering the emailed code', async () => {
    const row = passwordAccount({ emailVerifiedAt: null });
    google.state.identity = { provider: 'google', subject: 'g-1', email: 'anjum@gmail.com', emailVerified: true };
    const r = await post('/auth/google', { idToken: 'x' });
    expect(r.status).toBe(200);
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('signs a returning Apple user in by subject alone, because Apple sends no address the second time', async () => {
    const row = passwordAccount({ email: null, passwordHash: null, appleSub: 'a-1', displayName: 'Anjum' });
    apple.state.identity = { provider: 'apple', subject: 'a-1', emailVerified: false };
    const r = await post('/auth/apple', { idToken: 'x' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isNewUser: false, user: { id: HER, email: null } });
    expect(db.rows).toHaveLength(1);
    expect(row.appleSub).toBe('a-1');
  });

  it('takes the name Apple gives once, and only for an account that has none', async () => {
    apple.state.identity = { provider: 'apple', subject: 'a-new', email: 'kj8@privaterelay.appleid.com', emailVerified: true, name: 'Anjum Shahid' };
    const made = await post('/auth/apple', { idToken: 'x', fullName: 'Anjum Shahid' });
    expect(made.body).toMatchObject({ user: { displayName: 'Anjum Shahid', email: 'kj8@privaterelay.appleid.com' } });
    expect(apple.state.lastOpts).toMatchObject({ fullName: 'Anjum Shahid' });
  });

  it('ignores an email the client sends: only the token decides who she is', async () => {
    passwordAccount();
    google.state.identity = { provider: 'google', subject: 'g-stranger', emailVerified: false };
    const r = await post('/auth/google', { idToken: 'x', email: 'anjum@gmail.com' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isNewUser: true });
    expect(db.rows).toHaveLength(2);
    expect(db.rows[1]!.email).toBeUndefined();
  });

  it('refuses a deleted account rather than reviving it', async () => {
    passwordAccount({ googleSub: 'g-1', deletedAt: new Date('2026-06-01') });
    google.state.identity = { provider: 'google', subject: 'g-1', email: 'anjum@gmail.com', emailVerified: true };
    const r = await post('/auth/google', { idToken: 'x' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: 'account_deleted' } });
  });

  describe('phone verification', () => {
    // The counters live in the router for the life of the process, exactly as they do on the server, so
    // each of these tests signs in as its own account and texts its own numbers.
    const token = (id = HER) => signAccessToken(id, ['client']);

    it('sends a code and confirms the number', async () => {
      passwordAccount();
      const asked = await post('/auth/phone/request', { phone: '+923001234567' }, token());
      expect(asked.status).toBe(200);
      expect(sms.sent).toEqual([{ to: '+923001234567', text: 'Your Saathi verification code is 123456. It expires in 10 minutes.' }]);
      const done = await post('/auth/phone/verify', { phone: '+923001234567', code: '123456' }, token());
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ user: { phone: '+923001234567', phoneVerified: true } });
    });

    it('says plainly that it is not available, and issues no code, when there is no SMS account', async () => {
      passwordAccount();
      sms.state.available = false;
      const r = await post('/auth/phone/request', { phone: '+923001234567' }, token());
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: { code: 'sms_unavailable' } });
      expect(r.body.error?.message).toMatch(/Everything else in Saathi works without it/);
      // Nothing was issued, so her code slot and the one-minute wait are untouched.
      expect(otp.issued).toEqual([]);
      expect(sms.sent).toEqual([]);
    });

    it('stops at three texts to one number in an hour, without saying whether the number is known', async () => {
      const her = '507f1f77bcf86cd7994390a1';
      passwordAccount({ _id: her, email: 'number-cap@gmail.com' });
      for (let i = 0; i < SMS_LIMITS.perNumberPerHour; i++) {
        expect((await post('/auth/phone/request', { phone: '+923009990000' }, token(her))).status).toBe(200);
      }
      const blocked = await post('/auth/phone/request', { phone: '+923009990000' }, token(her));
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ error: { code: 'too_many_requests' } });
      expect(blocked.body.error?.message).toBe('Too many codes have been sent. Please try again later.');
      expect(sms.sent).toHaveLength(SMS_LIMITS.perNumberPerHour);
    });

    it('stops one account texting number after number', async () => {
      const her = '507f1f77bcf86cd7994390a2';
      passwordAccount({ _id: her, email: 'account-cap@gmail.com' });
      let sentOk = 0;
      for (let i = 0; i < SMS_LIMITS.perAccountPerHour + 2; i++) {
        const r = await post('/auth/phone/request', { phone: `+92300100000${i}` }, token(her));
        if (r.status === 200) sentOk++;
      }
      expect(sentOk).toBe(SMS_LIMITS.perAccountPerHour);
    });
  });
});

describe('the SMS quota itself', () => {
  const t0 = new Date('2026-11-27T10:00:00Z').getTime();
  const HOUR = 3_600_000;

  it('allows nothing beyond the hourly cap, then frees up as the oldest send ages out', () => {
    const sent = [t0, t0 + 1000, t0 + 2000];
    const blocked = checkSmsQuota(sent, [], t0 + 3000);
    expect(blocked).toMatchObject({ allowed: false, scope: 'number' });
    expect((blocked as { retryAfterSeconds: number }).retryAfterSeconds).toBe(3597);
    expect(checkSmsQuota(sent, [], t0 + HOUR + 1)).toEqual({ allowed: true });
  });

  it('holds a number to five texts a day even when they are spread out', () => {
    const spread = [0, 1, 2, 3, 4].map((h) => t0 + h * 2 * HOUR);
    expect(checkSmsQuota(spread, [], t0 + 9 * HOUR)).toMatchObject({ allowed: false, scope: 'number' });
    expect(checkSmsQuota(spread.slice(1), [], t0 + 9 * HOUR)).toEqual({ allowed: true });
  });

  it('blames the account when it is the account that is over', () => {
    const account = Array.from({ length: SMS_LIMITS.perAccountPerHour }, (_, i) => t0 + i * 1000);
    expect(checkSmsQuota([], account, t0 + 6000)).toMatchObject({ allowed: false, scope: 'account' });
  });

  it('counts per number and per account separately, and forgets yesterday', () => {
    const q = createSmsQuota();
    for (let i = 0; i < SMS_LIMITS.perNumberPerHour; i++) q.record('+10000000001', 'her', t0 + i);
    expect(q.check('+10000000001', 'her', t0 + 10)).toMatchObject({ allowed: false, scope: 'number' });
    // A different number is a different count, until the account cap is reached.
    expect(q.check('+10000000002', 'her', t0 + 10)).toEqual({ allowed: true });
    // A day later nothing is remembered.
    expect(q.check('+10000000001', 'her', t0 + 25 * HOUR)).toEqual({ allowed: true });
  });
});

describe('sms with no credentials', () => {
  it('is unavailable and refuses every send', async () => {
    const sms = new UnavailableSms();
    expect(sms.available).toBe(false);
    await expect(sms.send()).rejects.toThrow(/not available yet/);
  });
});
