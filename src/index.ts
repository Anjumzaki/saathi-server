import mongoose from 'mongoose';
import { createApp } from './app';
import { getEnv } from './config/env';
import { ResendMailer } from './services/resendMailer';
import { SmtpMailer } from './services/smtpMailer';
import { createStubServices } from './stubs';
import { log } from './utils/logger';

async function main(): Promise<void> {
  const env = getEnv(); // throws on invalid production config
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  log.info('mongo connected');

  // TODO(prod): replace stubs with real providers here (SES/SendGrid mailer, SMS, Google/Apple verifiers, Play billing, Anthropic reader).
  const services = createStubServices({ production: env.NODE_ENV === 'production', allowStubInProduction: env.ALLOW_STUB_PROVIDERS });
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
    services.mailer = new SmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM });
  } else if (env.RESEND_API_KEY) services.mailer = new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  if (env.NODE_ENV === 'production' && env.LOG_OTP && !env.RESEND_API_KEY && !env.SMTP_HOST) log.warn('LOG_OTP is on: one-time codes are printed to the logs. Staging only.');
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
