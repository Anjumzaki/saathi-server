import { Router } from 'express';
import { z } from 'zod';
import type { Services, VerifiedIdentity } from '../interfaces';
import { requireAuth } from '../middleware/auth';
import { RefreshToken } from '../models/RefreshToken';
import { User } from '../models/User';
import { checkOtp, issueOtp } from '../services/otp';
import { issueTokenPair, revokeRefreshToken, rotateRefreshToken } from '../services/tokens';
import { ensureAdminRole, serializeUser } from '../services/users';
import { emailField as email, displayNameField, passwordField as password, phoneE164 as phone, termsVersionField } from '../schemas/common';
import { hashPassword, verifyPassword } from '../utils/password';
import { LOGIN_LOCK, afterFailure, afterSuccess, lockSecondsLeft } from '../services/loginLock';
import { fieldsForNewUser } from '../services/signupProfile';
import { ApiError, conflict, tooMany, unauthorized } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';

const code = z.string().regex(/^\d{6}$/, 'code must be 6 digits');
/** Optional sign-up form data. Applied ONLY when this request creates the account, never to an existing one. */
const signup = z.object({
  displayName: displayNameField.optional(),
  phone: phone.optional(),
  acceptTerms: z.literal(true).optional(),
  termsVersion: termsVersionField.optional(),
}).strict();

export function authRoutes(s: Services): Router {
  const r = Router();

  async function finishSignIn(u: InstanceType<typeof User>, isNewUser = false) {
    if (u.deletedAt) throw new ApiError(403, 'account_deleted', 'This account was deleted.');
    await ensureAdminRole(u);
    const tokens = await issueTokenPair(u._id, u.roles);
    return { user: serializeUser(u), tokens, isNewUser };
  }

  async function signInWithIdentity(id: VerifiedIdentity) {
    const subField = id.provider === 'google' ? 'googleSub' : 'appleSub';
    let u = await User.findOne({ [subField]: id.subject });
    if (!u && id.email && id.emailVerified) {
      u = await User.findOne({ email: id.email });
      if (u) {
        u.set(subField, id.subject);
        await u.save();
      }
    }
    const isNew = !u;
    if (!u) u = await User.create({ [subField]: id.subject, email: id.emailVerified ? id.email : undefined, displayName: id.name });
    return finishSignIn(u, isNew);
  }

  // ----- email OTP -----
  r.post('/otp/request', asyncHandler(async (req, res) => {
    const { email: addr } = parse(z.object({ email }), req.body);
    const { code: c, resendAfterSeconds } = await issueOtp(`email:${addr}`);
    await s.mailer.send({
      to: addr,
      subject: 'Your Saathi sign-in code',
      text: `Your Saathi code is ${c}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
    });
    res.json({ ok: true, resendAfterSeconds });
  }));

  r.post('/otp/verify', asyncHandler(async (req, res) => {
    const { email: addr, code: c, signup: form } = parse(z.object({ email, code, signup: signup.optional() }), req.body);
    await checkOtp(`email:${addr}`, c);
    let u = await User.findOne({ email: addr });
    const isNew = !u;
    u ??= await User.create({ email: addr, ...fieldsForNewUser(form, new Date()) });
    res.json(await finishSignIn(u, isNew));
  }));

  // ----- email + password -----
  r.post('/signup', asyncHandler(async (req, res) => {
    const { email: addr, password: pw, signup: form } = parse(z.object({ email, password, signup: signup.optional() }), req.body);
    if (await User.exists({ email: addr })) throw conflict('An account with this email already exists. Sign in instead.', 'email_in_use');
    const u = await User.create({ email: addr, passwordHash: await hashPassword(pw), ...fieldsForNewUser(form, new Date()) });
    res.json(await finishSignIn(u, true));
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
    res.json(await finishSignIn(u, false));
  }));

  // Forgot password: the same emailed 6-digit code, now only used to set a new password.
  r.post('/password/forgot', asyncHandler(async (req, res) => {
    const { email: addr } = parse(z.object({ email }), req.body);
    const u = await User.findOne({ email: addr }).select('deletedAt');
    if (!u || u.deletedAt) { res.json({ ok: true, resendAfterSeconds: 60 }); return; } // never reveal whether an email has an account
    const { code: c, resendAfterSeconds } = await issueOtp(`reset:${addr}`);
    await s.mailer.send({
      to: addr,
      subject: 'Reset your Saathi password',
      text: `Your Saathi password reset code is ${c}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
    });
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
  r.post('/google', asyncHandler(async (req, res) => {
    const { idToken } = parse(z.object({ idToken: z.string().min(1).max(5000) }), req.body);
    res.json(await signInWithIdentity(await s.googleVerifier.verify(idToken)));
  }));
  r.post('/apple', asyncHandler(async (req, res) => {
    const { idToken } = parse(z.object({ idToken: z.string().min(1).max(5000) }), req.body);
    res.json(await signInWithIdentity(await s.appleVerifier.verify(idToken)));
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

  // ----- lazy phone verification (only when a feature needs it) -----
  r.post('/phone/request', requireAuth, asyncHandler(async (req, res) => {
    const { phone: p } = parse(z.object({ phone }), req.body);
    const { userId } = authOf(req);
    const { code: c, resendAfterSeconds } = await issueOtp(`phone:${userId}:${p}`);
    await s.sms.send({ to: p, text: `Your Saathi verification code is ${c}. It expires in 10 minutes.` });
    res.json({ ok: true, resendAfterSeconds });
  }));
  r.post('/phone/verify', requireAuth, asyncHandler(async (req, res) => {
    const { phone: p, code: c } = parse(z.object({ phone, code }), req.body);
    const { userId } = authOf(req);
    await checkOtp(`phone:${userId}:${p}`, c);
    const u = await User.findById(userId);
    if (!u) throw unauthorized();
    u.phone = p;
    u.phoneVerified = true;
    await u.save();
    res.json({ user: serializeUser(u) });
  }));

  return r;
}
