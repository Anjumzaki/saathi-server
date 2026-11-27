import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/saathi'),
  JWT_ACCESS_SECRET: z.string().default('dev-access-secret-not-for-production-use'),
  JWT_REFRESH_SECRET: z.string().default('dev-refresh-secret-not-for-production-use'),
  OTP_PEPPER: z.string().default('dev-otp-pepper-not-for-production-use'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(365),
  ADMIN_EMAILS: csv,
  CORS_ORIGINS: csv,
  APP_LINK_BASE: z.string().default('https://saathi-app.com'),
  /** Main address of the website (e.g. www.saathi-app.com). When set, pages opened on any other host name are sent there. */
  SITE_HOST: z.string().optional(),
  CONFIG_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
  ALLOW_STUB_PROVIDERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GOOGLE_CLIENT_IDS: csv,
  APPLE_CLIENT_ID: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Saathi <support@saathi-app.com>'),
  LOG_OTP: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  PLAY_PACKAGE_NAME: z.string().default('com.multiware.saathi'),
  /**
   * Firebase Cloud Messaging, for push. Either the whole service-account JSON in one variable or the
   * three fields separately. All optional: with none set, push is off and everything else still runs.
   */
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /**
   * Google Play Developer API, for verifying purchases, acknowledging them and issuing refunds. Either the
   * whole service-account JSON in one variable or the two fields separately. All optional on purpose: with
   * none set no Play purchase can be verified, and every purchase is refused rather than waved through.
   */
  /** OpenAI, for reading and writing plans. Either this or ANTHROPIC_API_KEY switches both AI features on. */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  /** Twilio, for the optional SMS number check. `services/sms.ts` reads these itself; here so production validates. */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  PLAY_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  PLAY_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),
  /** Offer tags that mark a free trial in the Play Console, so a trial is read and never guessed. */
  PLAY_TRIAL_OFFER_TAGS: z.string().default('trial'),
  /** Play Real-time Developer Notifications, delivered by Pub/Sub with an OIDC token we verify. */
  PLAY_RTDN_AUDIENCE: z.string().optional(),
  PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  /** App Store Server API: an in-app purchase key from App Store Connect. All four or nothing. */
  APP_STORE_KEY_ID: z.string().optional(),
  APP_STORE_ISSUER_ID: z.string().optional(),
  APP_STORE_PRIVATE_KEY: z.string().optional(),
  APP_STORE_BUNDLE_ID: z.string().optional(),
  /** Unset means production servers are production and everything else is sandbox. */
  APP_STORE_ENVIRONMENT: z.enum(['production', 'sandbox']).optional(),
  /** Apple Root CA G3, as PEM or base64 DER. Without it an App Store notification cannot be verified. */
  APP_STORE_ROOT_CERTS: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  /**
   * Uploaded documents (a licence, a certificate, a government ID). `services/fileStore.ts` reads these
   * from the environment itself; they are here so a production deployment is validated before it boots.
   */
  FILE_STORE_DRIVER: z.string().default('local').transform((v) => v.trim().toLowerCase()),
  /** Local driver only, and it must survive a restart: see fileStoreWarnings below. */
  FILE_STORE_ROOT: z.string().optional(),
  FILE_STORE_MAX_BYTES: z.coerce.number().int().positive().default(600_000),
  FILE_STORE_MIME_TYPES: csv,
  FILE_STORE_S3_BUCKET: z.string().optional(),
  FILE_STORE_S3_REGION: z.string().optional(),
  /** Folder inside the bucket; the stored keys themselves are the same under either driver. */
  FILE_STORE_S3_PREFIX: z.string().optional(),
  /** Set for an S3-compatible service (Spaces, MinIO); left unset for AWS. */
  FILE_STORE_S3_ENDPOINT: z.string().optional(),
  FILE_STORE_S3_SSE: z.string().default('AES256'),
  FILE_STORE_S3_KMS_KEY_ID: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/**
 * Where an applicant's licence would be lost. A warning rather than a refusal to boot: the local
 * driver's default root works right up to the first restart, and a server that will not start helps
 * nobody. Print these at start-up.
 */
export function fileStoreWarnings(source: Record<string, string | undefined>): string[] {
  const driver = (source.FILE_STORE_DRIVER ?? 'local').trim().toLowerCase();
  if (driver !== 'local' || source.FILE_STORE_ROOT?.trim()) return [];
  return ['FILE_STORE_ROOT is not set: an uploaded licence or ID is written to a temporary folder and is lost on the next restart. Point it at a persistent volume, or set FILE_STORE_DRIVER=s3.'];
}

/** Pure: parse and validate an env-like object. Production demands explicit, strong secrets. */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const env = schema.parse(source);
  if (env.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!source.MONGODB_URI) problems.push('MONGODB_URI is required in production');
    for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OTP_PEPPER'] as const) {
      const v = source[k];
      if (!v || v.length < 32) problems.push(`${k} must be set to at least 32 characters in production`);
    }
    const smtp = !!(source.SMTP_HOST && source.SMTP_USER && source.SMTP_PASS);
    if (!source.RESEND_API_KEY && !smtp && source.LOG_OTP !== 'true') problems.push('A mailer is required in production: set SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY (or LOG_OTP=true on a private staging server only): without a mailer nobody can sign in');
    if (source.JWT_ACCESS_SECRET && source.JWT_ACCESS_SECRET === source.JWT_REFRESH_SECRET) {
      problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
    }
    // Asking for S3 without a bucket falls back to local disk, which in production loses documents quietly.
    if (env.FILE_STORE_DRIVER === 's3' && !source.FILE_STORE_S3_BUCKET?.trim()) {
      problems.push('FILE_STORE_S3_BUCKET is required when FILE_STORE_DRIVER=s3');
    }
    if (problems.length) throw new Error(`Invalid production configuration:\n- ${problems.join('\n- ')}`);
  }
  return env;
}

let cached: Env | undefined;
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}
