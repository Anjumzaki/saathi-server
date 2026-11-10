/** Pure partner-sharing rules. */
import { HOUR, utcDayKey } from '../utils/time';

export const INVITE_TTL_MS = 48 * HOUR;

export interface PartnerPermissions {
  effortRing: boolean;
  mealsLogged: boolean;
  waterWalk: boolean;
  weight: boolean;
  /** When true the partner receives ONLY shared "together" nudges, never any stats. */
  togetherNudgesOnly: boolean;
}

export const inviteExpiry = (now: Date): Date => new Date(now.getTime() + INVITE_TTL_MS);
export const isInviteValid = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() > now.getTime();

/** One cheer per UTC day per share. */
export function canCheer(lastCheerAt: Date | null | undefined, now: Date): boolean {
  return !lastCheerAt || utcDayKey(lastCheerAt) !== utcDayKey(now);
}
