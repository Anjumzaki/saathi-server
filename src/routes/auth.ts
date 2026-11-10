import { Router } from 'express';
import { z } from 'zod';
import type { Services, VerifiedIdentity } from '../interfaces';
import { requireAuth } from '../middleware/auth';
import { User } from '../models/User';
import { checkOtp, issueOtp } from '../services/otp';
import { issueTokenPair, revokeRefreshToken, rotateRefreshToken } from '../services/tokens';
import { ensureAdminRole, serializeUser } from '../services/users';
import { forbidden, unauthorized } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';

const email = z.string().trim().toLowerCase().email().max(254);
const code = z.string().regex(/^\d{6}$/, 'code must be 6 digits');
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164, e.g. +923001234567');

export function authRoutes(s: Services): Router {
  const r = Router();

  async function finishSignIn(u: InstanceType<typeof User>) {
    if (u.deletedAt) throw forbidden('Account deleted');
    await ensureAdminRole(u);
    const tokens = await issueTokenPair(u._id, u.roles);
    return { user: serializeUser(u), tokens };
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
    if (!u) u = await User.create({ [subField]: id.subject, email: id.emailVerified ? id.email : undefined, displayName: id.name });
    return finishSignIn(u);
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
    const { email: addr, code: c } = parse(z.object({ email, code }), req.body);
    await checkOtp(`email:${addr}`, c);
    let u = await User.findOne({ email: addr });
    u ??= await User.create({ email: addr });
    res.json(await finishSignIn(u));
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
