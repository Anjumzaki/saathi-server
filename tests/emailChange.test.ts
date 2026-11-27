import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeEmail } from '../src/services/emailTemplates';
import { OTP_CONFIG } from '../src/services/otpLogic';
import { emailChangeOtpKey, emailChangeOtpKeyPrefix, emailChangeProblem } from '../src/services/users';

const MINUTES = Math.round(OTP_CONFIG.ttlMs / 60_000);

/**
 * The account and the OTP store stood up in memory, because this suite has no database. The doubles
 * copy only the behaviour the route depends on: one live code per key, and the real error codes.
 */
const db = vi.hoisted(() => ({
  me: {} as Record<string, unknown> & { _id: string; save: () => Promise<void> },
  others: [] as { email: string }[],
  /** key -> the code that would have been emailed, or 'expired' */
  codes: new Map<string, string>(),
  issues: [] as { key: string; code: string }[],
  cooldown: false,
  saveFails11000: false,
}));

vi.mock('../src/models/User', () => ({
  ROLES: ['client', 'dietitian', 'partner', 'admin'],
  User: {
    findById: async (id: string) => (String(db.me._id) === String(id) ? db.me : null),
    exists: async (q: { email?: string }) => (db.others.some((o) => o.email === q.email) ? { _id: 'other' } : null),
  },
}));

vi.mock('../src/services/otp', () => ({
  issueOtp: async (key: string) => {
    const { tooMany } = await import('../src/utils/errors');
    const { OtpErrorCode } = await import('../src/services/otpLogic');
    if (db.cooldown) throw tooMany('Please wait before requesting another code.', 42, OtpErrorCode.COOLDOWN);
    const code = String(100000 + db.issues.length);
    db.codes.set(key, code);
    db.issues.push({ key, code });
    return { code, resendAfterSeconds: 60 };
  },
  checkOtp: async (key: string, code: string) => {
    const { ApiError } = await import('../src/utils/errors');
    const { OtpErrorCode } = await import('../src/services/otpLogic');
    const live = db.codes.get(key);
    if (!live) throw new ApiError(400, OtpErrorCode.NO_CODE, 'No active code. Request a new one.');
    if (live === 'expired') throw new ApiError(400, OtpErrorCode.EXPIRED, 'Code expired. Request a new one.');
    if (live !== code) throw new ApiError(400, OtpErrorCode.INCORRECT, 'Incorrect code.', { attemptsLeft: 4 });
    db.codes.delete(key);
  },
}));

const sent: { to: string; subject: string; text: string }[] = [];
const ME = '507f1f77bcf86cd799439011';

let server: Server;
let base: string;
let serverNoMail: Server;
let baseNoMail: string;

/** The real router, behind a stand-in for requireAuth (tokens are not what this suite is about). */
async function appWith(withMailer: boolean): Promise<Express> {
  const { accountRoutes } = await import('../src/routes/account');
  const { errorHandler } = await import('../src/middleware/error');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = { userId: ME, roles: ['client'] };
    next();
  });
  app.use('/v1/me', accountRoutes(withMailer ? { mailer: { send: async (m) => void sent.push(m as never) } } : undefined));
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  server = (await appWith(true)).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  serverNoMail = (await appWith(false)).listen(0);
  baseNoMail = `http://127.0.0.1:${(serverNoMail.address() as AddressInfo).port}`;
});
afterAll(
  async () =>
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => serverNoMail.close(() => r())),
    ]),
);

beforeEach(() => {
  sent.length = 0;
  db.others = [];
  db.codes.clear();
  db.issues.length = 0;
  db.cooldown = false;
  db.saveFails11000 = false;
  db.me = {
    _id: ME,
    email: 'old@example.com',
    displayName: 'Ayesha',
    roles: ['client'],
    phoneVerified: true,
    emailVerifiedAt: new Date('2026-01-01'),
    termsAcceptedAt: new Date('2026-01-01'),
    termsVersion: '1',
    subscription: { status: 'none' },
    deletedAt: null,
    save: async () => {
      if (db.saveFails11000) throw Object.assign(new Error('dup'), { code: 11000 });
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (path: string, body: unknown, root = base): Promise<any> =>
  fetch(root + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => null),
  }));

const change = (email: string) => post('/v1/me/email/change', { email });
const confirm = (email: string, code: string) => post('/v1/me/email/confirm', { email, code });

describe('POST /me/email/change', () => {
  it('emails a code to the new address and leaves the account alone', async () => {
    const r = await change('new@example.com');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pendingEmail: 'new@example.com' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('new@example.com');
    expect(sent[0]!.subject).toBe(codeEmail('email_change', db.issues[0]!.code, MINUTES).subject);
    // her old address still signs in
    expect(db.me.email).toBe('old@example.com');
  });

  it('keys the code to this account and this address', async () => {
    await change('new@example.com');
    expect(db.issues[0]!.key).toBe(emailChangeOtpKey(ME, 'new@example.com'));
  });

  it('normalises the address before anything else looks at it', async () => {
    const r = await change('  NEW@Example.COM ');
    expect(r.body.pendingEmail).toBe('new@example.com');
    expect(sent[0]!.to).toBe('new@example.com');
  });

  it('refuses an address another live account already has, and sends nothing', async () => {
    db.others = [{ email: 'taken@example.com' }];
    const r = await change('taken@example.com');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('email_in_use');
    expect(sent).toHaveLength(0);
  });

  it('refuses her own current address', async () => {
    const r = await change('OLD@example.com');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('same_email');
    expect(sent).toHaveLength(0);
  });

  it('rejects something that is not an email before any lookup', async () => {
    const r = await change('not-an-email');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(db.issues).toHaveLength(0);
  });

  it('is also the resend, and passes the OTP cooldown straight through', async () => {
    await change('new@example.com');
    await change('new@example.com');
    expect(db.issues).toHaveLength(2);
    expect(sent).toHaveLength(2);
    db.cooldown = true;
    const r = await change('new@example.com');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('otp_cooldown');
    expect(r.body.error.details.retryAfterSeconds).toBe(42);
  });

  it('answers 501 rather than pretending, when no mailer is wired up', async () => {
    const r = await change('new@example.com');
    expect(r.status).toBe(200);
    const n = await post('/v1/me/email/change', { email: 'new@example.com' }, baseNoMail);
    expect(n.status).toBe(501);
    expect(n.body.error.code).toBe('not_implemented');
  });
});

describe('POST /me/email/confirm', () => {
  it('moves the address and marks it verified once the right code comes back', async () => {
    db.me.emailVerifiedAt = null;
    await change('new@example.com');
    const r = await confirm('new@example.com', db.issues[0]!.code);
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('new@example.com');
    expect(r.body.user.emailVerified).toBe(true);
    expect(db.me.email).toBe('new@example.com');
  });

  it('keeps the old address on a wrong code, and says how many tries are left', async () => {
    await change('new@example.com');
    const r = await confirm('new@example.com', '000000');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('otp_incorrect');
    expect(r.body.error.details.attemptsLeft).toBe(4);
    expect(db.me.email).toBe('old@example.com');
  });

  it('keeps the old address on an expired code', async () => {
    await change('new@example.com');
    db.codes.set(emailChangeOtpKey(ME, 'new@example.com'), 'expired');
    const r = await confirm('new@example.com', db.issues[0]!.code);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('otp_expired');
    expect(db.me.email).toBe('old@example.com');
  });

  it('will not accept a code for an address it was not sent to', async () => {
    await change('new@example.com');
    const r = await confirm('other@example.com', db.issues[0]!.code);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('otp_no_code');
    expect(db.me.email).toBe('old@example.com');
  });

  it('refuses when another account claimed the address while the code was in flight', async () => {
    await change('new@example.com');
    db.others = [{ email: 'new@example.com' }];
    const r = await confirm('new@example.com', db.issues[0]!.code);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('email_in_use');
    expect(db.me.email).toBe('old@example.com');
  });

  it('turns a duplicate-key save into the same friendly conflict', async () => {
    await change('new@example.com');
    db.saveFails11000 = true;
    const r = await confirm('new@example.com', db.issues[0]!.code);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('email_in_use');
  });

  it('is safe to tap twice: the second call just reports the account as it stands', async () => {
    await change('new@example.com');
    await confirm('new@example.com', db.issues[0]!.code);
    const again = await confirm('new@example.com', db.issues[0]!.code);
    expect(again.status).toBe(200);
    expect(again.body.user.email).toBe('new@example.com');
  });

  it('rejects a code that is not six digits', async () => {
    expect((await confirm('new@example.com', '123')).status).toBe(400);
    expect((await confirm('new@example.com', 'abcdef')).status).toBe(400);
  });
});

describe('email-change helpers', () => {
  it('spots the address she is already on, whatever the case or spacing', () => {
    expect(emailChangeProblem('a@b.com', ' A@B.com ', false)).toBe('same_email');
    expect(emailChangeProblem('a@b.com', 'c@d.com', false)).toBeNull();
  });
  it('spots an address someone else holds', () => {
    expect(emailChangeProblem('a@b.com', 'c@d.com', true)).toBe('email_in_use');
    // her own address wins: she is told "that is already yours", not "someone has it"
    expect(emailChangeProblem('a@b.com', 'a@b.com', true)).toBe('same_email');
  });
  it('has no problem with an account that has no address yet', () => {
    expect(emailChangeProblem(null, 'c@d.com', false)).toBeNull();
  });
  it('keys one slot per account and address, under a prefix the deletion sweep matches', () => {
    const k = emailChangeOtpKey('u1', ' A@B.com ');
    expect(k).toBe('email-change:u1:a@b.com');
    expect(k.startsWith(emailChangeOtpKeyPrefix('u1'))).toBe(true);
    expect(emailChangeOtpKey('u1', 'c@d.com')).not.toBe(k);
  });
});

describe('the email-change code email', () => {
  it('has its own subject and says the old address still works', () => {
    const m = codeEmail('email_change', '402913', MINUTES);
    expect(m.subject).toMatch(/^402913 /);
    expect(m.subject).not.toBe(codeEmail('verify', '402913', MINUTES).subject);
    for (const part of [m.text, m.html]) {
      expect(part).toContain('402913');
      expect(part).toContain(`${MINUTES} minutes`);
      expect(part).toMatch(/old one keeps working/);
      expect(part).not.toContain('undefined');
    }
    expect(m.text).not.toMatch(/<[a-z]/i);
  });
});
