import { Router } from 'express';
import { z } from 'zod';
import type { Services, VerifiedIdentity } from '../interfaces';
import { requireAuth } from '../middleware/auth';
import { RefreshToken } from '../models/RefreshToken';
import { User } from '../models/User';
import { checkOtp, issueOtp } from '../services/otp';
import { OTP_CONFIG } from '../services/otpLogic';
import { createSmsQuota, smsQuotaError } from '../services/sms';
import { codeEmail, type CodePurpose } from '../services/emailTemplates';
import { issueTokenPair, revokeRefreshToken, rotateRefreshToken } from '../services/tokens';
import { ensureAdminRole, serializeUser } from '../services/users';
import { emailField as email, displayNameField, passwordField as password, phoneE164 as phone, termsVersionField } from '../schemas/common';
import { hashPassword, verifyPassword } from '../utils/password';
import { LOGIN_LOCK, afterFailure, afterSuccess, lockSecondsLeft } from '../services/loginLock';
import { fieldsForNewUser } from '../services/signupProfile';
import { ApiError, conflict, tooMany, unauthorized } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';

const code = z.string().regex(/^\d{6}$/, 'code must be 6 digits');
/** Taken from the OTP config so the email can never promise an expiry the server does not honour. */
const OTP_MINUTES = Math.round(OTP_CONFIG.ttlMs / 60_000);
/** Optional sign-up form data. Applied ONLY when this request creates the account, never to an existing one. */
const signup = z.object({
  displayName: displayNameField.optional(),
  phone: phone.optional(),
  acceptTerms: z.literal(true).optional(),
  termsVersion: termsVersionField.optional(),
}).strict();

export function authRoutes(s: Services): Router {
  const r = Router();
  // One counter per server process, shared by every account: see services/sms.ts for what that buys.
  const smsQuota = createSmsQuota();

  const sendCode = (to: string, purpose: CodePurpose, c: string) => s.mailer.send({ to, ...codeEmail(purpose, c, OTP_MINUTES) });

  /** Entering an emailed code proves control of the mailbox, so it is what marks the address verified. */
  async function markEmailVerified(u: InstanceType<typeof User>): Promise<void> {
    if (u.emailVerifiedAt) return;
    u.emailVerifiedAt = new Date();
    await u.save();
  }

  async function finishSignIn(u: InstanceType<typeof User>, isNewUser = false) {
    if (u.deletedAt) throw new ApiError(403, 'account_deleted', 'This account was deleted.');
    await ensureAdminRole(u);
    const tokens = await issueTokenPair(u._id, u.roles);
    return { user: serializeUser(u), tokens, isNewUser };
  }

  /**
   * Google or Apple has vouched for her. Three ways this can go: a subject we have seen before (sign
   * her in), a verified address that already has an account (join the two), or neither (make one).
   *
   * The subject is what identifies her, not the address. Apple gives the address on the first sign-in
   * and never again, so a returning woman is found by her subject alone, and `id.email` being absent
   * means nothing is wrong.
   */
  async function signInWithIdentity(id: VerifiedIdentity) {
    const subField = id.provider === 'google' ? 'googleSub' : 'appleSub';
    const email = id.email?.trim().toLowerCase();
    // Only an address the provider says it has checked may find an existing account. The client's own
    // idea of her email is never read: a request that could name an address could claim any account.
    const linkable = email && id.emailVerified ? email : undefined;
    let u = await User.findOne({ [subField]: id.subject });

    if (!u && linkable) {
      const byEmail = await User.findOne({ email: linkable, deletedAt: null });
      if (byEmail && !byEmail.get(subField)) {
        /*
         * Deliberate: a verified Google or Apple address joins the account that already has it, password
         * and all. Google and Apple hand over an address only once they have checked the mailbox, which
         * is the same proof an emailed code gives — so this is not a weaker door, it is the same one.
         * Refusing would leave her locked out of her own data behind a password she came here because she
         * had forgotten. Her password keeps working, no session elsewhere is disturbed, and nothing about
         * the account changes beyond gaining a second way in.
         */
        byEmail.set(subField, id.subject);
        byEmail.emailVerifiedAt ??= new Date();
        if (!byEmail.displayName?.trim() && id.name) byEmail.displayName = id.name;
        await byEmail.save();
        u = byEmail;
      } else if (byEmail) {
        // That address already has a different provider account against it, which should be impossible
        // for one person. Refuse rather than quietly move the link to somebody else's sign-in.
        throw conflict('This email is already set up with a different sign-in. Use your email and password.', 'email_in_use');
      }
    }

    const isNew = !u;
    if (!u) {
      u = await User.create({
        [subField]: id.subject,
        ...(linkable ? { email: linkable } : {}),
        ...(id.name ? { displayName: id.name } : {}),
        // Google and Apple have already checked the mailbox; re-asking would be theatre.
        emailVerifiedAt: linkable ? new Date() : null,
      });
    } else {
      if (linkable && u.email === linkable) await markEmailVerified(u);
      // Apple says the name once in a lifetime. If we did not have one, take it now or never.
      if (!u.displayName?.trim() && id.name) { u.displayName = id.name; await u.save(); }
    }
    return finishSignIn(u, isNew);
  }

  // ----- email OTP -----
  // Also the resend for a sign-up waiting on verification: same key, so the newest code always wins.
  r.post('/otp/request', asyncHandler(async (req, res) => {
    const { email: addr } = parse(z.object({ email }), req.body);
    const pending = await User.exists({ email: addr, emailVerifiedAt: null, deletedAt: null });
    // Codes are only for confirming a sign-up. Sign-in is by password, so an unknown or already
    // confirmed address gets the same answer and no email (never reveals which addresses exist).
    if (!pending) { res.json({ ok: true, resendAfterSeconds: 60 }); return; }
    const { code: c, resendAfterSeconds } = await issueOtp(`email:${addr}`);
    await sendCode(addr, 'verify', c);
    res.json({ ok: true, resendAfterSeconds });
  }));

  /**
   * Confirms a sign-up. This is NOT a way to sign in: it never creates an account and it refuses
   * an address that is already confirmed (those sign in with their password).
   * The password is sent again here and is the one that is kept: whoever can read the mailbox
   * decides the password, so someone who signed up first with her address cannot keep theirs.
   */
  r.post('/otp/verify', asyncHandler(async (req, res) => {
    const { email: addr, code: c, password: pw } = parse(z.object({ email, code, password: password.optional(), signup: signup.optional() }), req.body);
    await checkOtp(`email:${addr}`, c);
    const u = await User.findOne({ email: addr }).select('+passwordHash');
    if (!u || u.deletedAt) throw new ApiError(404, 'no_account', 'There is no account waiting for this email. Sign up first.');
    if (u.emailVerifiedAt) throw new ApiError(403, 'use_password', 'This email is already confirmed. Sign in with your password.');
    if (!pw) throw new ApiError(400, 'password_required', 'Enter your password again to finish signing up.');
    u.passwordHash = await hashPassword(pw);
    u.failedLogins = 0;
    u.loginLockedUntil = null;
    await u.save();
    await markEmailVerified(u);
    res.json(await finishSignIn(u, true));
  }));

  // ----- email + password -----
  /**
   * Sign-up does NOT sign anyone in: it creates the account unverified and emails a code, which
   * POST /otp/verify exchanges for tokens. The response is deliberately shaped like
   * /otp/request so the app can send both to the same code screen.
   */
  r.post('/signup', asyncHandler(async (req, res) => {
    const { email: addr, password: pw, signup: form } = parse(z.object({ email, password, signup: signup.optional() }), req.body);
    const existing = await User.findOne({ email: addr }).select('emailVerifiedAt deletedAt');
    // A verified account (or a deleted one, which must not be silently revived) is a conflict.
    if (existing && (existing.emailVerifiedAt || existing.deletedAt)) {
      throw conflict('An account with this email already exists. Sign in instead.', 'email_in_use');
    }
    // Unverified and still pending: she closed the app mid-signup. Resend the code and let her
    // carry on. The stored password is left alone, so a stranger cannot overwrite it this way.
    if (!existing) {
      await User.create({ email: addr, passwordHash: await hashPassword(pw), ...fieldsForNewUser(form, new Date()) });
    }
    const { code: c, resendAfterSeconds } = await issueOtp(`email:${addr}`);
    await sendCode(addr, 'verify', c);
    res.json({ ok: true, emailVerificationRequired: true, resendAfterSeconds });
  }));

  r.post('/login', asyncHandler(async (req, res) => {
    const { email: addr, password: pw } = parse(z.object({ email, password: z.string().min(1).max(128) }), req.body);
    const u = await User.findOne({ email: addr }).select('+passwordHash');
    const now = new Date();
    if (!u) {
      await verifyPassword(pw, 'scrypt$x$x'); // keep the timing similar
      throw new ApiError(401, 'invalid_credentials', 'Email or password is not right.');
    }
    const left = lockSecondsLeft({ failedLogins: u.failedLogins, loginLockedUntil: u.loginLockedUntil ?? null }, now);
    if (left > 0) throw tooMany('Too many wrong passwords. Try again later.', left, 'login_locked');
    if (!u.passwordHash) throw new ApiError(401, 'password_not_set', 'This account has no password yet. Use Forgot password to set one.');
    if (!(await verifyPassword(pw, u.passwordHash))) {
      const next = afterFailure({ failedLogins: u.failedLogins, loginLockedUntil: null }, now);
      u.failedLogins = next.failedLogins;
      u.loginLockedUntil = next.loginLockedUntil;
      await u.save();
      if (next.loginLockedUntil) throw tooMany('Too many wrong passwords. Try again later.', LOGIN_LOCK.lockMs / 1000, 'login_locked');
      throw new ApiError(401, 'invalid_credentials', 'Email or password is not right.');
    }
    const ok = afterSuccess();
    u.failedLogins = ok.failedLogins;
    u.loginLockedUntil = ok.loginLockedUntil;
    await u.save();
    // Checked only after the password is accepted, so this never reveals which addresses exist.
    if (!u.emailVerifiedAt) {
      throw new ApiError(403, 'email_not_verified', 'Confirm your email to finish setting up your account.');
    }
    res.json(await finishSignIn(u, false));
  }));

  // Forgot password: the same emailed 6-digit code, now only used to set a new password.
  r.post('/password/forgot', asyncHandler(async (req, res) => {
    const { email: addr } = parse(z.object({ email }), req.body);
    const u = await User.findOne({ email: addr }).select('deletedAt');
    if (!u || u.deletedAt) { res.json({ ok: true, resendAfterSeconds: 60 }); return; } // never reveal whether an email has an account
    const { code: c, resendAfterSeconds } = await issueOtp(`reset:${addr}`);
    await sendCode(addr, 'reset', c);
    res.json({ ok: true, resendAfterSeconds });
  }));

  r.post('/password/reset', asyncHandler(async (req, res) => {
    const { email: addr, code: c, password: pw } = parse(z.object({ email, code, password }), req.body);
    await checkOtp(`reset:${addr}`, c);
    const u = await User.findOne({ email: addr });
    if (!u) throw new ApiError(400, 'otp_no_code', 'That code is no longer active.');
    u.passwordHash = await hashPassword(pw);
    u.failedLogins = 0;
    u.loginLockedUntil = null;
    // She just read a code sent to this address, so the mailbox is proven even if sign-up never finished.
    u.emailVerifiedAt ??= new Date();
    await u.save();
    res.json(await finishSignIn(u, false));
  }));

  // Change password while signed in: needs the current one. Other devices are signed out; this one gets fresh tokens.
  r.post('/password/change', requireAuth, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }), req.body);
    const { userId } = authOf(req);
    const u = await User.findById(userId).select('+passwordHash');
    if (!u || u.deletedAt) throw unauthorized();
    const now = new Date();
    const left = lockSecondsLeft({ failedLogins: u.failedLogins, loginLockedUntil: u.loginLockedUntil ?? null }, now);
    if (left > 0) throw tooMany('Too many wrong passwords. Try again later.', left, 'login_locked');
    if (!u.passwordHash) throw new ApiError(400, 'password_not_set', 'This account has no password yet. Sign out and use Forgot password to set one.');
    if (!(await verifyPassword(currentPassword, u.passwordHash))) {
      const next = afterFailure({ failedLogins: u.failedLogins, loginLockedUntil: null }, now);
      u.failedLogins = next.failedLogins;
      u.loginLockedUntil = next.loginLockedUntil;
      await u.save();
      if (next.loginLockedUntil) throw tooMany('Too many wrong passwords. Try again later.', LOGIN_LOCK.lockMs / 1000, 'login_locked');
      throw new ApiError(400, 'wrong_password', 'Your current password is not right.');
    }
    if (await verifyPassword(newPassword, u.passwordHash)) throw new ApiError(400, 'same_password', 'Choose a password different from the current one.');
    u.passwordHash = await hashPassword(newPassword);
    u.failedLogins = 0;
    u.loginLockedUntil = null;
    await u.save();
    await RefreshToken.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
    res.json({ tokens: await issueTokenPair(u._id, u.roles) });
  }));

  // ----- social sign-in -----
  /**
   * `nonce` is the one the app put in its own request to the provider, matched against the token's
   * claim so a token minted for some other request cannot be handed to us instead. `fullName` is only
   * for Apple's first sign-in, is not proof of anything, and is used only if an account is created.
   * There is deliberately no `email` field: an unknown key is dropped, and an address from the client
   * is never a reason to let anybody into an account.
   */
  const socialBody = z.object({
    idToken: z.string().min(1).max(5000),
    nonce: z.string().min(8).max(256).optional(),
    fullName: displayNameField.optional(),
  });

  r.post('/google', asyncHandler(async (req, res) => {
    const { idToken, nonce } = parse(socialBody, req.body);
    res.json(await signInWithIdentity(await s.googleVerifier.verify(idToken, { nonce })));
  }));
  r.post('/apple', asyncHandler(async (req, res) => {
    const { idToken, nonce, fullName } = parse(socialBody, req.body);
    res.json(await signInWithIdentity(await s.appleVerifier.verify(idToken, { nonce, fullName })));
  }));

  // ----- tokens -----
  r.post('/refresh', asyncHandler(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(1).max(4000) }), req.body);
    const tokens = await rotateRefreshToken(refreshToken, async (id) => {
      const u = await User.findById(id).select('roles deletedAt');
      return u && !u.deletedAt ? u.roles : null;
    });
    res.json({ tokens });
  }));
  r.post('/logout', asyncHandler(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(1).max(4000) }), req.body);
    await revokeRefreshToken(refreshToken);
    res.json({ ok: true });
  }));

  // ----- phone verification (always optional: nothing in Saathi waits for it) -----
  /**
   * Order matters here. Whether a text can be sent at all, and whether this number has had too many
   * already, are both settled BEFORE a code is issued — otherwise a refusal would still burn her code
   * slot and start the one-minute wait for a text that never went anywhere.
   */
  r.post('/phone/request', requireAuth, asyncHandler(async (req, res) => {
    const { phone: p } = parse(z.object({ phone }), req.body);
    const { userId } = authOf(req);
    if (!s.sms.available) {
      throw new ApiError(503, 'sms_unavailable', 'Confirming your number by text is not available yet. Everything else in Saathi works without it.');
    }
    const quota = smsQuota.check(p, userId);
    if (!quota.allowed) throw smsQuotaError(quota);
    const { code: c, resendAfterSeconds } = await issueOtp(`phone:${userId}:${p}`);
    smsQuota.record(p, userId);
    await s.sms.send({ to: p, text: `Your Saathi verification code is ${c}. It expires in ${OTP_MINUTES} minutes.` });
    res.json({ ok: true, resendAfterSeconds });
  }));
  r.post('/phone/verify', requireAuth, asyncHandler(async (req, res) => {
    const { phone: p, code: c } = parse(z.object({ phone, code }), req.body);
    const { userId } = authOf(req);
    await checkOtp(`phone:${userId}:${p}`, c);
    const u = await User.findById(userId);
    if (!u) throw unauthorized();
    // No check for the number being on another account, on purpose: a shared family number is ordinary,
    // and answering differently for a number that is already known would say so to anyone who asked.
    u.phone = p;
    u.phoneVerified = true;
    await u.save();
    res.json({ user: serializeUser(u) });
  }));

  return r;
}
