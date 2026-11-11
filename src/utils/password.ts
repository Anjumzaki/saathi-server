import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** "scrypt$<salt>$<hash>" (base64url). Passwords are never stored or logged in clear. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, PARAMS);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [alg, s, h] = (stored ?? '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64url');
  const got = await scrypt(password, Buffer.from(s, 'base64url'), want.length, PARAMS);
  return got.length === want.length && timingSafeEqual(got, want);
}
