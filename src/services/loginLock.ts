/** Wrong-password lockout. Pure so it is testable: 5 wrong passwords lock the account for 10 minutes. */
export const LOGIN_LOCK = { maxFailures: 5, lockMs: 10 * 60_000 };

export interface LoginState { failedLogins: number; loginLockedUntil: Date | null }

/** Seconds left on a lock, or 0. */
export function lockSecondsLeft(s: LoginState, now: Date): number {
  return s.loginLockedUntil && s.loginLockedUntil > now ? Math.ceil((s.loginLockedUntil.getTime() - now.getTime()) / 1000) : 0;
}

/** State after a wrong password. */
export function afterFailure(s: LoginState, now: Date): LoginState {
  const failedLogins = s.failedLogins + 1;
  return failedLogins >= LOGIN_LOCK.maxFailures
    ? { failedLogins: 0, loginLockedUntil: new Date(now.getTime() + LOGIN_LOCK.lockMs) }
    : { failedLogins, loginLockedUntil: null };
}

export const afterSuccess = (): LoginState => ({ failedLogins: 0, loginLockedUntil: null });
