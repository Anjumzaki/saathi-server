import type {
  AiPlanDraft,
  AiPlanReader,
  IdTokenVerifier,
  Mailer,
  MailMessage,
  AppStoreBilling,
  PlayBilling,
  Services,
  SmsProvider,
  VerifiedIdentity,
} from '../interfaces';
import type { PlayVerification } from '../services/entitlement';
import { getEnv } from '../config/env';
import { AppleIdTokenVerifier, GoogleIdTokenVerifier, UnconfiguredIdTokenVerifier } from '../services/socialAuth';
import { TwilioSms, UnavailableSms, twilioConfigFromEnv } from '../services/sms';
import { livePlayBilling } from '../services/playBilling';
import { liveAppStoreBilling } from '../services/appStore';
import { log } from '../utils/logger';
import { ApiError, unauthorized } from '../utils/errors';

const isProd = () => process.env.NODE_ENV === 'production';

/**
 * Dev mailer: prints the message. In production it never prints the body (it would contain the OTP), unless
 * LOG_OTP=true, which exists ONLY for a private staging server before a real mail provider is set up.
 */
export class ConsoleMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    if (isProd() && process.env.LOG_OTP !== 'true') log.info('mail (console mailer, body suppressed)', { to: msg.to, subject: msg.subject });
    else process.stdout.write(`\n--- MAIL to ${msg.to} ---\n${msg.subject}\n${msg.text}\n---\n`);
  }
}

/** Development only: prints the message instead of sending it, so the flow can be walked without Twilio. */
export class StubSms implements SmsProvider {
  readonly available = true;
  async send(msg: { to: string; text: string }): Promise<void> {
    if (isProd()) log.info('sms (stub, body suppressed)', { to: msg.to });
    else process.stdout.write(`\n--- SMS to ${msg.to} ---\n${msg.text}\n---\n`);
  }
}

/**
 * Development only, for walking the flow with no Google or Apple client id: accepts
 * "stub:<subject>:<email>" and trusts it. The real verifiers are in `services/socialAuth.ts` and are
 * used the moment a client id is configured. NEVER enabled in production.
 */
export class StubIdTokenVerifier implements IdTokenVerifier {
  constructor(private readonly provider: 'google' | 'apple') {}
  readonly configured = true;
  async verify(idToken: string): Promise<VerifiedIdentity> {
    const m = /^stub:([^:]+):(.+)$/.exec(idToken);
    if (!m) throw unauthorized('Invalid id token (stub accepts "stub:<subject>:<email>")');
    return { provider: this.provider, subject: m[1]!, email: m[2]!.toLowerCase(), emailVerified: true };
  }
}

/**
 * Development only. The real client is `services/playBilling.ts` (purchases.subscriptionsv2.get,
 * purchases.products.get, :acknowledge and orders:refund over a service account), wired in index.ts
 * whenever a service account is configured.
 *
 * STUB: tokens starting "stub_valid" are valid (30 days); "stub_trial" yields a 30-day trial; others
 * invalid. In a production process it grants nothing at all, whatever ALLOW_STUB_PROVIDERS says: this is
 * the money path, and a flag set by mistake must not be able to hand out Premium for the word "stub".
 */
export class StubPlayBilling implements PlayBilling {
  async verify(args: Parameters<PlayBilling['verify']>[0]): Promise<PlayVerification> {
    if (isProd()) return refuseStubPurchase('Play');
    const t = args.purchaseToken;
    const in30 = new Date(Date.now() + 30 * 86_400_000);
    if (t.startsWith('stub_trial')) return { valid: true, productId: args.productId, orderId: `GPA.stub.${t}`, expiresAt: in30, isTrial: true, autoRenewing: true };
    if (t.startsWith('stub_valid')) return { valid: true, productId: args.productId, orderId: `GPA.stub.${t}`, expiresAt: in30, autoRenewing: true };
    return { valid: false };
  }
  async refund(): Promise<void> {
    log.warn('StubPlayBilling.refund called: no money moved (configure a Play service account for a real refund)');
  }
}

/**
 * Development only. The real client is `services/appStore.ts` (the App Store Server API, signed with an
 * App Store Connect key, checking the bundle id and the environment). Same production rule as above.
 *
 * STUB: ids starting "stub_valid" are valid 30 days, "stub_trial" a 30-day trial; others invalid.
 */
export class StubAppStoreBilling implements AppStoreBilling {
  async verify(args: Parameters<AppStoreBilling['verify']>[0]): Promise<PlayVerification> {
    if (isProd()) return refuseStubPurchase('App Store');
    const t = args.transactionId;
    const in30 = new Date(Date.now() + 30 * 86_400_000);
    if (t.startsWith('stub_trial')) return { valid: true, productId: args.productId, orderId: t, expiresAt: in30, isTrial: true, autoRenewing: true };
    if (t.startsWith('stub_valid')) return { valid: true, productId: args.productId, orderId: t, expiresAt: in30, autoRenewing: true };
    return { valid: false };
  }
}

/**
 * STUB. TODO real implementation: call the Anthropic Messages API with the plan text (or the file fetched from
 * `fileRef` in object storage), ask for JSON matching `planContentSchema`, validate it with zod, and return it as a
 * draft. Keep ANTHROPIC_API_KEY in env. The route NEVER saves the result; the app shows a review screen.
 */
export class StubAiPlanReader implements AiPlanReader {
  async read(): Promise<AiPlanDraft> {
    return {
      title: '[SAMPLE] Imported plan (stub, not read from your document)',
      isSample: true,
      source: 'stub',
      warnings: ['SAMPLE DATA: the AI reader is not configured. This draft was NOT extracted from your document.'],
      items: [
        { key: 'sample-breakfast', category: 'meal', title: 'Breakfast [SAMPLE]', time: '08:00', mealKind: 'breakfast', daysOfWeek: [], tier: 'notification', options: [{ label: 'A', text: 'Two eggs with toast' }, { label: 'B', text: 'Oats with milk and nuts' }], details: 'Sample only' },
        { key: 'sample-lunch', category: 'meal', title: 'Lunch [SAMPLE]', time: '13:00', mealKind: 'lunch', daysOfWeek: [], tier: 'notification', options: [], details: 'Dal, roti and salad (sample)' },
        { key: 'sample-dinner', category: 'meal', title: 'Dinner [SAMPLE]', time: '19:30', mealKind: 'dinner', daysOfWeek: [], tier: 'notification', options: [], details: 'Grilled chicken and vegetables (sample)' },
        { key: 'sample-sleep', category: 'sleep', title: 'Bedtime [SAMPLE]', time: '23:00', daysOfWeek: [], tier: 'notification', options: [] },
      ],
      rules: [{ id: 'sample-rule-1', text: 'Sample rule: no tea within 30 minutes of iron.', source: 'SAATHI' }],
      recipes: [],
    };
  }
}

/**
 * A stub purchase in a production process. Refused rather than returned invalid, so it shows up as a
 * misconfiguration in the logs instead of looking like a woman's card being declined.
 */
function refuseStubPurchase(store: string): never {
  log.error(`${store} billing is still the development stub in production: no purchase can be verified. Configure the store credentials.`);
  throw new ApiError(501, 'not_implemented', `${store} billing is not configured`);
}

/** Stubs are for dev/test. In production they are refused unless ALLOW_STUB_PROVIDERS=true. */
function guarded<T extends object>(name: string, impl: T, allowed: boolean): T {
  if (allowed) return impl;
  return new Proxy(impl, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function') return v;
      return () => {
        throw new ApiError(501, 'not_implemented', `${name} is not configured for production (stub disabled)`);
      };
    },
  });
}

/**
 * Social sign-in and SMS are picked here rather than in `index.ts`: each one is real as soon as its
 * credentials exist, a printing stub in development without them, and an honest refusal otherwise.
 * Nothing in between, and nothing that looks like it worked when it did not.
 */
function socialAndSms(allowed: boolean) {
  const env = getEnv();
  const twilio = twilioConfigFromEnv();
  const appleClientIds = env.APPLE_CLIENT_ID ? [env.APPLE_CLIENT_ID] : [];
  return {
    sms: twilio ? new TwilioSms(twilio) : allowed ? new StubSms() : new UnavailableSms(),
    googleVerifier: env.GOOGLE_CLIENT_IDS.length
      ? new GoogleIdTokenVerifier(env.GOOGLE_CLIENT_IDS)
      : allowed
        ? new StubIdTokenVerifier('google')
        : new UnconfiguredIdTokenVerifier('google'),
    appleVerifier: appleClientIds.length
      ? new AppleIdTokenVerifier(appleClientIds)
      : allowed
        ? new StubIdTokenVerifier('apple')
        : new UnconfiguredIdTokenVerifier('apple'),
  };
}

export function createStubServices(opts: { production: boolean; allowStubInProduction: boolean }): Services {
  const allowed = !opts.production || opts.allowStubInProduction;
  // Billing follows the same rule as social sign-in above: real as soon as the store credentials exist,
  // the dev stub without them, and a refusal in production either way. It is picked here rather than in
  // index.ts so there is one place where a provider becomes real.
  const play = livePlayBilling();
  const appStore = liveAppStoreBilling();
  return {
    mailer: new ConsoleMailer(), // body suppressed in production
    ...socialAndSms(allowed),
    playBilling: play ?? guarded('Play billing', new StubPlayBilling(), allowed),
    appStoreBilling: appStore ?? guarded('App Store billing', new StubAppStoreBilling(), allowed),
    aiPlanReader: guarded('AI plan reader', new StubAiPlanReader(), allowed),
  };
}
