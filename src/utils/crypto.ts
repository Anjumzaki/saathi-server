import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const hmac = (secret: string, s: string): string => createHmac('sha256', secret).update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function generateOtpCode(length = 6): string {
  return String(randomInt(0, 10 ** length)).padStart(length, '0');
}

/** OTPs are stored only as peppered HMACs bound to the OTP key (email / phone). */
export const hashOtp = (pepper: string, key: string, code: string): string => hmac(pepper, `${key}:${code}`);
