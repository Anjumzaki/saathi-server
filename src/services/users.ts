import { getEnv } from '../config/env';
import { User } from '../models/User';
import { effectiveStatus, isPremiumActive } from './entitlement';

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
