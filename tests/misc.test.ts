import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env';
import { TtlCache } from '../src/services/configCache';
import { DEFAULT_FEE_CONFIG } from '../src/services/feeConfig';
import { applyDiscount } from '../src/services/money';
import { canVerificationTransition, flagDocsAfterReview, readyToSubmit, type DocRef } from '../src/services/verification';
import { REGION_PACKS } from '../src/seed';
import { StubAiPlanReader, StubPlayBilling, createStubServices } from '../src/stubs';
import { planContentSchema } from '../src/schemas/plan';

describe('TtlCache', () => {
  it('caches within ttl, reloads after, and invalidates on demand', async () => {
    let t = 0;
    const loader = vi.fn(async () => ({ n: loader.mock.calls.length }));
    const c = new TtlCache(loader, 1000, () => t);
    expect((await c.get()).n).toBe(1);
    expect((await c.get()).n).toBe(1);
    t = 999;
    await c.get();
    expect(loader).toHaveBeenCalledTimes(1);
    t = 1000;
    expect((await c.get()).n).toBe(2);
    c.invalidate();
    expect((await c.get()).n).toBe(3);
  });
  it('shares one in-flight load', async () => {
    const loader = vi.fn(async () => 1);
    const c = new TtlCache(loader, 1000);
    await Promise.all([c.get(), c.get(), c.get()]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it('does not cache a load that was invalidated while in flight', async () => {
    let v = 1;
    const c = new TtlCache(async () => { const x = v; await new Promise((r) => setTimeout(r, 10)); return x; }, 60_000);
    const p = c.get();
    v = 2;
    c.invalidate();
    await p;
    expect(await c.get()).toBe(2);
  });
});

describe('fee defaults', () => {
  it('match the product decisions', () => {
    expect(DEFAULT_FEE_CONFIG).toEqual({ playFeePercent: 15, platformFeePercent: 20, payoutDelayHours: 24, refundWindowHours: 72, premiumDiscountPercent: 30, followUpDiscountPercent: 50 });
    expect(applyDiscount(10000, DEFAULT_FEE_CONFIG.premiumDiscountPercent)).toBe(7000);
  });
});

describe('verification workflow', () => {
  it('follows submitted -> in_review -> approved/rejected, with resubmission', () => {
    expect(canVerificationTransition('draft', 'submitted')).toBe(true);
    expect(canVerificationTransition('submitted', 'approved')).toBe(false);
    expect(canVerificationTransition('submitted', 'in_review')).toBe(true);
    expect(canVerificationTransition('in_review', 'approved')).toBe(true);
    expect(canVerificationTransition('in_review', 'rejected')).toBe(true);
    expect(canVerificationTransition('rejected', 'submitted')).toBe(true);
    expect(canVerificationTransition('approved', 'rejected')).toBe(false);
  });
  it('flags government IDs (only) for deletion after review', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const docs: DocRef[] = [
      { kind: 'government_id', ref: 'a', flaggedForDeletion: false },
      { kind: 'license', ref: 'b', flaggedForDeletion: false },
    ];
    const out = flagDocsAfterReview(docs, now);
    expect(out[0]).toMatchObject({ flaggedForDeletion: true });
    expect(out[0]!.deleteAfter!.getTime()).toBeGreaterThan(now.getTime());
    expect(out[1]!.flaggedForDeletion).toBe(false);
  });
  it('requires an ID plus a license/certificate to submit', () => {
    expect(readyToSubmit([{ kind: 'government_id' }])).toBe(false);
    expect(readyToSubmit([{ kind: 'government_id' }, { kind: 'certificate' }])).toBe(true);
    expect(readyToSubmit([{ kind: 'government_id', deletedAt: new Date() }, { kind: 'license' }])).toBe(false);
  });
});

describe('env', () => {
  it('applies dev defaults', () => {
    const e = loadEnv({});
    expect(e.PORT).toBe(3000);
    expect(e.ALLOW_STUB_PROVIDERS).toBe(false);
    expect(e.ADMIN_EMAILS).toEqual([]);
  });
  it('reads PORT and csv lists', () => {
    const e = loadEnv({ PORT: '8080', ADMIN_EMAILS: 'a@x.com, b@x.com' });
    expect(e.PORT).toBe(8080);
    expect(e.ADMIN_EMAILS).toEqual(['a@x.com', 'b@x.com']);
  });
  it('refuses weak or missing secrets in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/MONGODB_URI/);
    const strong = 'x'.repeat(40);
    const ok = { NODE_ENV: 'production', RESEND_API_KEY: 're_x', MONGODB_URI: 'mongodb://h/db', JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: 'y'.repeat(40), OTP_PEPPER: 'z'.repeat(40) };
    expect(loadEnv(ok).NODE_ENV).toBe('production');
    expect(() => loadEnv({ ...ok, JWT_REFRESH_SECRET: strong })).toThrow(/differ/);
    expect(() => loadEnv({ ...ok, OTP_PEPPER: 'short' })).toThrow(/OTP_PEPPER/);
  });
});

describe('stubs and seed data', () => {
  it('AI reader stub is clearly marked and schema-valid', async () => {
    const d = await new StubAiPlanReader().read();
    expect(d.isSample).toBe(true);
    expect(d.title).toContain('SAMPLE');
    expect(planContentSchema.safeParse(d).success).toBe(true);
  });
  it('Play stub validates only stub tokens', async () => {
    const p = new StubPlayBilling();
    expect((await p.verify({ productId: 'x', purchaseToken: 'stub_valid_1', kind: 'product' as const })).valid).toBe(true);
    expect((await p.verify({ productId: 'x', purchaseToken: 'stub_trial_1', kind: 'product' as const })).isTrial).toBe(true);
    expect((await p.verify({ productId: 'x', purchaseToken: 'real-looking', kind: 'product' as const })).valid).toBe(false);
  });
  it('stubs are refused in production unless explicitly allowed', async () => {
    const prod = createStubServices({ production: true, allowStubInProduction: false });
    await expect(Promise.resolve().then(() => prod.playBilling.verify({ productId: 'x', purchaseToken: 'stub_valid', kind: 'product' as const }))).rejects.toMatchObject({ status: 501 });
    const allowed = createStubServices({ production: true, allowStubInProduction: true });
    expect((await allowed.playBilling.verify({ productId: 'x', purchaseToken: 'stub_valid', kind: 'product' as const })).valid).toBe(true);
  });
  it('seeds PK, IN, AE, GB, US region packs', () => {
    expect(REGION_PACKS.map((r) => r.country)).toEqual(['PK', 'IN', 'AE', 'GB', 'US']);
    for (const r of REGION_PACKS) expect(r.proteinKeywords.length).toBeGreaterThan(3);
  });
});

describe('App Store stub', () => {
  it('validates only stub transactions and is refused in production', async () => {
    const { StubAppStoreBilling } = await import('../src/stubs');
    const b = new StubAppStoreBilling();
    expect((await b.verify({ productId: 'x', transactionId: 'stub_valid_1' })).valid).toBe(true);
    expect((await b.verify({ productId: 'x', transactionId: 'stub_trial_1' })).isTrial).toBe(true);
    expect((await b.verify({ productId: 'x', transactionId: '123' })).valid).toBe(false);
    const prod = createStubServices({ production: true, allowStubInProduction: false });
    await expect(Promise.resolve().then(() => prod.appStoreBilling.verify({ productId: 'x', transactionId: 'stub_valid' }))).rejects.toMatchObject({ status: 501 });
  });
});

describe('production mail + config', () => {
  const base = { NODE_ENV: 'production', MONGODB_URI: 'mongodb://x/y', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32) };
  it('production needs a mailer (or the explicit staging flag)', () => {
    expect(() => loadEnv(base)).toThrow(/mailer/);
    expect(() => loadEnv({ ...base, RESEND_API_KEY: 're_x' })).not.toThrow();
    expect(() => loadEnv({ ...base, SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' })).not.toThrow();
    expect(() => loadEnv({ ...base, SMTP_HOST: 'h' })).toThrow(/mailer/);
    expect(() => loadEnv({ ...base, LOG_OTP: 'true' })).not.toThrow();
  });
  it('Resend mailer posts the message and hides failures from logs', async () => {
    const { ResendMailer } = await import('../src/services/resendMailer');
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new ResendMailer('k', 'S <a@b.co>', (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true, status: 200 }; }) as never);
    await ok.send({ to: 'u@x.co', subject: 's', text: 'code 123456' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ to: ['u@x.co'], from: 'S <a@b.co>' });
    const bad = new ResendMailer('k', 'f', (async () => ({ ok: false, status: 403 })) as never);
    await expect(bad.send({ to: 'u@x.co', subject: 's', text: 't' })).rejects.toMatchObject({ status: 503, code: 'mail_unavailable' });
  });
});

describe('SMTP mailer', () => {
  it('sends from the configured sender and hides provider errors from callers', async () => {
    const { SmtpMailer } = await import('../src/services/smtpMailer');
    const sent: unknown[] = [];
    const ok = new SmtpMailer({ host: 'h', port: 465, user: 'u', pass: 'p', from: 'Saathi <u@x.co>' }, { sendMail: async (m: unknown) => { sent.push(m); } } as never);
    await ok.send({ to: 'a@b.co', subject: 's', text: 'code 123456' });
    expect(sent[0]).toMatchObject({ from: 'Saathi <u@x.co>', to: 'a@b.co' });
    const bad = new SmtpMailer({ host: 'h', port: 465, user: 'u', pass: 'p', from: 'f' }, { sendMail: async () => { throw new Error('535 auth failed'); } } as never);
    await expect(bad.send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toMatchObject({ status: 503, code: 'mail_unavailable' });
  });
});

describe('LOG_OTP fallback mailer', () => {
  it('uses the real mailer, falls back to logs on failure, and rests the provider for the cooldown', async () => {
    const { FallbackMailer } = await import('../src/services/fallbackMailer');
    let t = 0, calls = 0, fail = true;
    const primary = { send: async () => { calls++; if (fail) throw new Error('blocked'); } };
    const m = new FallbackMailer(primary, 1000, () => t);
    await expect(m.send({ to: 'a@b.co', subject: 's', text: 'x' })).resolves.toBeUndefined(); // failed -> logged, no throw
    await m.send({ to: 'a@b.co', subject: 's', text: 'x' });
    expect(calls).toBe(1);               // skipped during cooldown
    t = 1500; fail = false;
    await m.send({ to: 'a@b.co', subject: 's', text: 'x' });
    expect(calls).toBe(2);               // retried after cooldown, now works
    await expect(new FallbackMailer(null).send({ to: 'a@b.co', subject: 's', text: 'x' })).resolves.toBeUndefined();
  });
});
