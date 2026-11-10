import type { Mailer } from '../interfaces';
import { log } from '../utils/logger';

/** Sends mail through Resend's HTTPS API (https://resend.com). The sending domain must be verified there. */
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(msg: { to: string; subject: string; text: string }): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      // Never log the body: it contains the one-time code.
      log.error('mail send failed', { status: res.status, to: msg.to });
      throw new Error(`Mail provider error ${res.status}`);
    }
  }
}
