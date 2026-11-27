import mongoose from 'mongoose';
import { createApp } from './app';
import { fileStoreWarnings, getEnv } from './config/env';
import { FallbackMailer } from './services/fallbackMailer';
import { ResendMailer } from './services/resendMailer';
import { SmtpMailer } from './services/smtpMailer';
import { createPlanReader } from './services/anthropicPlanReader';
import { aiEnvFrom, pickAiProvider } from './services/planSafety';
import { createStubServices } from './stubs';
import './services/fileStoreS3'; // registers the 's3' driver; without this import FILE_STORE_DRIVER=s3 throws at boot
import { log } from './utils/logger';

async function main(): Promise<void> {
  const env = getEnv(); // throws on invalid production config
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  log.info('mongo connected');
  for (const w of fileStoreWarnings(process.env)) log.warn(w);

  // TODO(prod): replace stubs with real providers here (SES/SendGrid mailer, SMS, Google/Apple verifiers, Play billing, AI reader).
  const services = createStubServices({ production: env.NODE_ENV === 'production', allowStubInProduction: env.ALLOW_STUB_PROVIDERS });
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
    services.mailer = new SmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM });
  } else if (env.RESEND_API_KEY) services.mailer = new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  const ai = pickAiProvider(aiEnvFrom(env)); // OpenAI if its key is set, otherwise Anthropic, otherwise neither
  if (ai) {
    services.aiPlanReader = createPlanReader(ai);
    log.info('AI provider configured', { provider: ai.provider, model: ai.model }); // never the key
  } else {
    log.warn('Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set: "Read with AI" returns a sample draft (dev) or is refused (production), and "Let Saathi write it" returns ai_not_configured.');
  }
  if (env.LOG_OTP) {
    // Staging: never block sign-in on mail. Codes are printed to the logs when the real mailer is missing or failing.
    services.mailer = new FallbackMailer(env.SMTP_HOST || env.RESEND_API_KEY ? services.mailer : null);
    log.warn('LOG_OTP is on: one-time codes can appear in the logs. Staging only.');
  }
  const server = createApp(services).listen(env.PORT, () => log.info('listening', { port: env.PORT, env: env.NODE_ENV }));

  const shutdown = (sig: string) => {
    log.info('shutting down', { sig });
    server.close(() => void mongoose.disconnect().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('fatal', { message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
