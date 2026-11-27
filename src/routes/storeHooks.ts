/**
 * Where Google and Apple tell us a purchase changed.
 *
 * These are the only routes in the app that are called by somebody other than her phone, and they are not
 * behind `requireAuth` — there is no woman signed in when Google says a card failed at four in the morning.
 * So the only thing standing between these paths and the internet is proof of who is calling: a Google
 * OIDC token on the Pub/Sub push, and Apple's signature over the notification. Neither is optional and
 * neither has a fallback. A request that cannot prove itself is refused, and nothing is read out of it.
 *
 * Both stores retry anything that is not answered 2xx, which is why the answers here are deliberate:
 * 200 when it has been dealt with (including a replay, which is dealt with by doing nothing), 401 when it
 * cannot be verified, and 5xx only when a retry would genuinely help.
 */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { log } from '../utils/logger';
import { appStoreCredentials, appStoreTrustAnchors, rtdnCredentials, type EnvSource } from '../services/storeCredentials';
import { verifyAppleJws } from '../services/storeJws';
import type { AppleRenewalInfo, AppleTransaction } from '../services/appStore';
import { normaliseEnvironment } from '../services/appStore';
import { createStoreNotificationService } from '../services/storeNotifications';
import { livePlayBilling } from '../services/playBilling';
import { liveAppStoreBilling } from '../services/appStore';
import { livePush } from '../services/push';
import {
  mapAppleNotification,
  mapPlayNotification,
  type AppleNotificationPayload,
  type PlayRtdnBody,
  type StoreNotificationService,
} from '../services/storeNotifications';
import { asyncHandler, parse } from '../utils/http';
import type { StoreEnvironment } from '../services/storeTypes';

/** Proof that a Pub/Sub push really is Google's. */
export interface PubSubVerifier {
  /** The token's claims, or null when it does not verify. */
  verify(bearerToken: string): Promise<{ email?: string | undefined; emailVerified?: boolean | undefined } | null>;
}

/** Verifies the OIDC token Pub/Sub signs each push with, against Google's own keys. */
export function googleOidcVerifier(audience: string): PubSubVerifier | null {
  let lib: typeof import('google-auth-library');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lib = require('google-auth-library') as typeof import('google-auth-library');
  } catch {
    log.warn('google-auth-library could not be loaded: Play notifications cannot be verified');
    return null;
  }
  const client = new lib.OAuth2Client();
  return {
    async verify(bearerToken) {
      try {
        const ticket = await client.verifyIdToken({ idToken: bearerToken, audience });
        const p = ticket.getPayload();
        if (!p) return null;
        return { email: p.email, emailVerified: p.email_verified };
      } catch (e) {
        log.warn('a Play notification token did not verify', { message: e instanceof Error ? e.message : 'unknown' });
        return null;
      }
    },
  };
}

const pubSubBody = z.object({
  message: z.object({
    data: z.string().max(100_000).optional(),
    messageId: z.string().max(200).optional(),
    message_id: z.string().max(200).optional(),
    publishTime: z.string().max(60).optional(),
  }),
  subscription: z.string().max(500).optional(),
});

const appleBody = z.object({ signedPayload: z.string().min(20).max(200_000) });

export interface StoreHookDeps {
  notifications: StoreNotificationService;
  /** Null when no Pub/Sub audience and service account are configured: then Play hooks are refused. */
  pubSub?: PubSubVerifier | null;
  pubSubServiceAccount?: string | undefined;
  /** The Play package name this server serves. A notification for another app is not ours. */
  packageName?: string | undefined;
  /** Apple roots. Empty means an Apple notification cannot be verified, so it is refused. */
  appleAnchors?: string[];
  appleBundleId?: string | undefined;
  appleEnvironment?: StoreEnvironment | undefined;
}

/** Deterministic, so a retry with no messageId is still recognised as the same notification. */
const fingerprint = (data: string): string => `sha256:${createHash('sha256').update(data).digest('hex').slice(0, 40)}`;

export function storeHookRoutes(deps: StoreHookDeps): Router {
  const r = Router();

  /**
   * Google Play Real-time Developer Notifications, delivered by Pub/Sub as a push subscription. Configure
   * the subscription with an OIDC service account and the audience in PLAY_RTDN_AUDIENCE; without those
   * two this route cannot tell Google from anyone else and says so rather than guessing.
   */
  r.post('/google/rtdn', asyncHandler(async (req, res) => {
    if (!deps.pubSub || !deps.pubSubServiceAccount) {
      log.warn('a Play notification arrived but PLAY_RTDN_AUDIENCE / PLAY_RTDN_SERVICE_ACCOUNT_EMAIL are not set: refused');
      res.status(503).json({ error: { code: 'not_configured', message: 'Play notifications are not configured' } });
      return;
    }
    const bearer = /^Bearer (.+)$/i.exec(req.header('authorization') ?? '')?.[1];
    if (!bearer) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'A signed Pub/Sub token is required' } });
      return;
    }
    const claims = await deps.pubSub.verify(bearer);
    // The token must be Google's AND be the service account we told Pub/Sub to sign as. Either alone is not enough.
    if (!claims || claims.emailVerified === false || (claims.email ?? '').toLowerCase() !== deps.pubSubServiceAccount.toLowerCase()) {
      log.warn('a Play notification was refused: the token is not our Pub/Sub service account');
      res.status(401).json({ error: { code: 'unauthorized', message: 'Could not verify this notification' } });
      return;
    }
    const b = parse(pubSubBody, req.body);
    const data = b.message.data;
    if (!data) {
      // An empty push is Pub/Sub checking the endpoint. Accept it so it is not retried for ever.
      res.json({ ok: true });
      return;
    }
    let body: PlayRtdnBody;
    try {
      body = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as PlayRtdnBody;
    } catch {
      log.warn('a verified Play notification did not hold JSON');
      res.status(400).json({ error: { code: 'bad_request', message: 'Unreadable notification' } });
      return;
    }
    if (deps.packageName && body.packageName && body.packageName !== deps.packageName) {
      log.warn('a Play notification was for another app, ignored', { saw: body.packageName });
      res.json({ ok: true, ignored: 'package' });
      return;
    }
    const change = mapPlayNotification(body, b.message.messageId ?? b.message.message_id ?? fingerprint(data));
    if (!change) {
      log.warn('a Play notification held nothing we act on');
      res.json({ ok: true, ignored: 'shape' });
      return;
    }
    const out = await deps.notifications.handle(change);
    if (!out.ok) {
      log.error('a Play notification could not be applied', { type: change.notificationType, note: out.note ?? '' });
      res.status(503).json({ error: { code: 'retry', message: 'Could not apply this notification' } });
      return;
    }
    res.json({ ok: true, outcome: out.outcome });
  }));

  /**
   * App Store Server Notifications v2. Apple posts a single signed payload; the signature, the chain, the
   * bundle id and the environment are all checked before anything is read from it.
   */
  r.post('/apple/notifications', asyncHandler(async (req, res) => {
    const anchors = deps.appleAnchors ?? [];
    if (!anchors.length || !deps.appleBundleId) {
      log.warn('an App Store notification arrived but APP_STORE_ROOT_CERTS / APP_STORE_BUNDLE_ID are not set: refused');
      res.status(503).json({ error: { code: 'not_configured', message: 'App Store notifications are not configured' } });
      return;
    }
    const b = parse(appleBody, req.body);
    const outer = await verifyAppleJws<AppleNotificationPayload>(b.signedPayload, anchors);
    if (!outer.ok || !outer.payload) {
      log.warn('an App Store notification was refused', { error: outer.error ?? 'unverified' });
      res.status(401).json({ error: { code: 'unauthorized', message: 'Could not verify this notification' } });
      return;
    }
    const payload = outer.payload;
    const bundleId = payload.data?.bundleId;
    if (bundleId && bundleId !== deps.appleBundleId) {
      log.warn('an App Store notification was for another app, ignored');
      res.json({ ok: true, ignored: 'bundle' });
      return;
    }
    const environment = normaliseEnvironment(payload.data?.environment);
    const expected = deps.appleEnvironment ?? 'production';
    // A sandbox notification reaching a production server changes nothing. This is the same rule the
    // verification path applies to a receipt, in the one other place it could have been got wrong.
    if (environment && environment !== expected) {
      log.warn('an App Store notification came from the other environment, ignored', { saw: environment, expected });
      res.json({ ok: true, ignored: 'environment' });
      return;
    }
    // The inner payloads are separately signed. On a webhook they are verified too, never just decoded.
    let transaction: AppleTransaction | null = null;
    let renewal: AppleRenewalInfo | null = null;
    if (payload.data?.signedTransactionInfo) {
      const t = await verifyAppleJws<AppleTransaction>(payload.data.signedTransactionInfo, anchors);
      if (!t.ok) {
        log.warn('an App Store notification carried an unverifiable transaction', { error: t.error ?? '' });
        res.status(401).json({ error: { code: 'unauthorized', message: 'Could not verify this notification' } });
        return;
      }
      transaction = t.payload ?? null;
    }
    if (payload.data?.signedRenewalInfo) {
      const rn = await verifyAppleJws<AppleRenewalInfo>(payload.data.signedRenewalInfo, anchors);
      if (!rn.ok) {
        log.warn('an App Store notification carried unverifiable renewal info', { error: rn.error ?? '' });
        res.status(401).json({ error: { code: 'unauthorized', message: 'Could not verify this notification' } });
        return;
      }
      renewal = rn.payload ?? null;
    }
    const change = mapAppleNotification(payload, { transaction, renewal });
    if (!change) {
      log.warn('an App Store notification held nothing we act on', { type: payload.notificationType ?? 'none' });
      res.json({ ok: true, ignored: 'shape' });
      return;
    }
    const out = await deps.notifications.handle(change, {
      transaction,
      renewal,
      status: payload.data?.status,
      bundleId: deps.appleBundleId,
      environment: expected,
    });
    if (!out.ok) {
      log.error('an App Store notification could not be applied', { type: change.notificationType, note: out.note ?? '' });
      res.status(503).json({ error: { code: 'retry', message: 'Could not apply this notification' } });
      return;
    }
    res.json({ ok: true, outcome: out.outcome });
  }));

  return r;
}

/**
 * The two hooks as they are mounted, built from the environment: the real store clients when their
 * credentials are configured, and null when they are not, which makes the matching hook refuse.
 */
export function liveStoreHooks(src: EnvSource = process.env): Router {
  const notifications = createStoreNotificationService({
    push: livePush(),
    play: livePlayBilling(src),
    appStore: liveAppStoreBilling(src),
  });
  return storeHookRoutes(storeHookDepsFromEnv(notifications, src));
}

/** Everything the two hooks need, read from the environment. Missing pieces mean those hooks refuse. */
export function storeHookDepsFromEnv(notifications: StoreNotificationService, src: EnvSource = process.env): StoreHookDeps {
  const rtdn = rtdnCredentials(src);
  const apple = appStoreCredentials(src);
  return {
    notifications,
    pubSub: rtdn ? googleOidcVerifier(rtdn.audience) : null,
    pubSubServiceAccount: rtdn?.serviceAccountEmail,
    packageName: src['PLAY_PACKAGE_NAME']?.trim(),
    appleAnchors: appStoreTrustAnchors(src),
    appleBundleId: apple?.bundleId ?? src['APP_STORE_BUNDLE_ID']?.trim(),
    appleEnvironment: apple?.environment,
  };
}
