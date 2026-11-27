/**
 * The App Store, for real.
 *
 * Two things here are not optional, because getting either wrong gives Premium away.
 *
 * The bundle id and the environment are checked on every single payload. Apple will happily sell the same
 * product in the sandbox, for nothing, to anyone with Xcode; a sandbox transaction reaching a production
 * server is refused outright rather than treated as a purchase. The same check catches a signed payload
 * that is genuinely Apple's but belongs to somebody else's app.
 *
 * The identity we key on is the original transaction id, not the transaction id. Every renewal mints a new
 * transaction; only the original one stays the same for as long as she keeps paying, so it is what we store
 * and what a server notification is matched against.
 */
import type { AppStoreBilling } from '../interfaces';
import { log } from '../utils/logger';
import { appStoreCredentials, appStoreTrustAnchors, type AppStoreCredentials, type EnvSource } from './storeCredentials';
import { unsafeDecodeJws, verifyAppleJws } from './storeJws';
import type { StorePurchaseState, StoreVerification } from './storeTypes';

type Jose = typeof import('jose');

export const APP_STORE_HOSTS = {
  production: 'https://api.storekit.itunes.apple.com',
  sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
} as const;

/** How long the request token we sign lives. Apple's ceiling is an hour; a short life needs no revocation. */
const TOKEN_TTL_SECONDS = 20 * 60;

export interface AppStoreResponse {
  status: number;
  body: unknown;
}

/** The one seam the tests replace. */
export interface AppStoreHttp {
  call(method: 'GET', path: string): Promise<AppStoreResponse>;
}

/** What Apple signs into a transaction. Only the fields we act on are named. */
export interface AppleTransaction {
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
  bundleId?: string;
  environment?: string;
  type?: string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  offerType?: number;
  offerDiscountType?: string;
  inAppOwnershipType?: string;
}

export interface AppleRenewalInfo {
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  expirationIntent?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  originalTransactionId?: string;
  environment?: string;
  renewalDate?: number;
}

/** Apple's subscription status codes, as they arrive on `lastTransactions[].status`. */
export const APPLE_STATUS: Record<number, StorePurchaseState> = {
  1: 'active',
  2: 'expired',
  3: 'on_hold',
  4: 'in_grace',
  5: 'revoked',
};

const at = (ms: number | undefined): Date | undefined => (typeof ms === 'number' && ms > 0 ? new Date(ms) : undefined);

/** Apple writes "Production" and "Sandbox"; we store them lower case. */
export const normaliseEnvironment = (v: string | undefined): 'production' | 'sandbox' | undefined =>
  v === 'Production' || v === 'production' ? 'production' : v === 'Sandbox' || v === 'sandbox' ? 'sandbox' : undefined;

/**
 * Pure: a signed transaction (and its renewal info, when there is one) as an entitlement.
 *
 * The environment and bundle id are checked first and refuse everything else, so no path through this
 * function can grant Premium from a sandbox purchase on a production server.
 */
export function mapAppleTransaction(
  tx: AppleTransaction,
  renewal: AppleRenewalInfo | null,
  opts: { bundleId: string; environment: 'production' | 'sandbox'; status?: number | undefined },
): StoreVerification {
  const environment = normaliseEnvironment(tx.environment ?? renewal?.environment);
  if (tx.bundleId && tx.bundleId !== opts.bundleId) {
    log.warn('App Store: transaction is for another app');
    return { valid: false, invalidReason: 'environment' };
  }
  if (environment !== opts.environment) {
    log.warn('App Store: transaction is from the wrong environment', { saw: environment ?? 'unknown', expected: opts.environment });
    return { valid: false, invalidReason: 'environment', environment };
  }
  const state: StorePurchaseState = tx.revocationDate
    ? 'revoked'
    : (opts.status !== undefined ? APPLE_STATUS[opts.status] : undefined) ?? 'unknown';
  // In a grace period Apple keeps her entitled past the paid expiry, so the later of the two is the truth.
  const expiry = at(tx.expiresDate);
  const grace = at(renewal?.gracePeriodExpiresDate);
  const expiresAt = grace && (!expiry || grace > expiry) ? grace : expiry;
  const autoRenewing = renewal ? renewal.autoRenewStatus === 1 : undefined;
  const base: StoreVerification = {
    valid: false,
    state,
    productId: tx.productId,
    // The transaction that will not change under her, which is what we store and match notifications on.
    orderId: tx.originalTransactionId ?? tx.transactionId,
    originalTransactionId: tx.originalTransactionId ?? tx.transactionId ?? null,
    expiresAt,
    autoRenewing,
    environment,
    inGracePeriod: state === 'in_grace',
    // A free trial, read from the offer Apple signed: "1" is an introductory offer, and FREE_TRIAL says it costs nothing.
    isTrial: tx.offerDiscountType === 'FREE_TRIAL' || (tx.offerType === 1 && !tx.offerDiscountType),
  };
  if (tx.revocationDate) return { ...base, invalidReason: 'revoked' };
  // A non-renewing or one-off purchase has no expiry and no renewal info: it is good as long as it stands.
  if (!expiresAt) {
    const oneOff = tx.type === 'Non-Consumable' || tx.type === 'Consumable';
    return oneOff ? { ...base, valid: true, state: 'active' } : { ...base, invalidReason: 'not_found' };
  }
  if (state === 'on_hold') return { ...base, invalidReason: 'payment' };
  if (state === 'expired') return { ...base };
  if (state === 'active' || state === 'in_grace' || state === 'unknown') return { ...base, valid: true, state: state === 'unknown' ? 'active' : state };
  return { ...base };
}

/** Signs each request with the App Store Connect key. `jose` does the ES256; nothing is cached but the key. */
export function appStoreHttp(creds: AppStoreCredentials): AppStoreHttp {
  const host = APP_STORE_HOSTS[creds.environment];
  // The .p8 is parsed once and kept; the request token itself is signed fresh and lives twenty minutes.
  let key: ReturnType<Jose['importPKCS8']> | undefined;
  return {
    async call(method, path) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const jose = require('jose') as Jose;
      key ??= jose.importPKCS8(creds.privateKey, 'ES256');
      const now = Math.floor(Date.now() / 1000);
      const token = await new jose.SignJWT({ bid: creds.bundleId })
        .setProtectedHeader({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' })
        .setIssuer(creds.issuerId)
        .setAudience('appstoreconnect-v1')
        .setIssuedAt(now)
        .setExpirationTime(now + TOKEN_TTL_SECONDS)
        .sign(await key);
      const res = await fetch(host + path, { method, headers: { authorization: `Bearer ${token}` } });
      const text = await res.text();
      return { status: res.status, body: text ? ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() : null };
    },
  };
}

interface StatusResponse {
  environment?: string;
  bundleId?: string;
  data?: { lastTransactions?: { originalTransactionId?: string; status?: number; signedTransactionInfo?: string; signedRenewalInfo?: string }[] }[];
}

export class AppStoreServerBilling implements AppStoreBilling {
  constructor(
    private readonly deps: {
      http: AppStoreHttp;
      bundleId: string;
      environment: 'production' | 'sandbox';
      /** Apple roots. Empty means an API payload is read on the strength of the TLS call alone. */
      anchors?: string[];
    },
  ) {}

  /**
   * A payload from the API. Its signature is checked when a trust anchor is configured; without one we are
   * relying on the authenticated call to Apple's own host, which is why a NOTIFICATION — which arrives with
   * no such call behind it — is never read this way.
   */
  private async read<T>(jws: string | undefined): Promise<T | null> {
    if (!jws) return null;
    const anchors = this.deps.anchors ?? [];
    if (!anchors.length) return unsafeDecodeJws<T>(jws);
    const r = await verifyAppleJws<T>(jws, anchors);
    if (!r.ok) {
      log.warn('App Store: a signed payload from the API did not verify', { error: r.error });
      return null;
    }
    return r.payload ?? null;
  }

  async verify(args: { productId: string; transactionId: string }): Promise<StoreVerification> {
    const v = await this.byOriginalTransactionId(args.transactionId);
    if (v.valid && v.productId && v.productId !== args.productId) {
      log.warn('App Store: transaction is for another product', { asked: args.productId });
      return { valid: false, invalidReason: 'not_found', state: v.state };
    }
    return v;
  }

  /** The subscription behind an original transaction id, which is all a notification gives us. */
  async byOriginalTransactionId(originalTransactionId: string): Promise<StoreVerification> {
    const id = encodeURIComponent(originalTransactionId);
    const res = await this.deps.http.call('GET', `/inApps/v1/subscriptions/${id}`);
    if (res.status === 200) {
      const body = (res.body ?? {}) as StatusResponse;
      const rows = (body.data ?? []).flatMap((d) => d.lastTransactions ?? []);
      const row = rows.find((t) => t.originalTransactionId === originalTransactionId) ?? rows[0];
      if (!row) return { valid: false, invalidReason: 'not_found' };
      const tx = await this.read<AppleTransaction>(row.signedTransactionInfo);
      if (!tx) return { valid: false, invalidReason: 'unverified' };
      const renewal = await this.read<AppleRenewalInfo>(row.signedRenewalInfo);
      return mapAppleTransaction(tx, renewal, { bundleId: this.deps.bundleId, environment: this.deps.environment, status: row.status });
    }
    // Not a subscription: it may be a one-off product, which lives under a different path.
    if (res.status === 404) return this.oneOff(originalTransactionId);
    log.error('App Store lookup failed', { status: res.status });
    return { valid: false, invalidReason: 'unverified' };
  }

  private async oneOff(transactionId: string): Promise<StoreVerification> {
    const res = await this.deps.http.call('GET', `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
    if (res.status !== 200) {
      if (res.status === 404) return { valid: false, invalidReason: 'not_found' };
      return { valid: false, invalidReason: 'unverified' };
    }
    const tx = await this.read<AppleTransaction>((res.body as { signedTransactionInfo?: string }).signedTransactionInfo);
    if (!tx) return { valid: false, invalidReason: 'unverified' };
    return mapAppleTransaction(tx, null, { bundleId: this.deps.bundleId, environment: this.deps.environment });
  }
}

/** The live client, or null when Anjum has not added an App Store key yet. */
export function liveAppStoreBilling(src: EnvSource = process.env): AppStoreServerBilling | null {
  const creds = appStoreCredentials(src);
  if (!creds) return null;
  return new AppStoreServerBilling({
    http: appStoreHttp(creds),
    bundleId: creds.bundleId,
    environment: creds.environment,
    anchors: appStoreTrustAnchors(src),
  });
}
