import { describe, expect, it } from 'vitest';
import { LOGIN_LOCK, afterFailure, afterSuccess, lockSecondsLeft } from '../src/services/loginLock';
import { hashPassword, verifyPassword } from '../src/utils/password';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const h = await hashPassword('correct horse 9');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse 9', h)).toBe(true);
    expect(await verifyPassword('correct horse 8', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });
  it('salts every hash and rejects malformed or missing hashes', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', 'plain')).toBe(false);
  });
});

describe('login lockout', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  it('locks for 10 minutes after 5 wrong passwords, and a success clears it', () => {
    let s = afterSuccess();
    for (let i = 1; i < LOGIN_LOCK.maxFailures; i++) { s = afterFailure(s, now); expect(lockSecondsLeft(s, now)).toBe(0); }
    s = afterFailure(s, now);
    expect(lockSecondsLeft(s, now)).toBe(600);
    expect(lockSecondsLeft(s, new Date(now.getTime() + 601_000))).toBe(0);
    expect(afterSuccess()).toEqual({ failedLogins: 0, loginLockedUntil: null });
  });
});
