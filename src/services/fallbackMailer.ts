import type { Mailer } from '../interfaces';
import { log } from '../utils/logger';

/**
 * Staging helper (LOG_OTP=true): try the real mailer; if it fails, print the message to the logs and carry on, so
 * the app still moves to the code screen and the code can be read from `heroku logs`. After a failure the real mailer
 * is skipped for `cooldownMs`, so a provider that is throttling logins (Gmail) is not hammered into a longer block.
 */
export class FallbackMailer implements Mailer {
  private skipUntil = 0;
  constructor(private readonly primary: Mailer | null, private readonly cooldownMs = 15 * 60_000, private readonly now: () => number = Date.now) {}

  async send(msg: { to: string; subject: string; text: string }): Promise<void> {
    if (this.primary && this.now() >= this.skipUntil) {
      try {
        await this.primary.send(msg);
        return;
      } catch {
        this.skipUntil = this.now() + this.cooldownMs;
        log.warn('mail provider failed; falling back to logs (LOG_OTP)', { to: msg.to });
      }
    }
    log.info('MAIL (LOG_OTP)', { to: msg.to, subject: msg.subject, text: msg.text });
  }
}
