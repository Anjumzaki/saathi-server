import { describe, expect, it } from 'vitest';
import {
  APPLE_STATUS,
  AppStoreServerBilling,
  liveAppStoreBilling,
  mapAppleTransaction,
  normaliseEnvironment,
  type AppStoreHttp,
} from '../src/services/appStore';
import {
  GooglePlayBilling,
  livePlayBilling,
  mapProductPurchase,
  mapSubscriptionV2,
  type PlayHttp,
  type PlayResponse,
} from '../src/services/playBilling';
import {
  appStoreCredentials,
  appStoreEnvironment,
  appStoreTrustAnchors,
  playCredentials,
  rtdnCredentials,
} from '../src/services/storeCredentials';
import { entitlementFromPlay, hasFeature, resolveEntitlement } from '../src/services/entitlement';
import { ROOT_CERT_PEM } from './fixtures/appleCerts';

const EXPIRY = '2027-01-15T10:00:00.000Z';
const expiryDate = new Date(EXPIRY);

const subBody = (over: Record<string, unknown> = {}) => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.3301-1234',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  lineItems: [
    {
      productId: 'saathi_premium_monthly',
      expiryTime: EXPIRY,
      autoRenewingPlan: { autoRenewEnabled: true },
      offerDetails: { basePlanId: 'monthly', offerTags: [] as string[] },
    },
  ],
  ...over,
});

/** A Play transport that answers from one handler and remembers every call, in order. */
function fakePlayHttp(handler: (method: string, path: string, body?: unknown) => PlayResponse) {
  const calls: { method: string; path: string }[] = [];
  const http: PlayHttp = {
    async call(method, path, body) {
      calls.push({ method, path });
      return handler(method, path, body);
    },
  };
  return { http, calls };
}

const PROD = { production: true, trialOfferTags: ['trial'] };

describe('reading a Play subscription', () => {
  it('grants from what Google said, and reports the rest for the route to use', () => {
    const v = mapSubscriptionV2(subBody(), PROD);
    expect(v).toMatchObject({
      valid: true,
      state: 'active',
      productId: 'saathi_premium_monthly',
      orderId: 'GPA.3301-1234',
      autoRenewing: true,
      acknowledged: false,
      isTrial: false,
    });
    expect(v.expiresAt?.toISOString()).toBe(EXPIRY);
    // The entitlement is built by the existing rule, not by anything in the store client.
    expect(entitlementFromPlay(v, 'monthly', new Date('2026-12-01T00:00:00Z'), 'google_play', 'premium')).toMatchObject({ status: 'active', tier: 'premium' });
  });

  it('calls auto-renew off "canceled" rather than gone: the paid period still runs', () => {
    const v = mapSubscriptionV2(subBody({ subscriptionState: 'SUBSCRIPTION_STATE_CANCELED', canceledStateContext: { userInitiatedCancellation: {} } }), PROD);
    expect(v).toMatchObject({ valid: true, state: 'canceled', autoRenewing: false });
    const ent = entitlementFromPlay(v, 'monthly', new Date('2026-12-01T00:00:00Z'), 'google_play', 'premium');
    expect(ent.status).toBe('canceled');
    // A cancelled-but-paid period still earns the dietitian discount; a trial never does.
    expect(hasFeature(ent, 'dietitian_discount', new Date('2026-12-01T00:00:00Z'))).toBe(true);
  });

  it('keeps her entitled through a grace period and cuts her off on hold', () => {
    const grace = mapSubscriptionV2(subBody({ subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' }), PROD);
    expect(grace).toMatchObject({ valid: true, state: 'in_grace', inGracePeriod: true });
    const hold = mapSubscriptionV2(subBody({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }), PROD);
    expect(hold).toMatchObject({ valid: false, invalidReason: 'payment', state: 'on_hold' });
    const paused = mapSubscriptionV2(subBody({ subscriptionState: 'SUBSCRIPTION_STATE_PAUSED' }), PROD);
    expect(paused.valid).toBe(false);
    const expired = mapSubscriptionV2(subBody({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }), PROD);
    expect(expired).toMatchObject({ valid: false, state: 'expired' });
  });

  it('reads a free trial from the offer tag, which is the field the Console exists to set', () => {
    const tagged = subBody({ lineItems: [{ productId: 'p', expiryTime: EXPIRY, offerDetails: { offerId: 'intro', offerTags: ['TRIAL'] } }] });
    expect(mapSubscriptionV2(tagged, PROD).isTrial).toBe(true);
    const named = subBody({ lineItems: [{ productId: 'p', expiryTime: EXPIRY, offerDetails: { offerId: 'seven-day-trial', offerTags: [] } }] });
    expect(mapSubscriptionV2(named, PROD).isTrial).toBe(true);
    const plain = subBody({ lineItems: [{ productId: 'p', expiryTime: EXPIRY, offerDetails: { offerId: 'half-price', offerTags: ['promo'] } }] });
    expect(mapSubscriptionV2(plain, PROD).isTrial).toBe(false);
  });

  it('refuses a Play Console test purchase on a production server, and allows it in development', () => {
    const test = subBody({ testPurchase: {} });
    expect(mapSubscriptionV2(test, PROD)).toMatchObject({ valid: false, invalidReason: 'environment', environment: 'sandbox' });
    expect(mapSubscriptionV2(test, { production: false, trialOfferTags: [] })).toMatchObject({ valid: true, environment: 'sandbox' });
  });

  it('follows the longest line item and carries the token an upgrade replaced', () => {
    const v = mapSubscriptionV2(
      subBody({
        linkedPurchaseToken: 'old-token',
        lineItems: [
          { productId: 'a', expiryTime: '2026-12-01T00:00:00.000Z' },
          { productId: 'saathi_plus_yearly', expiryTime: EXPIRY },
        ],
      }),
      PROD,
    );
    expect(v.productId).toBe('saathi_plus_yearly');
    expect(v.expiresAt?.toISOString()).toBe(EXPIRY);
    expect(v.linkedPurchaseToken).toBe('old-token');
  });
});

describe('reading a Play one-off purchase', () => {
  it('is good when purchased, and refused when refunded, pending or a test buy', () => {
    expect(mapProductPurchase({ purchaseState: 0, orderId: 'GPA.9', acknowledgementState: 1, productId: 'plan_full' }, { production: true }))
      .toMatchObject({ valid: true, orderId: 'GPA.9', acknowledged: true });
    expect(mapProductPurchase({ purchaseState: 1 }, { production: true })).toMatchObject({ valid: false, invalidReason: 'revoked' });
    expect(mapProductPurchase({ purchaseState: 2 }, { production: true })).toMatchObject({ valid: false, invalidReason: 'payment' });
    expect(mapProductPurchase({ purchaseState: 0, purchaseType: 0 }, { production: true })).toMatchObject({ valid: false, invalidReason: 'environment' });
    expect(mapProductPurchase({ purchaseState: 0, purchaseType: 0 }, { production: false }).valid).toBe(true);
  });
});

describe('the Play client against the API', () => {
  const client = (handler: (m: string, p: string, b?: unknown) => PlayResponse) => {
    const f = fakePlayHttp(handler);
    return { billing: new GooglePlayBilling({ http: f.http, packageName: 'com.multiware.saathi', production: true }), calls: f.calls };
  };

  it('asks subscriptionsv2 for the token under the right package', async () => {
    const { billing, calls } = client(() => ({ status: 200, body: subBody() }));
    const v = await billing.verify({ productId: 'saathi_premium_monthly', purchaseToken: 'tok-1', kind: 'subscription' });
    expect(v.valid).toBe(true);
    expect(calls[0]).toEqual({ method: 'GET', path: '/androidpublisher/v3/applications/com.multiware.saathi/purchases/subscriptionsv2/tokens/tok-1' });
  });

  it('refuses a token Google has never heard of, and says it is not a payment problem', async () => {
    const { billing } = client(() => ({ status: 404, body: { error: { message: 'not found' } } }));
    expect(await billing.verify({ productId: 'p', purchaseToken: 'forged-token', kind: 'subscription' }))
      .toMatchObject({ valid: false, invalidReason: 'not_found' });
  });

  it('refuses rather than guesses when Google cannot be reached', async () => {
    const { billing } = client(() => ({ status: 503, body: null }));
    expect(await billing.verify({ productId: 'p', purchaseToken: 'tok', kind: 'subscription' }))
      .toMatchObject({ valid: false, invalidReason: 'unverified' });
  });

  it('refuses a token that belongs to a different product', async () => {
    const { billing } = client(() => ({ status: 200, body: subBody() }));
    expect(await billing.verify({ productId: 'saathi_plus_yearly', purchaseToken: 'tok', kind: 'subscription' }))
      .toMatchObject({ valid: false, invalidReason: 'not_found' });
  });

  it('acknowledges a subscription and tolerates having already done so', async () => {
    const { billing, calls } = client((_m, p) => (p.includes(':acknowledge') ? { status: 200, body: null } : { status: 200, body: subBody() }));
    await billing.acknowledge({ productId: 'saathi_premium_monthly', purchaseToken: 'tok-1', kind: 'subscription' });
    expect(calls[0]!.path).toBe('/androidpublisher/v3/applications/com.multiware.saathi/purchases/subscriptions/saathi_premium_monthly/tokens/tok-1:acknowledge');
    const again = client(() => ({ status: 409, body: { error: 'already acknowledged' } }));
    await expect(again.billing.acknowledge({ productId: 'p', purchaseToken: 't', kind: 'subscription' })).resolves.toBeUndefined();
    const broken = client(() => ({ status: 500, body: null }));
    await expect(broken.billing.acknowledge({ productId: 'p', purchaseToken: 't', kind: 'product' })).rejects.toThrow(/500/);
  });

  it('refunds by order, revoking the purchase with it', async () => {
    const { billing, calls } = client(() => ({ status: 204, body: null }));
    await billing.refund({ purchaseToken: 'tok', orderId: 'GPA.777' });
    expect(calls[0]).toEqual({ method: 'POST', path: '/androidpublisher/v3/applications/com.multiware.saathi/orders/GPA.777:refund?revoke=true' });
  });

  it('finds the order from the token when only the product is known', async () => {
    const { billing, calls } = client((m) => (m === 'GET' ? { status: 200, body: { orderId: 'GPA.42', purchaseState: 0 } } : { status: 200, body: {} }));
    await billing.refund({ purchaseToken: 'tok', productId: 'plan_full' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1]!.path).toContain('/orders/GPA.42:refund');
  });

  it('refuses to pretend a refund happened when it cannot name the order', async () => {
    const { billing } = client(() => ({ status: 200, body: {} }));
    await expect(billing.refund({ purchaseToken: 'tok' })).rejects.toThrow(/order id/);
    const failing = client((m) => (m === 'GET' ? { status: 200, body: { orderId: 'GPA.1' } } : { status: 500, body: null }));
    await expect(failing.billing.refund({ purchaseToken: 'tok', productId: 'p' })).rejects.toThrow(/500/);
  });
});

/* ------------------------------------------------------------------ App Store */

const tx = (over: Record<string, unknown> = {}) => ({
  transactionId: '2000000111',
  originalTransactionId: '1000000999',
  productId: 'saathi_premium_monthly',
  bundleId: 'com.multiware.saathi',
  environment: 'Production',
  type: 'Auto-Renewable Subscription',
  expiresDate: expiryDate.getTime(),
  ...over,
});

const bundled = { bundleId: 'com.multiware.saathi', environment: 'production' as const };

describe('reading an App Store transaction', () => {
  it('grants, and keeps the original transaction id as the identity', () => {
    const v = mapAppleTransaction(tx(), { autoRenewStatus: 1 }, { ...bundled, status: 1 });
    expect(v).toMatchObject({ valid: true, state: 'active', autoRenewing: true, originalTransactionId: '1000000999', orderId: '1000000999' });
    expect(v.expiresAt?.toISOString()).toBe(EXPIRY);
  });

  it('refuses a sandbox transaction on a production server', () => {
    const v = mapAppleTransaction(tx({ environment: 'Sandbox' }), { autoRenewStatus: 1 }, { ...bundled, status: 1 });
    expect(v).toMatchObject({ valid: false, invalidReason: 'environment', environment: 'sandbox' });
    // ...and the same receipt is fine on a sandbox deployment.
    expect(mapAppleTransaction(tx({ environment: 'Sandbox' }), { autoRenewStatus: 1 }, { bundleId: bundled.bundleId, environment: 'sandbox', status: 1 }).valid).toBe(true);
  });

  it('refuses another app\'s transaction even when Apple signed it', () => {
    expect(mapAppleTransaction(tx({ bundleId: 'com.someone.else' }), null, { ...bundled, status: 1 }))
      .toMatchObject({ valid: false, invalidReason: 'environment' });
  });

  it('reads a free trial from the offer and keeps the discount rules for the paid period', () => {
    const trial = mapAppleTransaction(tx({ offerType: 1, offerDiscountType: 'FREE_TRIAL' }), { autoRenewStatus: 1 }, { ...bundled, status: 1 });
    expect(trial.isTrial).toBe(true);
    const ent = entitlementFromPlay(trial, 'monthly', new Date('2026-12-01T00:00:00Z'), 'app_store', 'premium');
    expect(ent.status).toBe('trialing');
    const resolved = resolveEntitlement(ent, new Date('2026-12-01T00:00:00Z'));
    expect(resolved.features).not.toContain('dietitian_discount');
    expect(resolved.features).not.toContain('merchant_discount');
    expect(resolved.features).toContain('plan_read_ai');
  });

  it('uses the later of expiry and grace-period end while the card is retried', () => {
    const later = expiryDate.getTime() + 16 * 86_400_000;
    const v = mapAppleTransaction(tx(), { autoRenewStatus: 1, isInBillingRetryPeriod: true, gracePeriodExpiresDate: later }, { ...bundled, status: 4 });
    expect(v).toMatchObject({ valid: true, state: 'in_grace', inGracePeriod: true });
    expect(v.expiresAt?.getTime()).toBe(later);
  });

  it('refuses a revoked transaction and a billing-retry one with no grace', () => {
    expect(mapAppleTransaction(tx({ revocationDate: Date.now(), revocationReason: 1 }), null, { ...bundled, status: 5 }))
      .toMatchObject({ valid: false, invalidReason: 'revoked', state: 'revoked' });
    expect(mapAppleTransaction(tx(), { autoRenewStatus: 1, isInBillingRetryPeriod: true }, { ...bundled, status: 3 }))
      .toMatchObject({ valid: false, invalidReason: 'payment', state: 'on_hold' });
  });

  it('knows Apple\'s status codes and both spellings of the environment', () => {
    expect(APPLE_STATUS[1]).toBe('active');
    expect(APPLE_STATUS[4]).toBe('in_grace');
    expect(APPLE_STATUS[5]).toBe('revoked');
    expect(normaliseEnvironment('Production')).toBe('production');
    expect(normaliseEnvironment('Sandbox')).toBe('sandbox');
    expect(normaliseEnvironment(undefined)).toBeUndefined();
  });
});

/** A JWS with a real payload and a signature nobody checks: for the paths where no anchor is configured. */
const unsignedJws = (payload: unknown): string =>
  `${Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;

describe('the App Store client against the API', () => {
  const client = (handler: (path: string) => { status: number; body: unknown }) => {
    const paths: string[] = [];
    const http: AppStoreHttp = {
      async call(_m, path) {
        paths.push(path);
        return handler(path);
      },
    };
    return { billing: new AppStoreServerBilling({ http, ...bundled }), paths };
  };

  it('asks for the subscription behind the original transaction id', async () => {
    const { billing, paths } = client(() => ({
      status: 200,
      body: { data: [{ lastTransactions: [{ originalTransactionId: '1000000999', status: 1, signedTransactionInfo: unsignedJws(tx()), signedRenewalInfo: unsignedJws({ autoRenewStatus: 1 }) }] }] },
    }));
    const v = await billing.verify({ productId: 'saathi_premium_monthly', transactionId: '1000000999' });
    expect(v).toMatchObject({ valid: true, state: 'active' });
    expect(paths[0]).toBe('/inApps/v1/subscriptions/1000000999');
  });

  it('refuses a transaction id Apple does not know, after trying the one-off path', async () => {
    const { billing, paths } = client(() => ({ status: 404, body: null }));
    expect(await billing.verify({ productId: 'p', transactionId: 'forged' })).toMatchObject({ valid: false, invalidReason: 'not_found' });
    expect(paths).toEqual(['/inApps/v1/subscriptions/forged', '/inApps/v1/transactions/forged']);
  });

  it('reads a one-off purchase when the subscription path has nothing', async () => {
    const { billing } = client((p) =>
      p.startsWith('/inApps/v1/transactions')
        ? { status: 200, body: { signedTransactionInfo: unsignedJws(tx({ type: 'Non-Consumable', expiresDate: undefined })) } }
        : { status: 404, body: null },
    );
    expect(await billing.verify({ productId: 'saathi_premium_monthly', transactionId: '1000000999' })).toMatchObject({ valid: true, state: 'active' });
  });

  it('refuses rather than guesses when Apple cannot be reached', async () => {
    const { billing } = client(() => ({ status: 500, body: null }));
    expect(await billing.verify({ productId: 'p', transactionId: '1' })).toMatchObject({ valid: false, invalidReason: 'unverified' });
  });

  it('will not read a payload whose signature fails once a trust anchor is configured', async () => {
    const http: AppStoreHttp = {
      async call() {
        return { status: 200, body: { data: [{ lastTransactions: [{ originalTransactionId: '1', status: 1, signedTransactionInfo: unsignedJws(tx()) }] }] } };
      },
    };
    const billing = new AppStoreServerBilling({ http, ...bundled, anchors: [ROOT_CERT_PEM] });
    expect(await billing.verify({ productId: 'p', transactionId: '1' })).toMatchObject({ valid: false, invalidReason: 'unverified' });
  });
});

describe('with no store credentials at all, which is where Saathi is today', () => {
  it('builds no Play client and no App Store client', () => {
    expect(playCredentials({})).toBeNull();
    expect(livePlayBilling({})).toBeNull();
    expect(appStoreCredentials({})).toBeNull();
    expect(liveAppStoreBilling({})).toBeNull();
    expect(rtdnCredentials({})).toBeNull();
    expect(appStoreTrustAnchors({})).toEqual([]);
  });

  it('refuses a half-configured Play service account rather than half-working', () => {
    expect(playCredentials({ PLAY_SERVICE_ACCOUNT_EMAIL: 'a@b.iam.gserviceaccount.com', PLAY_PACKAGE_NAME: 'com.multiware.saathi' })).toBeNull();
    expect(playCredentials({ PLAY_SERVICE_ACCOUNT_JSON: 'not json', PLAY_PACKAGE_NAME: 'x' })).toBeNull();
    // No package name is no verification either: it is part of every URL.
    expect(playCredentials({ PLAY_SERVICE_ACCOUNT_EMAIL: 'a@b', PLAY_SERVICE_ACCOUNT_PRIVATE_KEY: 'k' })).toBeNull();
  });

  it('takes the service-account JSON and unescapes the key', () => {
    const c = playCredentials({
      PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----' }),
      PLAY_PACKAGE_NAME: 'com.multiware.saathi',
      PLAY_TRIAL_OFFER_TAGS: 'free-trial, trial',
    });
    expect(c).toMatchObject({ clientEmail: 'a@b.iam.gserviceaccount.com', packageName: 'com.multiware.saathi', trialOfferTags: ['free-trial', 'trial'] });
    expect(c!.privateKey).toContain('\nkey\n');
  });

  it('needs all four App Store parts, and treats anything but production as sandbox', () => {
    const base = { APP_STORE_KEY_ID: 'K', APP_STORE_ISSUER_ID: 'I', APP_STORE_PRIVATE_KEY: 'P', APP_STORE_BUNDLE_ID: 'com.multiware.saathi' };
    expect(appStoreCredentials(base)).toMatchObject({ environment: 'sandbox' });
    expect(appStoreCredentials({ ...base, NODE_ENV: 'production' })).toMatchObject({ environment: 'production' });
    expect(appStoreCredentials({ ...base, NODE_ENV: 'production', APP_STORE_ENVIRONMENT: 'sandbox' })).toMatchObject({ environment: 'sandbox' });
    expect(appStoreEnvironment({})).toBe('sandbox');
    for (const k of Object.keys(base)) {
      const missing = { ...base } as Record<string, string | undefined>;
      delete missing[k];
      expect(appStoreCredentials(missing)).toBeNull();
    }
  });

  it('reads trust anchors as PEM, as escaped PEM or as bare base64', () => {
    expect(appStoreTrustAnchors({ APP_STORE_ROOT_CERTS: ROOT_CERT_PEM })).toHaveLength(1);
    expect(appStoreTrustAnchors({ APP_STORE_ROOT_CERTS: ROOT_CERT_PEM.replace(/\n/g, '\\n') })[0]).toContain('BEGIN CERTIFICATE');
    const bare = ROOT_CERT_PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(appStoreTrustAnchors({ APP_STORE_ROOT_CERTS: bare })[0]).toContain('BEGIN CERTIFICATE');
  });
});
