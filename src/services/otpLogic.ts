/** Pure OTP state machine: 6 digits, 10 min expiry, 5 wrong tries then 10 min lock, 60 s resend cooldown. */
import { MINUTE } from '../utils/time';

export const OTP_CONFIG = {
  length: 6,
  ttlMs: 10 * MINUTE,
  maxAttempts: 5,
  lockMs: 10 * MINUTE,
  resendCooldownMs: 60_000,
} as const;

export interface OtpState {
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lockedUntil: Date | null;
  lastSentAt: Date;
  consumed: boolean;
}

export type ResendDecision =
  | { allowed: true; attempts: number; lockedUntil: Date | null }
  | { allowed: false; reason: 'cooldown' | 'locked'; retryAfterSeconds: number };

const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * May a new code be sent? Failed-attempt counters CARRY OVER across resends (so resending cannot be used
 * to get unlimited guesses) and reset only once a lock has lapsed, the previous code expired, or it was used.
 */
export function decideResend(prev: OtpState | null, now: Date, cfg = OTP_CONFIG): ResendDecision {
  if (!prev) return { allowed: true, attempts: 0, lockedUntil: null };
  if (prev.lockedUntil && prev.lockedUntil.getTime() > now.getTime()) {
    return { allowed: false, reason: 'locked', retryAfterSeconds: secs(prev.lockedUntil.getTime() - now.getTime()) };
  }
  const since = now.getTime() - prev.lastSentAt.getTime();
  if (since < cfg.resendCooldownMs) {
    return { allowed: false, reason: 'cooldown', retryAfterSeconds: secs(cfg.resendCooldownMs - since) };
  }
  const stale = prev.consumed || prev.expiresAt.getTime() <= now.getTime() || prev.lockedUntil !== null;
  return { allowed: true, attempts: stale ? 0 : prev.attempts, lockedUntil: null };
}

export type OtpFailure = 'no_code' | 'locked' | 'expired' | 'invalid';
export interface OtpEvaluation {
  ok: boolean;
  failure?: OtpFailure;
  attemptsLeft?: number;
  retryAfterSeconds?: number;
  /** Fields to persist on the OTP record (empty when no state change is needed). */
  patch: Partial<Pick<OtpState, 'attempts' | 'lockedUntil' | 'consumed'>>;
}

export function evaluateOtp(
  state: OtpState | null,
  submittedHash: string,
  matches: (a: string, b: string) => boolean,
  now: Date,
  cfg = OTP_CONFIG,
): OtpEvaluation {
  if (!state || state.consumed) return { ok: false, failure: 'no_code', patch: {} };
  let attempts = state.attempts;
  if (state.lockedUntil) {
    if (state.lockedUntil.getTime() > now.getTime()) {
      return {
        ok: false,
        failure: 'locked',
        retryAfterSeconds: secs(state.lockedUntil.getTime() - now.getTime()),
        patch: {},
      };
    }
    attempts = 0; // lock lapsed
  }
  if (state.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, failure: 'expired', patch: state.lockedUntil ? { attempts: 0, lockedUntil: null } : {} };
  }
  if (matches(state.codeHash, submittedHash)) {
    return { ok: true, patch: { consumed: true, attempts: 0, lockedUntil: null } };
  }
  attempts += 1;
  if (attempts >= cfg.maxAttempts) {
    const lockedUntil = new Date(now.getTime() + cfg.lockMs);
    return {
      ok: false,
      failure: 'locked',
      attemptsLeft: 0,
      retryAfterSeconds: secs(cfg.lockMs),
      patch: { attempts, lockedUntil },
    };
  }
  return { ok: false, failure: 'invalid', attemptsLeft: cfg.maxAttempts - attempts, patch: { attempts, lockedUntil: null } };
}

/** Stable error codes the apps switch on. Never reuse a code for a different meaning. */
export const OtpErrorCode = {
  INCORRECT: 'otp_incorrect', EXPIRED: 'otp_expired', NO_CODE: 'otp_no_code', LOCKED: 'otp_locked', COOLDOWN: 'otp_cooldown',
} as const;

export interface OtpErrorShape { status: number; code: string; message: string; details?: { attemptsLeft?: number; retryAfterSeconds?: number } }

/** Maps a failed evaluation to the HTTP error the client sees. */
export function otpFailureError(ev: OtpEvaluation, cfg = OTP_CONFIG): OtpErrorShape {
  switch (ev.failure) {
    case 'locked':
      return { status: 429, code: OtpErrorCode.LOCKED, message: 'Too many wrong attempts. Try again later.', details: { retryAfterSeconds: ev.retryAfterSeconds ?? cfg.lockMs / 1000, attemptsLeft: 0 } };
    case 'expired':
      return { status: 400, code: OtpErrorCode.EXPIRED, message: 'Code expired. Request a new one.' };
    case 'no_code':
      return { status: 400, code: OtpErrorCode.NO_CODE, message: 'No active code. Request a new one.' };
    default:
      return { status: 400, code: OtpErrorCode.INCORRECT, message: 'Incorrect code.', details: { attemptsLeft: ev.attemptsLeft } };
  }
}
