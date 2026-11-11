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
  APP_LINK_BASE: z.string().default('https://saathi.example'),
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
  MAIL_FROM: z.string().default('Saathi <no-reply@saathi.example>'),
  LOG_OTP: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  PLAY_PACKAGE_NAME: z.string().default('com.saathi.app'),
});

export type Env = z.infer<typeof schema>;

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
    if (problems.length) throw new Error(`Invalid production configuration:\n- ${problems.join('\n- ')}`);
  }
  return env;
}

let cached: Env | undefined;
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}
