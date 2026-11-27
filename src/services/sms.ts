/**
 * Text messages, for confirming a mobile number. Twilio behind the `SmsProvider` seam, plus the
 * counters that keep a text from being a way to spend Anjum's money or to pester a stranger's phone.
 *
 * Phone verification is optional everywhere in Saathi, so this whole file is allowed not to work: with
 * no credentials `available` is false and the route says so plainly.
 */
import twilio from 'twilio';
import type { SmsProvider } from '../interfaces';
import { checkSmsQuota, forgetOldSends, type SmsQuotaDecision } from './otpLogic';
import { ApiError, tooMany } from '../utils/errors';
import { log } from '../utils/logger';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** A Twilio number in E.164, or a Messaging Service SID (`MG…`), which is the better one for several countries. */
  from: string;
}

/**
 * Read straight from the environment, the way `services/fileStore.ts` reads its own, because
 * `config/env.ts` is shared and these four variables belong to nothing else.
 */
export function twilioConfigFromEnv(src: Record<string, string | undefined> = process.env): TwilioConfig | null {
  const accountSid = src.TWILIO_ACCOUNT_SID?.trim();
  const authToken = src.TWILIO_AUTH_TOKEN?.trim();
  const from = src.TWILIO_MESSAGING_SERVICE_SID?.trim() || src.TWILIO_FROM_NUMBER?.trim();
  if (!accountSid || !authToken || !from) return null;
  // A live key in a development database is how a test run ends up costing money.
  if (!accountSid.startsWith('AC')) {
    log.warn('TWILIO_ACCOUNT_SID does not look like an account SID (expected it to start with "AC"): SMS is off.');
    return null;
  }
  return { accountSid, authToken, from };
}

type SendArgs = { to: string; body: string; from?: string; messagingServiceSid?: string };
type MessageSender = (args: SendArgs) => Promise<unknown>;

export class TwilioSms implements SmsProvider {
  readonly available = true;
  private readonly send_: MessageSender;
  private readonly route: Pick<SendArgs, 'from' | 'messagingServiceSid'>;

  constructor(cfg: TwilioConfig, sender?: MessageSender) {
    this.send_ = sender ?? ((args) => twilio(cfg.accountSid, cfg.authToken).messages.create(args as never));
    this.route = cfg.from.startsWith('MG') ? { messagingServiceSid: cfg.from } : { from: cfg.from };
  }

  async send(msg: { to: string; text: string }): Promise<void> {
    try {
      await this.send_({ to: msg.to, body: msg.text, ...this.route });
    } catch (e) {
      // Never log the text: it holds the code. The number is logged as its last two digits only.
      log.error('sms send failed', { to: `…${msg.to.slice(-2)}`, message: e instanceof Error ? e.message : 'unknown' });
      throw new ApiError(503, 'sms_unavailable', "We couldn't text that number just now. Please try again in a few minutes.");
    }
  }
}

/** No credentials: every send is refused, and `available` lets the route refuse before it issues a code. */
export class UnavailableSms implements SmsProvider {
  readonly available = false;
  async send(): Promise<void> {
    throw new ApiError(503, 'sms_unavailable', 'Confirming your number by text is not available yet.');
  }
}

/**
 * The per-number and per-account counters, in this process's memory.
 *
 * Deliberately not in the database: a row per text is a lot of writing for a limit, and the code slot
 * itself is already stored and already stops the fast cases (one a minute, five wrong guesses). What
 * this adds is the money cap, and the honest limit of keeping it in memory is that a second dyno has
 * its own count — so the real ceiling is the cap times the number of dynos, and a restart forgets.
 * Good enough to stop abuse costing a fortune; the database version is a wiring note.
 */
export interface SmsQuota {
  check(number: string, accountId: string, now?: number): SmsQuotaDecision;
  record(number: string, accountId: string, now?: number): void;
}

export function createSmsQuota(): SmsQuota {
  const byNumber = new Map<string, number[]>();
  const byAccount = new Map<string, number[]>();
  const sweep = (m: Map<string, number[]>, key: string, now: number): number[] => {
    const kept = forgetOldSends(m.get(key) ?? [], now);
    if (kept.length) m.set(key, kept); else m.delete(key);
    return kept;
  };
  return {
    check(number, accountId, now = Date.now()) {
      return checkSmsQuota(sweep(byNumber, number, now), sweep(byAccount, accountId, now), now);
    },
    record(number, accountId, now = Date.now()) {
      byNumber.set(number, [...sweep(byNumber, number, now), now]);
      byAccount.set(accountId, [...sweep(byAccount, accountId, now), now]);
    },
  };
}

/** The 429 a blocked send becomes. The wording never says why, and never that the number is known to us. */
export function smsQuotaError(d: Extract<SmsQuotaDecision, { allowed: false }>): ApiError {
  return tooMany('Too many codes have been sent. Please try again later.', d.retryAfterSeconds, 'too_many_requests');
}
