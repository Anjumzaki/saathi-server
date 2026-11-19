import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from '../interfaces';
import { ApiError } from '../utils/errors';
import { log } from '../utils/logger';

export interface SmtpConfig { host: string; port: number; user: string; pass: string; from: string }

/** Sends mail over SMTP (e.g. Gmail with an app password, or any provider's SMTP relay). */
export class SmtpMailer implements Mailer {
  private readonly tx: Transporter;
  constructor(private readonly cfg: SmtpConfig, transport?: Transporter) {
    this.tx = transport ?? nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.port === 465,
      // On 465 TLS is implicit. On any other port demand a STARTTLS upgrade, so credentials
      // are never sent over a cleartext connection when a server fails to offer it.
      requireTLS: cfg.port !== 465,
      auth: { user: cfg.user, pass: cfg.pass },
      pool: true, maxConnections: 2, maxMessages: 100, // reuse one login: providers throttle repeated logins
      connectionTimeout: 10_000, socketTimeout: 15_000,
    });
  }

  async send(msg: MailMessage): Promise<void> {
    try {
      await this.tx.sendMail({ from: this.cfg.from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) });
    } catch (e) {
      // Never log the body: it contains the one-time code.
      log.error('smtp send failed', { to: msg.to, message: e instanceof Error ? e.message : String(e) });
      throw new ApiError(503, 'mail_unavailable', "We couldn't send the email just now. Please try again in a few minutes.");
    }
  }
}
