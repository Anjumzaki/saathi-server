import { getEnv } from '../config/env';
import { User } from '../models/User';
import { effectiveStatus, isPremiumActive } from './entitlement';
import { needsProfile } from './signupProfile';

type UserDoc = InstanceType<typeof User>;

export function serializeUser(u: UserDoc, now = new Date()) {
  const sub = u.subscription;
  return {
    id: String(u._id),
    email: u.email ?? null,
    displayName: u.displayName ?? null,
    country: u.country ?? null,
    timezone: u.timezone ?? null,
    roles: u.roles,
    phone: u.phone ?? null,
    phoneVerified: u.phoneVerified,
    emailVerified: !!u.emailVerifiedAt,
    termsAcceptedAt: u.termsAcceptedAt ?? null,
    termsVersion: u.termsVersion ?? null,
    needsProfile: needsProfile(u),
    subscription: {
      status: effectiveStatus(sub as never, now),
      plan: sub?.plan ?? null,
      trialEndsAt: sub?.trialEndsAt ?? null,
      expiresAt: sub?.expiresAt ?? null,
      source: sub?.source ?? null,
      isPremium: isPremiumActive(sub as never, now),
    },
    createdAt: (u as unknown as { createdAt?: Date }).createdAt ?? null,
  };
}

/**
 * Changing the address she signs in with.
 *
 * The OTP slot is keyed on the account AND the address being claimed, so asking for a code for a
 * second address does not quietly invalidate the first, and a code only ever confirms the address it
 * was sent to. Nothing on the account moves until the code comes back: the old address keeps working.
 */
export const emailChangeOtpKey = (userId: string, email: string) => `email-change:${userId}:${email.trim().toLowerCase()}`;
/** Matches every pending email-change code for an account (used when the account is deleted). */
export const emailChangeOtpKeyPrefix = (userId: string) => `email-change:${userId}:`;

export type EmailChangeProblem = 'same_email' | 'email_in_use' | null;

/** Pure: may `next` become this account's address? `takenByOther` is "some other live account already has it". */
export function emailChangeProblem(current: string | null | undefined, next: string, takenByOther: boolean): EmailChangeProblem {
  const to = next.trim().toLowerCase();
  if (current && current.trim().toLowerCase() === to) return 'same_email';
  return takenByOther ? 'email_in_use' : null;
}

/** Admin role is granted from ADMIN_EMAILS (env), never from client input. */
export async function ensureAdminRole(u: UserDoc): Promise<void> {
  if (u.email && getEnv().ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(u.email) && !u.roles.includes('admin')) {
    u.roles.push('admin');
    await u.save();
  }
}

export async function addRole(userId: string, role: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $addToSet: { roles: role } });
}
