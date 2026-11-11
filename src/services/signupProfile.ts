/** What a brand-new account may take from the sign-up form. Pure, so the "never overwrite an existing account" rule is testable. */
export interface SignupInput { displayName?: string; phone?: string; acceptTerms?: true; termsVersion?: string }
export interface SignupFields { displayName?: string; phone?: string; phoneVerified?: false; termsAcceptedAt?: Date; termsVersion?: string }

export const CURRENT_TERMS_VERSION = '2026-11';

/** Fields to set when the account is created by this request. */
export function fieldsForNewUser(input: SignupInput | undefined, now: Date): SignupFields {
  if (!input) return {};
  const out: SignupFields = {};
  if (input.displayName) out.displayName = input.displayName;
  if (input.phone) { out.phone = input.phone; out.phoneVerified = false; }
  if (input.acceptTerms) { out.termsAcceptedAt = now; out.termsVersion = input.termsVersion ?? CURRENT_TERMS_VERSION; }
  return out;
}

/** An account still needs the "finish your account" step until it has a name and accepted terms. */
export function needsProfile(u: { displayName?: string | null; termsAcceptedAt?: Date | null }): boolean {
  return !u.displayName?.trim() || !u.termsAcceptedAt;
}
