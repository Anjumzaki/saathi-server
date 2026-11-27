/**
 * Google Play, for real.
 *
 * The app finishes a purchase on the phone and sends us the token; what she is entitled to is decided here,
 * from what Google says, and never from what the phone says. Three rules shape this file.
 *
 * It fails closed. No credentials, a package name that does not match the app, a token Google has never
 * heard of, a network that is down: every one of those refuses the purchase. Refusing a genuine purchase
 * costs an apology and a retry; granting a forged one costs Anjum a subscription for nothing.
 *
 * It never acknowledges a purchase it has not yet honoured. Google refunds anything unacknowledged after
 * three days, so acknowledging is the server's promise that the entitlement is stored. `verify` therefore
 * does not acknowledge; the route does, after the save, by calling `acknowledge`.
 *
 * A test purchase is not a purchase. Licence-tested buys from the Play Console come back marked, and on a
 * production server they are refused, the same way a sandbox receipt is on iOS.
 */
import type { PlayBilling } from '../interfaces';
import { log } from '../utils/logger';
import { playCredentials, type EnvSource, type PlayCredentials } from './storeCredentials';
import type { StoreInvalidReason, StorePurchaseState, StoreVerification } from './storeTypes';

const API = 'https://androidpublisher.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface PlayResponse {
  status: number;
  body: unknown;
}

/** The one seam the tests replace: everything below talks to Google only through this. */
export interface PlayHttp {
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<PlayResponse>;
}

/** Authenticated transport over `google-auth-library`'s service-account JWT flow. */
export function googlePlayHttp(creds: Pick<PlayCredentials, 'clientEmail' | 'privateKey'>): PlayHttp | null {
  let lib: typeof import('google-auth-library');
  try {
    // Required here, not at the top: the server must still start where this module cannot load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lib = require('google-auth-library') as typeof import('google-auth-library');
  } catch {
    log.warn('google-auth-library could not be loaded: Play purchases cannot be verified');
    return null;
  }
  const client = new lib.JWT({ email: creds.clientEmail, key: creds.privateKey, scopes: [SCOPE] });
  return {
    async call(method, path, body) {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('Play: no access token for the service account');
      const res = await fetch(API + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() : null };
    },
  };
}

/** The parts of purchases.subscriptionsv2 we read. Loosely typed: Google adds fields. */
interface SubscriptionV2 {
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  canceledStateContext?: unknown;
  testPurchase?: unknown;
  lineItems?: {
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { offerId?: string; basePlanId?: string; offerTags?: string[] };
  }[];
}

interface ProductPurchase {
  purchaseState?: number;
  consumptionState?: number;
  orderId?: string;
  productId?: string;
  /** 0 = a test purchase from a licence-tested account, 1 = promo, absent = a real payment. */
  purchaseType?: number;
  acknowledgementState?: number;
  purchaseTimeMillis?: string;
}

const STATES: Record<string, StorePurchaseState> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'in_grace',
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_CANCELED: 'canceled',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'pending',
};

/** Why an unusable state is unusable. Only a payment problem is worth telling her about. */
const STATE_REASON: Partial<Record<StorePurchaseState, StoreInvalidReason>> = {
  on_hold: 'payment',
  pending: 'payment',
  paused: 'payment',
  revoked: 'revoked',
};

const date = (ms: string | undefined): Date | undefined => {
  if (!ms) return undefined;
  const t = Number(ms);
  return Number.isFinite(t) && t > 0 ? new Date(t) : undefined;
};

/**
 * Is this line item a free trial? Read from the offer's tags, which is the field the Play Console exists to
 * let us set, rather than guessed from a price we are not told. An offer id that says "trial" counts too,
 * because that is the mistake everyone makes once.
 */
function isTrialOffer(offer: { offerId?: string; offerTags?: string[] } | undefined, trialTags: string[]): boolean {
  if (!offer) return false;
  const tags = (offer.offerTags ?? []).map((t) => t.toLowerCase());
  if (trialTags.some((t) => tags.includes(t.toLowerCase()))) return true;
  return /trial/i.test(offer.offerId ?? '');
}

/** Pure: a subscriptionsv2 body as an entitlement. Exported because this mapping is the whole risk. */
export function mapSubscriptionV2(raw: SubscriptionV2, opts: { trialOfferTags: string[]; production: boolean }): StoreVerification {
  const state = STATES[raw.subscriptionState ?? ''] ?? 'unknown';
  // A Play Console test buy on a production server is not a payment. Same rule as a sandbox receipt on iOS.
  if (raw.testPurchase && opts.production) {
    return { valid: false, invalidReason: 'environment', state, environment: 'sandbox' };
  }
  const items = raw.lineItems ?? [];
  // A subscription can carry several line items; the one that runs longest is the one she is entitled by.
  let item = items[0];
  let expiresAt: Date | undefined;
  for (const li of items) {
    const at = Date.parse(li.expiryTime ?? '');
    if (!Number.isFinite(at)) continue;
    if (!expiresAt || at > expiresAt.getTime()) {
      expiresAt = new Date(at);
      item = li;
    }
  }
  const autoRenewing = item?.autoRenewingPlan?.autoRenewEnabled !== false && !raw.canceledStateContext;
  const base: StoreVerification = {
    valid: false,
    state,
    productId: item?.productId,
    orderId: raw.latestOrderId,
    expiresAt,
    autoRenewing,
    acknowledged: raw.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    linkedPurchaseToken: raw.linkedPurchaseToken ?? null,
    environment: raw.testPurchase ? 'sandbox' : 'production',
    inGracePeriod: state === 'in_grace',
    isTrial: isTrialOffer(item?.offerDetails, opts.trialOfferTags),
  };
  const usable = state === 'active' || state === 'in_grace' || state === 'canceled';
  if (!usable || !expiresAt) return { ...base, invalidReason: STATE_REASON[state] };
  return { ...base, valid: true };
}

/** Pure: a products.get body as a verification. One-off purchases have no expiry; the order is the record. */
export function mapProductPurchase(raw: ProductPurchase, opts: { production: boolean }): StoreVerification {
  if (raw.purchaseType === 0 && opts.production) {
    return { valid: false, invalidReason: 'environment', environment: 'sandbox' };
  }
  // 0 purchased, 1 canceled (refunded), 2 pending.
  if (raw.purchaseState === 1) return { valid: false, invalidReason: 'revoked', state: 'revoked' };
  if (raw.purchaseState === 2) return { valid: false, invalidReason: 'payment', state: 'pending' };
  if (raw.purchaseState !== 0) return { valid: false, invalidReason: 'not_found', state: 'unknown' };
  return {
    valid: true,
    state: 'active',
    productId: raw.productId,
    orderId: raw.orderId,
    acknowledged: raw.acknowledgementState === 1,
    environment: raw.purchaseType === 0 ? 'sandbox' : 'production',
  };
}

const enc = encodeURIComponent;

export class GooglePlayBilling implements PlayBilling {
  constructor(
    private readonly deps: {
      http: PlayHttp;
      packageName: string;
      trialOfferTags?: string[];
      /** A production server refuses test purchases. Read once, injected so a test can choose. */
      production?: boolean;
    },
  ) {}

  private get production(): boolean {
    return this.deps.production ?? process.env['NODE_ENV'] === 'production';
  }

  private get trialTags(): string[] {
    return this.deps.trialOfferTags ?? ['trial'];
  }

  private app(path: string): string {
    return `/androidpublisher/v3/applications/${enc(this.deps.packageName)}${path}`;
  }

  /** Anything other than a clean 200 is a refusal, with the reason kept apart from a payment problem. */
  private refusal(res: PlayResponse, what: string): StoreVerification {
    if (res.status === 404 || res.status === 400) {
      log.warn('Play refused a purchase lookup', { what, status: res.status });
      return { valid: false, invalidReason: 'not_found' };
    }
    log.error('Play purchase lookup failed', { what, status: res.status });
    return { valid: false, invalidReason: 'unverified' };
  }

  async verify(args: { productId: string; purchaseToken: string; kind: 'subscription' | 'product' }): Promise<StoreVerification> {
    if (args.kind === 'product') {
      const res = await this.deps.http.call('GET', this.app(`/purchases/products/${enc(args.productId)}/tokens/${enc(args.purchaseToken)}`));
      if (res.status !== 200) return this.refusal(res, 'product');
      const v = mapProductPurchase((res.body ?? {}) as ProductPurchase, { production: this.production });
      // products.get does not echo the product id on every API version; the caller asked about this one.
      return { ...v, productId: v.productId ?? args.productId };
    }
    const v = await this.subscriptionByToken(args.purchaseToken);
    // The token is the authority on which product it is. A mismatch means the app sent the wrong pair.
    if (v.valid && v.productId && v.productId !== args.productId) {
      log.warn('Play: purchase token is for another product', { asked: args.productId });
      return { valid: false, invalidReason: 'not_found', state: v.state };
    }
    return v;
  }

  /** Reads a subscription from its token alone, which is all a store notification gives us. */
  async subscriptionByToken(purchaseToken: string): Promise<StoreVerification> {
    const res = await this.deps.http.call('GET', this.app(`/purchases/subscriptionsv2/tokens/${enc(purchaseToken)}`));
    if (res.status !== 200) return this.refusal(res, 'subscription');
    return mapSubscriptionV2((res.body ?? {}) as SubscriptionV2, { trialOfferTags: this.trialTags, production: this.production });
  }

  /**
   * Tell Google we have honoured the purchase. Called only once the entitlement is saved: until then an
   * unacknowledged purchase is Google's cue to refund her, which is exactly what should happen if we
   * crashed before storing it.
   */
  async acknowledge(args: { productId: string; purchaseToken: string; kind: 'subscription' | 'product' }): Promise<void> {
    const path =
      args.kind === 'product'
        ? this.app(`/purchases/products/${enc(args.productId)}/tokens/${enc(args.purchaseToken)}:acknowledge`)
        : this.app(`/purchases/subscriptions/${enc(args.productId)}/tokens/${enc(args.purchaseToken)}:acknowledge`);
    const res = await this.deps.http.call('POST', path, {});
    // 200 and 204 are both success; 409/400 usually means it was already acknowledged, which is fine.
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 400 || res.status === 409) {
      log.warn('Play acknowledgement was refused as already done', { status: res.status });
      return;
    }
    throw new Error(`Play acknowledgement failed with ${res.status}`);
  }

  /**
   * Give her money back. Play refunds by order, so an order id is needed: the caller has it on the Order
   * row (`playOrderId`), and failing that we read it from the purchase. Revoking as well as refunding, so
   * a refunded plan does not stay unlocked.
   */
  async refund(args: { purchaseToken: string; productId?: string; orderId?: string }): Promise<void> {
    let orderId = args.orderId;
    if (!orderId && args.productId) {
      const res = await this.deps.http.call('GET', this.app(`/purchases/products/${enc(args.productId)}/tokens/${enc(args.purchaseToken)}`));
      if (res.status === 200) orderId = (res.body as ProductPurchase).orderId;
    }
    if (!orderId) throw new Error('Play refund needs the order id (pass orderId or productId)');
    const res = await this.deps.http.call('POST', this.app(`/orders/${enc(orderId)}:refund?revoke=true`), {});
    if (res.status >= 200 && res.status < 300) {
      log.info('Play refund issued', { orderId });
      return;
    }
    // Already refunded: Google answers 400. Treat as done rather than blocking the order from closing.
    if (res.status === 400 && /already/i.test(JSON.stringify(res.body ?? ''))) {
      log.warn('Play says this order was already refunded', { orderId });
      return;
    }
    throw new Error(`Play refund failed with ${res.status}`);
  }
}

/** The live client, or null when Anjum has not added a service account yet. */
export function livePlayBilling(src: EnvSource = process.env): GooglePlayBilling | null {
  const creds = playCredentials(src);
  if (!creds) return null;
  const http = googlePlayHttp(creds);
  if (!http) return null;
  return new GooglePlayBilling({
    http,
    packageName: creds.packageName,
    trialOfferTags: creds.trialOfferTags,
    production: src['NODE_ENV'] === 'production',
  });
}
