/**
 * Verifying Apple's signed payloads.
 *
 * Everything Apple tells us — a transaction, a renewal, a server notification — arrives as a JWS whose
 * header carries the signing certificate chain in `x5c`. A notification arrives on a public URL with no
 * authentication of its own, so this signature is the only thing standing between a refund notice and
 * anybody on the internet who knows the path. The chain is therefore verified properly: each certificate
 * must be issued by the next, every one must be in date, and the top of the chain must be a certificate we
 * were configured with. A chain that is merely internally consistent proves nothing — anyone can make one.
 *
 * With no trust anchor configured, verification fails. That is the honest outcome: we cannot tell Apple's
 * signature from a forgery, so we act on neither.
 */
import { X509Certificate } from 'node:crypto';
import { compactVerify, decodeProtectedHeader, importX509 } from 'jose';

export interface JwsVerifyResult<T> {
  ok: boolean;
  payload?: T | undefined;
  /** Why it was refused, for the log and the 400 we answer with. Never shown to her. */
  error?: string | undefined;
}

const toPem = (der: string): string => `-----BEGIN CERTIFICATE-----\n${der.replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----`;

const parse = (pemOrDer: string): X509Certificate | null => {
  try {
    return new X509Certificate(pemOrDer.includes('-----BEGIN') ? pemOrDer : toPem(pemOrDer));
  } catch {
    return null;
  }
};

const inDate = (c: X509Certificate, now: Date): boolean => {
  const from = Date.parse(c.validFrom);
  const to = Date.parse(c.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && now.getTime() >= from && now.getTime() <= to;
};

/**
 * The chain in `x5c`, checked from the leaf up to one of `anchors`. Returns the leaf, which is what
 * actually signed the payload.
 */
export function verifyCertificateChain(x5c: string[], anchors: string[], now: Date): { leaf?: X509Certificate; error?: string } {
  if (!anchors.length) return { error: 'no Apple trust anchor is configured (APP_STORE_ROOT_CERTS)' };
  if (!x5c.length) return { error: 'signature carries no certificate chain' };
  const chain: X509Certificate[] = [];
  for (const c of x5c) {
    const cert = parse(c);
    if (!cert) return { error: 'signature carries an unreadable certificate' };
    if (!inDate(cert, now)) return { error: 'a certificate in the chain is not in date' };
    chain.push(cert);
  }
  const trusted = anchors.map(parse).filter((c): c is X509Certificate => !!c);
  if (!trusted.length) return { error: 'APP_STORE_ROOT_CERTS holds no readable certificate' };
  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i]!;
    const parent = chain[i + 1]!;
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) return { error: 'the certificate chain does not hold together' };
  }
  const top = chain[chain.length - 1]!;
  // The top of the chain must BE an anchor, or be signed by one. Identity is compared on the DER bytes.
  const anchored = trusted.some((a) => a.raw.equals(top.raw) || (top.checkIssued(a) && top.verify(a.publicKey)));
  if (!anchored) return { error: 'the certificate chain does not reach a configured Apple root' };
  return { leaf: chain[0]! };
}

/**
 * Verify a signed payload and return it parsed. `alg` is pinned to ES256 (what Apple signs with) so a
 * forged header cannot talk us into a weaker one, and `none` is refused by jose anyway.
 */
export async function verifyAppleJws<T>(jws: string, anchors: string[], now: Date = new Date()): Promise<JwsVerifyResult<T>> {
  let header: { alg?: string; x5c?: string[] };
  try {
    header = decodeProtectedHeader(jws) as { alg?: string; x5c?: string[] };
  } catch {
    return { ok: false, error: 'not a signed payload' };
  }
  if (header.alg !== 'ES256') return { ok: false, error: `unexpected signing algorithm ${String(header.alg)}` };
  const { leaf, error } = verifyCertificateChain(header.x5c ?? [], anchors, now);
  if (!leaf) return { ok: false, error };
  try {
    const key = await importX509(leaf.toString(), 'ES256');
    const { payload } = await compactVerify(jws, key, { algorithms: ['ES256'] });
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(payload)) as T };
  } catch {
    return { ok: false, error: 'the signature does not match the certificate' };
  }
}

/**
 * The payload without checking anything, for the audit trail only. Nothing that decides what she is
 * entitled to may be read from this — that is what `verifyAppleJws` is for.
 */
export function unsafeDecodeJws<T>(jws: string): T | null {
  const part = jws.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
