import { describe, expect, it } from 'vitest';
import { OTP_CONFIG, decideResend, evaluateOtp, otpFailureError, type OtpState } from '../src/services/otpLogic';
import { CURRENT_TERMS_VERSION, fieldsForNewUser, needsProfile } from '../src/services/signupProfile';
import { generateOtpCode, hashOtp, safeEqual } from '../src/utils/crypto';

const t0 = new Date('2026-01-01T10:00:00Z');
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const state = (over: Partial<OtpState> = {}): OtpState => ({ codeHash: 'h', expiresAt: plus(t0, 10 * 60_000), attempts: 0, lockedUntil: null, lastSentAt: t0, consumed: false, ...over });
const ev = (s: OtpState | null, submitted: string, now: Date) => evaluateOtp(s, submitted, (a, b) => a === b, now);

describe('OTP config', () => {
  it('matches the product rules', () => {
    expect(OTP_CONFIG).toMatchObject({ length: 6, ttlMs: 600_000, maxAttempts: 5, lockMs: 600_000, resendCooldownMs: 60_000 });
  });
});

describe('evaluateOtp', () => {
  it('accepts the right code and consumes it', () => {
    const r = ev(state(), 'h', plus(t0, 1000));
    expect(r.ok).toBe(true);
    expect(r.patch.consumed).toBe(true);
  });
  it('rejects a consumed code (no replay)', () => {
    expect(ev(state({ consumed: true }), 'h', plus(t0, 1000)).failure).toBe('no_code');
  });
  it('reports no_code when none exists', () => {
    expect(ev(null, 'h', t0).failure).toBe('no_code');
  });
  it('expires after 10 minutes', () => {
    expect(ev(state(), 'h', plus(t0, 10 * 60_000)).failure).toBe('expired');
    expect(ev(state(), 'h', plus(t0, 10 * 60_000 - 1)).ok).toBe(true);
  });
  it('counts wrong tries and locks on the 5th for 10 minutes', () => {
    let s = state();
    for (let i = 1; i <= 4; i++) {
      const r = ev(s, 'bad', plus(t0, i * 1000));
      expect(r.failure).toBe('invalid');
      expect(r.attemptsLeft).toBe(5 - i);
      s = { ...s, ...r.patch } as OtpState;
    }
    const fifth = ev(s, 'bad', plus(t0, 5000));
    expect(fifth.failure).toBe('locked');
    expect(fifth.patch.lockedUntil!.getTime()).toBe(plus(t0, 5000).getTime() + 600_000);
    s = { ...s, ...fifth.patch } as OtpState;
    // even the right code is refused while locked
    const locked = ev(s, 'h', plus(t0, 6000));
    expect(locked.failure).toBe('locked');
    expect(locked.retryAfterSeconds).toBeGreaterThan(590);
  });
  it('lets a lapsed lock reset the counter (new code needed once expired)', () => {
    const s = state({ attempts: 5, lockedUntil: plus(t0, 5000 + 600_000), expiresAt: plus(t0, 1_000_000) });
    expect(ev(s, 'h', plus(t0, 5000 + 600_001)).ok).toBe(true);
    const wrong = ev(s, 'bad', plus(t0, 5000 + 600_001));
    expect(wrong.attemptsLeft).toBe(4);
  });
});

describe('decideResend', () => {
  it('allows the first send', () => {
    expect(decideResend(null, t0)).toEqual({ allowed: true, attempts: 0, lockedUntil: null });
  });
  it('enforces the 60 s cooldown', () => {
    const d = decideResend(state(), plus(t0, 30_000));
    expect(d).toMatchObject({ allowed: false, reason: 'cooldown', retryAfterSeconds: 30 });
    expect(decideResend(state(), plus(t0, 60_000)).allowed).toBe(true);
  });
  it('refuses to resend while locked, so a resend cannot bypass the lock', () => {
    const d = decideResend(state({ attempts: 5, lockedUntil: plus(t0, 600_000) }), plus(t0, 120_000));
    expect(d).toMatchObject({ allowed: false, reason: 'locked' });
  });
  it('carries failed attempts over a resend, resets them when stale', () => {
    expect(decideResend(state({ attempts: 3 }), plus(t0, 61_000))).toMatchObject({ allowed: true, attempts: 3 });
    expect(decideResend(state({ attempts: 3 }), plus(t0, 11 * 60_000))).toMatchObject({ allowed: true, attempts: 0 });
    expect(decideResend(state({ attempts: 3, consumed: true }), plus(t0, 61_000))).toMatchObject({ attempts: 0 });
  });
});

describe('otp crypto', () => {
  it('generates 6 digit zero-padded codes', () => {
    for (let i = 0; i < 200; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });
  it('hashes bound to key and pepper; never equals plaintext', () => {
    const h = hashOtp('pep', 'email:a@b.c', '123456');
    expect(h).not.toContain('123456');
    expect(h).not.toBe(hashOtp('pep', 'email:x@b.c', '123456'));
    expect(h).not.toBe(hashOtp('other', 'email:a@b.c', '123456'));
    expect(safeEqual(h, hashOtp('pep', 'email:a@b.c', '123456'))).toBe(true);
    expect(safeEqual(h, 'short')).toBe(false);
  });
});

describe('otpFailureError (codes the apps switch on)', () => {
  it('gives each failure its own code', () => {
    expect(otpFailureError({ ok: false, failure: 'invalid', attemptsLeft: 3, patch: {} })).toMatchObject({ status: 400, code: 'otp_incorrect', details: { attemptsLeft: 3 } });
    expect(otpFailureError({ ok: false, failure: 'expired', patch: {} })).toMatchObject({ status: 400, code: 'otp_expired' });
    expect(otpFailureError({ ok: false, failure: 'no_code', patch: {} })).toMatchObject({ status: 400, code: 'otp_no_code' });
    expect(otpFailureError({ ok: false, failure: 'locked', retryAfterSeconds: 42, patch: {} })).toMatchObject({ status: 429, code: 'otp_locked', details: { retryAfterSeconds: 42 } });
  });
  it('falls back to the full lock time', () => {
    expect(otpFailureError({ ok: false, failure: 'locked', patch: {} }).details?.retryAfterSeconds).toBe(600);
  });
});

describe('sign-up profile', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  it('takes name, phone and consent for a new account', () => {
    expect(fieldsForNewUser({ displayName: 'Ayesha', phone: '+923001234567', acceptTerms: true }, now)).toEqual({
      displayName: 'Ayesha', phone: '+923001234567', phoneVerified: false, termsAcceptedAt: now, termsVersion: CURRENT_TERMS_VERSION,
    });
  });
  it('sets nothing without a form, and no consent unless accepted', () => {
    expect(fieldsForNewUser(undefined, now)).toEqual({});
    expect(fieldsForNewUser({ displayName: 'A' }, now)).toEqual({ displayName: 'A' });
  });
  it('needs a profile until there is a name and consent', () => {
    expect(needsProfile({})).toBe(true);
    expect(needsProfile({ displayName: 'A' })).toBe(true);
    expect(needsProfile({ displayName: '  ', termsAcceptedAt: now })).toBe(true);
    expect(needsProfile({ displayName: 'A', termsAcceptedAt: now })).toBe(false);
  });
});
