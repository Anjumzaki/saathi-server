/**
 * "Continue with Google" and "Continue with Apple", server side.
 *
 * The phone does the talking to Google or Apple and sends us the identity token it was given. That token
 * is the only thing we trust: it is signed by the provider, it names the audience it was minted for, and
 * it carries the address the provider has checked. Nothing else in the request is believed — above all
 * not an email, because a request that could name its own address could claim anybody's account.
 */
import { createHash } from 'node:crypto';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { IdTokenVerifier, IdTokenVerifyOptions, VerifiedIdentity } from '../interfaces';
import { unauthorized } from '../utils/errors';

export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
/** A few seconds of slack for a phone whose clock is slightly out. */
const CLOCK_TOLERANCE_S = 30;

/**
 * "Hide my email" gives a working forwarding address at this domain, one per app per Apple ID. It is
 * hers, so it is kept and it can find her account again; it is simply not an address she would recognise.
 */
export const isPrivateRelayEmail = (email: string): boolean => /@privaterelay\.appleid\.com$/i.test(email.trim());

/** `email_verified` arrives as a boolean from Google and sometimes as the string "true" from Apple. */
const isVerifiedFlag = (v: unknown): boolean => v === true || v === 'true';

/** A full name the client sent, used only when it is creating the account. Apple never says it twice. */
const cleanFullName = (name: string | undefined): string | undefined => {
  const t = name?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 100) : undefined;
};

/**
 * The nonce the app generated for this sign-in. Apple is sent the SHA-256 of it (that is what
 * `@invertase/react-native-apple-authentication` does), Google is sent it as it is, so either form in
 * the claim proves the same thing: whoever asked for this token knew this nonce.
 */
function nonceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim !== 'string' || !claim) return false;
  return claim === expected || claim === createHash('sha256').update(expected).digest('hex');
}

/** Shared claim checks. The signature has already been verified by the time anything here runs. */
function checkClaims(
  p: { iss?: unknown; aud?: unknown; exp?: unknown; nonce?: unknown; sub?: unknown },
  expect: { issuers: string[]; audiences: string[]; nonce?: string | undefined; now: number },
): string {
  if (typeof p.sub !== 'string' || !p.sub) throw unauthorized('Sign-in token has no subject');
  if (typeof p.iss !== 'string' || !expect.issuers.includes(p.iss)) throw unauthorized('Sign-in token came from the wrong issuer');
  const auds = Array.isArray(p.aud) ? p.aud.map(String) : typeof p.aud === 'string' ? [p.aud] : [];
  if (!auds.some((a) => expect.audiences.includes(a))) throw unauthorized('Sign-in token was issued for a different app');
  if (typeof p.exp !== 'number' || p.exp + CLOCK_TOLERANCE_S <= expect.now / 1000) throw unauthorized('Sign-in token has expired');
  // A nonce is only demanded when the app says it used one, but once it does, it must be the right one.
  if (expect.nonce && !nonceMatches(p.nonce, expect.nonce)) throw unauthorized('Sign-in token does not match this request');
  return p.sub;
}

/**
 * Google. `google-auth-library` fetches Google's certificates (and caches them), checks the signature and
 * the audience; the claims are then checked again here, because a verifier that trusts one library's
 * defaults is a verifier nobody can read.
 */
export class GoogleIdTokenVerifier implements IdTokenVerifier {
  /** Overridden in tests; by default this is the library doing the real work. */
  private readonly check: (idToken: string, audiences: string[]) => Promise<TokenPayload | undefined>;

  constructor(
    private readonly clientIds: string[],
    check?: (idToken: string, audiences: string[]) => Promise<TokenPayload | undefined>,
    private readonly now: () => number = Date.now,
  ) {
    const client = new OAuth2Client();
    this.check = check ?? (async (idToken, audiences) => (await client.verifyIdToken({ idToken, audience: audiences })).getPayload());
  }

  get configured(): boolean {
    return this.clientIds.length > 0;
  }

  async verify(idToken: string, opts: IdTokenVerifyOptions = {}): Promise<VerifiedIdentity> {
    if (!this.configured) throw unauthorized('Google sign-in is not configured on this server');
    let payload: TokenPayload | undefined;
    try {
      payload = await this.check(idToken, this.clientIds);
    } catch {
      // A bad signature, an unknown key, an expired token: all the same answer, with no detail to probe.
      throw unauthorized('Google sign-in could not be verified');
    }
    if (!payload) throw unauthorized('Google sign-in could not be verified');
    const subject = checkClaims(payload, { issuers: GOOGLE_ISSUERS, audiences: this.clientIds, nonce: opts.nonce, now: this.now() });
    const email = payload.email?.trim().toLowerCase();
    return {
      provider: 'google',
      subject,
      ...(email ? { email } : {}),
      emailVerified: !!email && isVerifiedFlag(payload.email_verified),
      ...(payload.name ? { name: cleanFullName(payload.name) } : {}),
    };
  }
}

/**
 * Apple. The token is verified against Apple's published keys with `jose`, which caches them and
 * re-fetches when Apple rotates.
 *
 * Two things Apple does that nothing else does: the address is given on the first sign-in and never
 * again (so a returning woman is found by her subject alone), and the name is never in the token at all
 * — the phone gets it once, in the sign-in response, and sends it with that first request.
 */
export class AppleIdTokenVerifier implements IdTokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly clientIds: string[],
    keys?: JWTVerifyGetKey,
    private readonly now: () => number = Date.now,
  ) {
    this.keys = keys ?? createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  }

  get configured(): boolean {
    return this.clientIds.length > 0;
  }

  async verify(idToken: string, opts: IdTokenVerifyOptions = {}): Promise<VerifiedIdentity> {
    if (!this.configured) throw unauthorized('Apple sign-in is not configured on this server');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys, {
        issuer: APPLE_ISSUER,
        audience: this.clientIds,
        clockTolerance: CLOCK_TOLERANCE_S,
      }));
    } catch {
      throw unauthorized('Apple sign-in could not be verified');
    }
    const subject = checkClaims(payload, { issuers: [APPLE_ISSUER], audiences: this.clientIds, nonce: opts.nonce, now: this.now() });
    const email = typeof payload['email'] === 'string' ? payload['email'].trim().toLowerCase() : undefined;
    const name = cleanFullName(opts.fullName);
    return {
      provider: 'apple',
      subject,
      ...(email ? { email } : {}),
      emailVerified: !!email && isVerifiedFlag(payload['email_verified']),
      // Not from the token: Apple does not put it there. Applied only to an account being created.
      ...(name ? { name } : {}),
    };
  }
}

/** Refuses every sign-in, clearly, when the provider has no client id. The app hides the button anyway. */
export class UnconfiguredIdTokenVerifier implements IdTokenVerifier {
  constructor(private readonly provider: 'google' | 'apple') {}
  readonly configured = false;
  async verify(): Promise<VerifiedIdentity> {
    const name = this.provider === 'google' ? 'Google' : 'Apple';
    throw unauthorized(`${name} sign-in is not available. Use your email and password.`);
  }
}
