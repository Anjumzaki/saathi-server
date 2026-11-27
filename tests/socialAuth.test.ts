import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createHash } from 'node:crypto';
import type { TokenPayload } from 'google-auth-library';
import {
  APPLE_ISSUER,
  AppleIdTokenVerifier,
  GoogleIdTokenVerifier,
  UnconfiguredIdTokenVerifier,
  isPrivateRelayEmail,
} from '../src/services/socialAuth';
import { ApiError } from '../src/utils/errors';

const NOW = new Date('2026-11-27T10:00:00Z').getTime();
const now = () => NOW;
const GOOGLE_IDS = ['111-android.apps.googleusercontent.com', '111-ios.apps.googleusercontent.com'];
const APPLE_ID = 'com.multiware.saathi';

const googlePayload = (over: Partial<TokenPayload> = {}): TokenPayload =>
  ({
    iss: 'https://accounts.google.com',
    aud: GOOGLE_IDS[0]!,
    sub: '10987654321',
    exp: Math.floor(NOW / 1000) + 600,
    iat: Math.floor(NOW / 1000),
    email: 'Anjum@Gmail.com',
    email_verified: true,
    name: 'Anjum',
    ...over,
  }) as TokenPayload;

/** A verifier whose signature check is a stand-in, so the claim checks can be tested without the network. */
const googleWith = (payload: TokenPayload | undefined, fail = false) =>
  new GoogleIdTokenVerifier(GOOGLE_IDS, async () => {
    if (fail) throw new Error('Invalid token signature');
    return payload;
  }, now);

describe('Google id tokens', () => {
  it('accepts a valid token and lowercases the verified address', async () => {
    const id = await googleWith(googlePayload()).verify('any');
    expect(id).toEqual({ provider: 'google', subject: '10987654321', email: 'anjum@gmail.com', emailVerified: true, name: 'Anjum' });
  });

  it('refuses a forged token without saying why', async () => {
    const e = await googleWith(undefined, true).verify('forged').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(401);
    expect((e as ApiError).message).toBe('Google sign-in could not be verified');
  });

  it('refuses a token minted for another app, even if the signature checked out', async () => {
    const e = await googleWith(googlePayload({ aud: 'someone-elses.apps.googleusercontent.com' })).verify('t').catch((x: unknown) => x);
    expect((e as ApiError).status).toBe(401);
    expect((e as ApiError).message).toMatch(/different app/);
  });

  it('refuses the wrong issuer, an expired token, and a token with no subject', async () => {
    const cases: [Partial<TokenPayload>, RegExp][] = [
      [{ iss: 'https://accounts.google.com.evil.test' }, /wrong issuer/],
      [{ exp: Math.floor(NOW / 1000) - 31 }, /expired/],
      [{ sub: undefined }, /no subject/],
    ];
    for (const [over, message] of cases) {
      const e = await googleWith(googlePayload(over)).verify('t').catch((x: unknown) => x);
      expect((e as ApiError).status).toBe(401);
      expect((e as ApiError).message).toMatch(message);
    }
  });

  it('passes an unverified address through as unverified, so it can never link an account', async () => {
    const id = await googleWith(googlePayload({ email_verified: false })).verify('t');
    expect(id).toMatchObject({ email: 'anjum@gmail.com', emailVerified: false });
  });

  it('demands the nonce it was told to expect', async () => {
    const withNonce = googleWith(googlePayload({ nonce: 'abc123xyz' } as Partial<TokenPayload>));
    await expect(withNonce.verify('t', { nonce: 'abc123xyz' })).resolves.toMatchObject({ subject: '10987654321' });
    const e = await withNonce.verify('t', { nonce: 'a-different-nonce' }).catch((x: unknown) => x);
    expect((e as ApiError).message).toMatch(/does not match this request/);
  });

  it('is not configured when there are no client ids, and refuses rather than trusting anything', async () => {
    const none = new GoogleIdTokenVerifier([], async () => googlePayload(), now);
    expect(none.configured).toBe(false);
    await expect(none.verify('t')).rejects.toThrow(/not configured/);
    expect(googleWith(googlePayload()).configured).toBe(true);
  });
});

describe('Apple id tokens (verified against a real signature)', () => {
  // `jose` reads the real clock, so these tokens are dated from it and the verifier is told the same
  // time. A fixed date would be an hour stale by the time the suite runs and every token would be expired.
  const REAL = Date.now();
  const appleNow = () => REAL;

  /** A keypair standing in for Apple's, so the signature check is the real one. */
  async function appleKit() {
    const mine = await generateKeyPair('RS256');
    const theirs = await generateKeyPair('RS256');
    const jwk: JWK = { ...(await exportJWK(mine.publicKey)), kid: 'apple-key-1', alg: 'RS256', use: 'sig' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = async (claims: Record<string, unknown>, key = mine.privateKey) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'apple-key-1' })
        .setIssuedAt(Math.floor(REAL / 1000))
        .setExpirationTime(Math.floor(REAL / 1000) + 600)
        .sign(key);
    return { keys, sign, otherKey: theirs.privateKey, verifier: new AppleIdTokenVerifier([APPLE_ID], keys, appleNow) };
  }

  const base = { iss: APPLE_ISSUER, aud: APPLE_ID, sub: '000123.abcdef.1234', email: 'anjum@icloud.com', email_verified: 'true' };

  it('accepts a real token and reads the address Apple shared', async () => {
    const { sign, verifier } = await appleKit();
    const id = await verifier.verify(await sign(base));
    expect(id).toEqual({ provider: 'apple', subject: '000123.abcdef.1234', email: 'anjum@icloud.com', emailVerified: true });
  });

  it('refuses a token signed by anybody but Apple', async () => {
    const { sign, otherKey, verifier } = await appleKit();
    const e = await verifier.verify(await sign(base, otherKey)).catch((x: unknown) => x);
    expect((e as ApiError).status).toBe(401);
    expect((e as ApiError).message).toBe('Apple sign-in could not be verified');
  });

  it('refuses a token with the wrong audience', async () => {
    const { sign, verifier } = await appleKit();
    const e = await verifier.verify(await sign({ ...base, aud: 'com.someone.else' })).catch((x: unknown) => x);
    expect((e as ApiError).status).toBe(401);
  });

  it('refuses the wrong issuer and an expired token', async () => {
    const { keys, sign } = await appleKit();
    const e = await new AppleIdTokenVerifier([APPLE_ID], keys, appleNow).verify(await sign({ ...base, iss: 'https://appleid.apple.com.evil.test' })).catch((x: unknown) => x);
    expect((e as ApiError).status).toBe(401);
    // An hour later the same token is no longer good for anything: our own expiry check catches it.
    const later = new AppleIdTokenVerifier([APPLE_ID], keys, () => REAL + 3_600_000);
    await expect(later.verify(await sign(base))).rejects.toThrow(/has expired/);
  });

  it('handles a later sign-in, where Apple sends no address at all', async () => {
    const { sign, verifier } = await appleKit();
    const id = await verifier.verify(await sign({ iss: APPLE_ISSUER, aud: APPLE_ID, sub: '000123.abcdef.1234' }));
    expect(id).toEqual({ provider: 'apple', subject: '000123.abcdef.1234', emailVerified: false });
    expect(id.email).toBeUndefined();
  });

  it('takes the name from the first sign-in only, tidied, because Apple never repeats it', async () => {
    const { sign, verifier } = await appleKit();
    const id = await verifier.verify(await sign(base), { fullName: '  Anjum   Shahid ' });
    expect(id.name).toBe('Anjum Shahid');
    // Nothing sent, nothing invented.
    expect((await verifier.verify(await sign(base), { fullName: '   ' })).name).toBeUndefined();
  });

  it('matches the nonce Apple was given, which is the SHA-256 of the app\'s own', async () => {
    const { sign, verifier } = await appleKit();
    const raw = 'a6f3c1d9e2b47580';
    const token = await sign({ ...base, nonce: createHash('sha256').update(raw).digest('hex') });
    await expect(verifier.verify(token, { nonce: raw })).resolves.toMatchObject({ subject: base.sub });
    await expect(verifier.verify(token, { nonce: 'not-the-nonce' })).rejects.toThrow(/does not match this request/);
    // A token with no nonce claim cannot satisfy a request that says it used one.
    await expect(verifier.verify(await sign(base), { nonce: raw })).rejects.toThrow(/does not match this request/);
  });

  it('keeps a private relay address and recognises it for what it is', async () => {
    const { sign, verifier } = await appleKit();
    const relay = 'kj8s2mdk3n@privaterelay.appleid.com';
    const id = await verifier.verify(await sign({ ...base, email: relay }));
    expect(id).toMatchObject({ email: relay, emailVerified: true });
    expect(isPrivateRelayEmail(relay)).toBe(true);
    expect(isPrivateRelayEmail('anjum@icloud.com')).toBe(false);
  });
});

describe('a provider with no credentials', () => {
  it('says so instead of letting anyone in', async () => {
    for (const p of ['google', 'apple'] as const) {
      const v = new UnconfiguredIdTokenVerifier(p);
      expect(v.configured).toBe(false);
      await expect(v.verify()).rejects.toThrow(/is not available\. Use your email and password\./);
    }
  });
});
