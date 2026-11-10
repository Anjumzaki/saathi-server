import type {
  AiPlanDraft,
  AiPlanReader,
  IdTokenVerifier,
  Mailer,
  AppStoreBilling,
  PlayBilling,
  Services,
  SmsProvider,
  VerifiedIdentity,
} from '../interfaces';
import type { PlayVerification } from '../services/entitlement';
import { log } from '../utils/logger';
import { ApiError, unauthorized } from '../utils/errors';

const isProd = () => process.env.NODE_ENV === 'production';

/**
 * Dev mailer: prints the message. In production it never prints the body (it would contain the OTP), unless
 * LOG_OTP=true, which exists ONLY for a private staging server before a real mail provider is set up.
 */
export class ConsoleMailer implements Mailer {
  async send(msg: { to: string; subject: string; text: string }): Promise<void> {
    if (isProd() && process.env.LOG_OTP !== 'true') log.info('mail (console mailer, body suppressed)', { to: msg.to, subject: msg.subject });
    else process.stdout.write(`\n--- MAIL to ${msg.to} ---\n${msg.subject}\n${msg.text}\n---\n`);
  }
}

/** TODO: real SMS provider (Twilio / Unifonic / AWS SNS). */
export class StubSms implements SmsProvider {
  async send(msg: { to: string; text: string }): Promise<void> {
    if (isProd()) log.info('sms (stub, body suppressed)', { to: msg.to });
    else process.stdout.write(`\n--- SMS to ${msg.to} ---\n${msg.text}\n---\n`);
  }
}

/**
 * TODO: real verifier. Google: verify the JWT signature against https://www.googleapis.com/oauth2/v3/certs,
 * check iss, aud in GOOGLE_CLIENT_IDS and exp (e.g. `google-auth-library` OAuth2Client.verifyIdToken).
 * Apple: verify against https://appleid.apple.com/auth/keys, iss https://appleid.apple.com, aud = APPLE_CLIENT_ID.
 * STUB: accepts "stub:<subject>:<email>" and trusts it. NEVER enable in production.
 */
export class StubIdTokenVerifier implements IdTokenVerifier {
  constructor(private readonly provider: 'google' | 'apple') {}
  async verify(idToken: string): Promise<VerifiedIdentity> {
    const m = /^stub:([^:]+):(.+)$/.exec(idToken);
    if (!m) throw unauthorized('Invalid id token (stub accepts "stub:<subject>:<email>")');
    return { provider: this.provider, subject: m[1]!, email: m[2]!.toLowerCase(), emailVerified: true };
  }
}

/**
 * TODO: real Google Play Developer API (androidpublisher): purchases.subscriptionsv2.get for subscriptions,
 * purchases.products.get for one-off products, then acknowledge the purchase. Use a service account.
 * STUB: tokens starting "stub_valid" are valid (30 days); "stub_trial" yields a 30-day trial; others invalid.
 */
export class StubPlayBilling implements PlayBilling {
  async verify(args: Parameters<PlayBilling['verify']>[0]): Promise<PlayVerification> {
    const t = args.purchaseToken;
    const in30 = new Date(Date.now() + 30 * 86_400_000);
    if (t.startsWith('stub_trial')) return { valid: true, productId: args.productId, orderId: `GPA.stub.${t}`, expiresAt: in30, isTrial: true, autoRenewing: true };
    if (t.startsWith('stub_valid')) return { valid: true, productId: args.productId, orderId: `GPA.stub.${t}`, expiresAt: in30, autoRenewing: true };
    return { valid: false };
  }
  async refund(): Promise<void> {
    log.warn('StubPlayBilling.refund called: no money moved (TODO Play Developer API)');
  }
}

/**
 * TODO: real App Store Server API (GET /inApps/v1/subscriptions/{transactionId}, signed with an App Store Connect key),
 * verify the JWS, read expiresDate / offerType / autoRenewStatus. STUB: ids starting "stub_valid" are valid 30 days,
 * "stub_trial" a 30-day trial; others invalid.
 */
export class StubAppStoreBilling implements AppStoreBilling {
  async verify(args: Parameters<AppStoreBilling['verify']>[0]): Promise<PlayVerification> {
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

export function createStubServices(opts: { production: boolean; allowStubInProduction: boolean }): Services {
  const allowed = !opts.production || opts.allowStubInProduction;
  return {
    mailer: new ConsoleMailer(), // body suppressed in production
    sms: guarded('SMS provider', new StubSms(), allowed),
    googleVerifier: guarded('Google verifier', new StubIdTokenVerifier('google'), allowed),
    appleVerifier: guarded('Apple verifier', new StubIdTokenVerifier('apple'), allowed),
    playBilling: guarded('Play billing', new StubPlayBilling(), allowed),
    appStoreBilling: guarded('App Store billing', new StubAppStoreBilling(), allowed),
    aiPlanReader: guarded('AI plan reader', new StubAiPlanReader(), allowed),
  };
}
