/**
 * Server push, over Firebase Cloud Messaging (Android directly, iOS through FCM to APNs).
 *
 * Two rules shape everything here.
 *
 * First, privacy. A push leaves our hands and is read by Google, by Apple, and by anyone standing behind
 * her looking at a lock screen. So a payload carries a type and a plain title and nothing else: never a
 * meal, never a cycle date, never a word anyone typed. The app fetches what to show once it is open, the
 * same way `lockScreenShowContent` keeps a local reminder's words off the lock screen by default.
 *
 * Second, it is optional. With no Firebase credentials configured the service logs once and no-ops, just
 * as the AI plan reader does without a key, so a deployment with no Firebase project still runs and every
 * route that fires a push still answers normally.
 */
import { DeviceToken, PUSH_PLATFORMS, type PushPlatform } from '../models/DeviceToken';
import { getEnv } from '../config/env';
import { log } from '../utils/logger';

export { PUSH_PLATFORMS };
export type { PushPlatform };

export const SUBSCRIPTION_EVENTS = ['renewed', 'payment_problem', 'trial_ending', 'refunded'] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];

/** Everything a push is allowed to be about. Ids and enums only: no free text can reach a payload. */
export type PushNotice =
  /** `threadKind` and `orderId` are what the phone needs to open that exact thread from a tap. */
  | { type: 'chat_message'; threadId: string; threadKind: 'order' | 'representative'; orderId?: string | null }
  | { type: 'partner_cheer' }
  | { type: 'subscription'; event: SubscriptionEvent };

export type PushType = PushNotice['type'];

/**
 * Channel ids, matching `mobile/src/reminders/channels.ts`. FCM needs the channel on the message for
 * Android to show it while the app is closed, so the two lists must stay identical.
 */
export const PushChannels = { ACCOUNT: 'account', TOGETHER: 'together' } as const;

/** One title per thing that can happen. Warm, plain, and true on a lock screen with nobody's words in it. */
const SUBSCRIPTION_TITLES: Record<SubscriptionEvent, string> = {
  renewed: 'Your package has renewed',
  payment_problem: 'There is a problem with your payment',
  trial_ending: 'Your free trial ends soon',
  refunded: 'Your refund is on its way',
};

export interface PushMessage {
  title: string;
  channelId: string;
  /** FCM data values must be strings. Ids and enums only. */
  data: Record<string, string>;
  /** Ten messages while her phone is off should arrive as one. */
  collapseKey: string;
}

/**
 * The payload, from the notice alone. Pure, and the one place that decides what leaves the server, so the
 * privacy rule is tested here rather than trusted across three routes.
 */
export function buildPushMessage(notice: PushNotice): PushMessage {
  switch (notice.type) {
    case 'chat_message':
      return {
        title: 'You have a new message',
        channelId: PushChannels.ACCOUNT,
        data: {
          type: notice.type,
          threadId: notice.threadId,
          threadKind: notice.threadKind,
          ...(notice.orderId ? { orderId: notice.orderId } : {}),
        },
        collapseKey: `chat:${notice.threadId}`,
      };
    case 'partner_cheer':
      return {
        title: 'Someone cheered you on',
        channelId: PushChannels.TOGETHER,
        data: { type: notice.type },
        collapseKey: 'cheer',
      };
    case 'subscription':
      return {
        title: SUBSCRIPTION_TITLES[notice.event],
        channelId: PushChannels.ACCOUNT,
        data: { type: notice.type, event: notice.event },
        collapseKey: `subscription:${notice.event}`,
      };
  }
}

/** How long before the end of a free trial she is told. */
export const TRIAL_NOTICE_HOURS = 48;

/** Her trial ends soon and has not ended yet. Pure, so the route is one line. */
export function trialEndingDue(
  sub: { status?: string | null | undefined; trialEndsAt?: Date | null | undefined } | null | undefined,
  now: Date,
): boolean {
  if (sub?.status !== 'trialing' || !sub.trialEndsAt) return false;
  const hoursLeft = (sub.trialEndsAt.getTime() - now.getTime()) / 3_600_000;
  return hoursLeft > 0 && hoursLeft <= TRIAL_NOTICE_HOURS;
}

/**
 * Whether a verified purchase is worth telling her about. A first purchase is not: she is looking at the
 * screen that made it. A period that moved forward on a subscription she already had is a renewal, which
 * she may not have noticed at all.
 */
export function subscriptionNoticeFor(
  before: { expiresAt?: Date | null | undefined } | null | undefined,
  after: { expiresAt?: Date | null | undefined } | null | undefined,
): SubscriptionEvent | null {
  const had = before?.expiresAt?.getTime();
  const has = after?.expiresAt?.getTime();
  return had && has && has > had ? 'renewed' : null;
}

export interface PushTarget { token: string; platform: PushPlatform }

export interface PushTransport {
  /** Sends to every target and reports the tokens the service says are gone, so they can be dropped. */
  send(targets: PushTarget[], message: PushMessage): Promise<{ unregistered: string[] }>;
}

export interface DeviceTokenStore {
  tokensFor(userId: string): Promise<PushTarget[]>;
  save(t: { userId: string; token: string; platform: PushPlatform; appVersion: string; now: Date }): Promise<void>;
  /** Signing out: only her own row goes, never another account's row for the same phone. */
  forget(userId: string, token: string): Promise<void>;
  drop(tokens: string[]): Promise<void>;
}

export const mongoDeviceTokens: DeviceTokenStore = {
  async tokensFor(userId) {
    const rows = await DeviceToken.find({ userId }).select('token platform').lean();
    return rows.map((r) => ({ token: String(r.token), platform: r.platform as PushPlatform }));
  },
  async save({ userId, token, platform, appVersion, now }) {
    // Keyed on the token: a phone signed in to a new account moves across instead of buzzing for the old one.
    await DeviceToken.updateOne({ token }, { $set: { userId, platform, appVersion, lastSeenAt: now } }, { upsert: true });
  },
  async forget(userId, token) {
    await DeviceToken.deleteOne({ userId, token });
  },
  async drop(tokens) {
    if (tokens.length) await DeviceToken.deleteMany({ token: { $in: tokens } });
  },
};

export interface PushService {
  /** False when no Firebase credentials are configured: everything still answers, nothing is sent. */
  readonly configured: boolean;
  register(args: { userId: string; token: string; platform: PushPlatform; appVersion?: string }): Promise<void>;
  unregister(userId: string, token: string): Promise<void>;
  /**
   * Fire and forget. A route calls this and carries on: a push that cannot be sent must never fail the
   * message, the cheer or the purchase it rides on.
   */
  notify(userId: string, notice: PushNotice): void;
  /**
   * Like `notify`, but not again for the same woman and the same notice inside `everyMs`. For a notice
   * fired from a route she hits often — her trial ending, noticed when the app asks what she is entitled
   * to — so opening the app five times does not buzz her five times.
   *
   * The guard is in this process's memory, so a second dyno could send a second one. FCM collapses both
   * into one notification on her phone, which is why that is a dull failure rather than a loud one.
   */
  notifyOnce(userId: string, notice: PushNotice, everyMs?: number): void;
  /** The same work, awaited. Used by the tests and by anything that genuinely wants the result. */
  deliver(userId: string, notice: PushNotice): Promise<{ sent: number; dropped: string[] }>;
}

/** Default window for `notifyOnce`: under a day, so a daily notice still gets through. */
export const NOTICE_REPEAT_MS = 20 * 3_600_000;

export function createPushService(deps: { transport: PushTransport | null; tokens?: DeviceTokenStore }): PushService {
  const tokens = deps.tokens ?? mongoDeviceTokens;
  const { transport } = deps;

  const lastSent = new Map<string, number>();

  function notify(userId: string, notice: PushNotice): void {
    void deliver(userId, notice).catch((e) =>
      log.error('push failed', { type: notice.type, message: e instanceof Error ? e.message : String(e) }),
    );
  }

  async function deliver(userId: string, notice: PushNotice): Promise<{ sent: number; dropped: string[] }> {
    if (!transport) return { sent: 0, dropped: [] };
    const targets = await tokens.tokensFor(userId);
    if (!targets.length) return { sent: 0, dropped: [] };
    const { unregistered } = await transport.send(targets, buildPushMessage(notice));
    // FCM says the phone is gone (app deleted, token rotated): stop writing to it.
    await tokens.drop(unregistered);
    return { sent: targets.length - unregistered.length, dropped: unregistered };
  }

  return {
    configured: transport !== null,

    async register({ userId, token, platform, appVersion }) {
      await tokens.save({ userId, token, platform, appVersion: appVersion ?? '', now: new Date() });
    },

    async unregister(userId, token) {
      await tokens.forget(userId, token);
    },

    notify,

    notifyOnce(userId, notice, everyMs = NOTICE_REPEAT_MS) {
      const key = `${userId}:${buildPushMessage(notice).collapseKey}`;
      const last = lastSent.get(key) ?? 0;
      const now = Date.now();
      if (now - last < everyMs) return;
      lastSent.set(key, now);
      notify(userId, notice);
    },

    deliver,
  };
}

type FirebaseApp = typeof import('firebase-admin/app');
type FirebaseMessaging = typeof import('firebase-admin/messaging');

interface FirebaseCredentials { projectId: string; clientEmail: string; privateKey: string }

/**
 * Credentials from the environment, as either the whole service-account JSON in one variable (easiest on
 * Heroku) or the three fields separately. Null when none is configured.
 */
export function firebaseCredentials(env: {
  FIREBASE_SERVICE_ACCOUNT_JSON?: string | undefined;
  FIREBASE_PROJECT_ID?: string | undefined;
  FIREBASE_CLIENT_EMAIL?: string | undefined;
  FIREBASE_PRIVATE_KEY?: string | undefined;
}): FirebaseCredentials | null {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const j = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Record<string, string>;
      const c = { projectId: j['project_id'] ?? '', clientEmail: j['client_email'] ?? '', privateKey: j['private_key'] ?? '' };
      if (c.projectId && c.clientEmail && c.privateKey) return { ...c, privateKey: unescapeKey(c.privateKey) };
      log.warn('FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email or private_key: push is off');
      return null;
    } catch {
      log.warn('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: push is off');
      return null;
    }
  }
  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: unescapeKey(env.FIREBASE_PRIVATE_KEY),
    };
  }
  return null;
}

/** A PEM in an env var usually arrives with its newlines escaped; firebase-admin needs them real. */
const unescapeKey = (k: string) => k.replace(/\\n/g, '\n');

const PUSH_APP_NAME = 'saathi-push';

/** FCM's way of saying "that phone is gone". Anything else is a failure to retry, not a token to delete. */
const GONE_CODES = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'];

/** Sends through firebase-admin. Null when no credentials are configured, which turns push into a no-op. */
export function firebaseTransport(env: Parameters<typeof firebaseCredentials>[0]): PushTransport | null {
  const creds = firebaseCredentials(env);
  if (!creds) return null;
  let appMod: FirebaseApp;
  let messagingMod: FirebaseMessaging;
  try {
    // Required here, not at the top: the server must still start where firebase-admin cannot load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    appMod = require('firebase-admin/app') as FirebaseApp;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    messagingMod = require('firebase-admin/messaging') as FirebaseMessaging;
  } catch {
    log.warn('firebase-admin could not be loaded: push is off');
    return null;
  }
  // Its own named app, so nothing here disturbs a default app another part of the server may want.
  const existing = appMod.getApps().find((a) => a.name === PUSH_APP_NAME);
  const app = existing ?? appMod.initializeApp({ credential: appMod.cert(creds) }, PUSH_APP_NAME);
  const messaging = messagingMod.getMessaging(app);

  return {
    async send(targets, m) {
      const res = await messaging.sendEachForMulticast({
        tokens: targets.map((t) => t.token),
        // Title only, no body: the words live in the app, never in the payload.
        notification: { title: m.title },
        data: m.data,
        android: {
          priority: 'high',
          collapseKey: m.collapseKey,
          notification: { channelId: m.channelId, visibility: 'private', tag: m.collapseKey },
        },
        apns: {
          headers: { 'apns-priority': '10', 'apns-collapse-id': m.collapseKey.slice(0, 64) },
          payload: { aps: { alert: { title: m.title }, sound: 'default', 'mutable-content': 1 } },
        },
      });
      const unregistered = res.responses
        .map((r, i) => (!r.success && GONE_CODES.includes(r.error?.code ?? '') ? targets[i]?.token : undefined))
        .filter((t): t is string => !!t);
      log.info('push sent', { type: m.data['type'], ok: res.successCount, failed: res.failureCount, dropped: unregistered.length });
      return { unregistered };
    },
  };
}

let cached: PushService | undefined;
/**
 * The live service, built once from the environment. Routes take it as a default dependency they can
 * override, so a test never reaches Mongo or Firebase.
 */
export function livePush(): PushService {
  if (!cached) {
    const transport = firebaseTransport(getEnv());
    if (!transport) log.warn('Firebase credentials are not set: push notifications are off. Chat, cheers and subscription notices still work, she just is not told until she opens the app.');
    cached = createPushService({ transport });
  }
  return cached;
}
