import type { Mailer, MailMessage } from '../interfaces';
import { ApiError } from '../utils/errors';
import { log } from '../utils/logger';

/** Sends mail through Resend's HTTPS API (https://resend.com). The sending domain must be verified there. */
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
    });
    if (!res.ok) {
      // Never log the body: it contains the one-time code.
      log.error('mail send failed', { status: res.status, to: msg.to });
      throw new ApiError(503, 'mail_unavailable', "We couldn't send the email just now. Please try again in a few minutes.");
    }
  }
}
