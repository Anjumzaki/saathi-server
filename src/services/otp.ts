import { getEnv } from '../config/env';
import { Otp } from '../models/Otp';
import { ApiError, tooMany } from '../utils/errors';
import { generateOtpCode, hashOtp, safeEqual } from '../utils/crypto';
import { OTP_CONFIG, OtpErrorCode, decideResend, evaluateOtp, otpFailureError, type OtpState } from './otpLogic';

const toState = (d: InstanceType<typeof Otp> | null): OtpState | null =>
  d
    ? {
        codeHash: d.codeHash,
        expiresAt: d.expiresAt,
        attempts: d.attempts,
        lockedUntil: d.lockedUntil ?? null,
        lastSentAt: d.lastSentAt,
        consumed: d.consumed,
      }
    : null;

/** Creates and stores a new code (hashed) and returns the plaintext ONLY so the caller can hand it to a Mailer/SMS. */
export async function issueOtp(key: string, now = new Date()): Promise<{ code: string; resendAfterSeconds: number }> {
  const prev = toState(await Otp.findOne({ key }));
  const decision = decideResend(prev, now);
  if (!decision.allowed) {
    throw decision.reason === 'locked'
      ? tooMany('Too many wrong attempts. Try again later.', decision.retryAfterSeconds, OtpErrorCode.LOCKED)
      : tooMany('Please wait before requesting another code.', decision.retryAfterSeconds, OtpErrorCode.COOLDOWN);
  }
  const code = generateOtpCode(OTP_CONFIG.length);
  await Otp.findOneAndUpdate(
    { key },
    {
      key,
      codeHash: hashOtp(getEnv().OTP_PEPPER, key, code),
      expiresAt: new Date(now.getTime() + OTP_CONFIG.ttlMs),
      attempts: decision.attempts,
      lockedUntil: decision.lockedUntil,
      lastSentAt: now,
      consumed: false,
    },
    { upsert: true, new: true },
  );
  return { code, resendAfterSeconds: OTP_CONFIG.resendCooldownMs / 1000 };
}

export async function checkOtp(key: string, code: string, now = new Date()): Promise<void> {
  const doc = await Otp.findOne({ key });
  const ev = evaluateOtp(toState(doc), hashOtp(getEnv().OTP_PEPPER, key, code), safeEqual, now);
  if (doc && Object.keys(ev.patch).length) {
    Object.assign(doc, ev.patch);
    await doc.save();
  }
  if (ev.ok) return;
  const e = otpFailureError(ev);
  throw new ApiError(e.status, e.code, e.message, e.details);
}
