import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../interfaces';
import { PartnerShare } from '../models/PartnerShare';
import { DietitianProfile } from '../models/DietitianProfile';
import { Lead } from '../models/Lead';
import { Message } from '../models/Message';
import { Order } from '../models/Order';
import { Otp } from '../models/Otp';
import { Plan } from '../models/Plan';
import { SyncRecord } from '../models/SyncRecord';
import { User } from '../models/User';
import { displayNameField, emailField, phoneE164, termsVersionField } from '../schemas/common';
import { codeEmail } from '../services/emailTemplates';
import { checkOtp, issueOtp } from '../services/otp';
import { OTP_CONFIG } from '../services/otpLogic';
import { CURRENT_TERMS_VERSION } from '../services/signupProfile';
import { mongoPurgeOps, purgeAccount } from '../services/accountPurge';
import { emailChangeOtpKey, emailChangeProblem, serializeUser } from '../services/users';
import { conflict, notFound, notImplemented } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';
import { log } from '../utils/logger';

/** Taken from the OTP config so the email can never promise an expiry the server does not honour. */
const OTP_MINUTES = Math.round(OTP_CONFIG.ttlMs / 60_000);
const sixDigits = z.string().regex(/^\d{6}$/, 'code must be 6 digits');

/**
 * `services` is optional only because app.ts still mounts this router as `accountRoutes()`. Email
 * change needs the mailer, so until that call passes `services` the two /email routes answer 501
 * rather than pretending a code went out. See qa/wiring/free-features.md.
 */
export function accountRoutes(services?: Pick<Services, 'mailer'>): Router {
  const r = Router();

  r.get('/', asyncHandler(async (req, res) => {
    const u = await User.findById(authOf(req).userId);
    if (!u || u.deletedAt) throw notFound('Account not found');
    res.json({ user: serializeUser(u) });
  }));

  r.patch('/', asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        displayName: displayNameField.optional(),
        country: z.string().length(2).toUpperCase().optional(),
        timezone: z.string().max(64).optional(),
        /** E.164, or null to remove it. A changed number is unverified until /auth/phone/verify. */
        phone: phoneE164.nullable().optional(),
        acceptTerms: z.literal(true).optional(),
        termsVersion: termsVersionField.optional(),
      }).strict(),
      req.body,
    );
    const u = await User.findById(authOf(req).userId);
    if (!u || u.deletedAt) throw notFound();
    const { phone, acceptTerms, termsVersion, ...rest } = body;
    u.set(rest);
    if (phone !== undefined && (phone ?? undefined) !== (u.phone ?? undefined)) {
      u.phone = phone ?? undefined;
      u.phoneVerified = false;
    }
    if (acceptTerms) {
      u.termsAcceptedAt = new Date();
      u.termsVersion = termsVersion ?? CURRENT_TERMS_VERSION;
    }
    await u.save();
    res.json({ user: serializeUser(u) });
  }));

  /**
   * Changing the sign-in address, step 1: claim it and send a code to the NEW address. Nothing on the
   * account changes here, so the old address keeps working (and keeps signing in) until step 2.
   * Asking again is the resend: the OTP service enforces its own cooldown and attempt lock.
   */
  r.post('/email/change', asyncHandler(async (req, res) => {
    const { email } = parse(z.object({ email: emailField }).strict(), req.body);
    const mailer = services?.mailer;
    if (!mailer) throw notImplemented('Changing your email is not available on this server yet.');
    const u = await User.findById(authOf(req).userId);
    if (!u || u.deletedAt) throw notFound();
    const takenByOther = !!(await User.exists({ email, deletedAt: null, _id: { $ne: u._id } }));
    const problem = emailChangeProblem(u.email, email, takenByOther);
    if (problem === 'same_email') throw conflict('That is already your email address.', 'same_email');
    if (problem) throw conflict('An account with this email already exists. Use a different address.', 'email_in_use');
    const { code, resendAfterSeconds } = await issueOtp(emailChangeOtpKey(String(u._id), email));
    await mailer.send({ to: email, ...codeEmail('email_change', code, OTP_MINUTES) });
    res.json({ ok: true, pendingEmail: email, resendAfterSeconds });
  }));

  /**
   * Step 2: the code proves she can read the new mailbox, so that is what moves the address and marks
   * it verified. The "already in use" check runs again here, because another account could have
   * claimed the address while this code was in flight.
   */
  r.post('/email/confirm', asyncHandler(async (req, res) => {
    const { email, code } = parse(z.object({ email: emailField, code: sixDigits }).strict(), req.body);
    const u = await User.findById(authOf(req).userId);
    if (!u || u.deletedAt) throw notFound();
    if (u.email === email) { res.json({ user: serializeUser(u) }); return; } // already done (she tapped twice)
    await checkOtp(emailChangeOtpKey(String(u._id), email), code);
    if (await User.exists({ email, deletedAt: null, _id: { $ne: u._id } })) {
      throw conflict('An account with this email already exists. Use a different address.', 'email_in_use');
    }
    u.email = email;
    u.emailVerifiedAt = new Date();
    try {
      await u.save();
    } catch (e) {
      // The unique index is the last word, in case two accounts confirmed the same address at once.
      if ((e as { code?: number }).code === 11000) throw conflict('An account with this email already exists. Use a different address.', 'email_in_use');
      throw e;
    }
    res.json({ user: serializeUser(u) });
  }));

  /** Full data export (GDPR-style). Secrets (token hashes, OTP hashes, purchase tokens) are excluded. */
  r.get('/export', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const u = await User.findById(userId);
    if (!u) throw notFound();
    const [records, plans, ordersAsClient, ordersAsDietitian, shares, profile] = await Promise.all([
      SyncRecord.find({ userId }).lean(),
      Plan.find({ userId }).lean(),
      Order.find({ clientId: userId }).select('-purchaseToken').lean(),
      Order.find({ dietitianId: userId }).select('-purchaseToken').lean(),
      PartnerShare.find({ $or: [{ ownerId: userId }, { partnerId: userId }] }).select('-inviteTokenHash').lean(),
      DietitianProfile.findOne({ userId }).lean(),
    ]);
    const orderIds = [...ordersAsClient, ...ordersAsDietitian].map((o) => o._id);
    const messages = await Message.find({ orderId: { $in: orderIds } }).lean();
    const syncByCollection: Record<string, unknown[]> = {};
    for (const rec of records) (syncByCollection[rec.coll] ??= []).push({ clientId: rec.clientId, updatedAt: rec.updatedAt, deleted: rec.deleted, payload: rec.payload });
    res.setHeader('Content-Disposition', 'attachment; filename="saathi-export.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      user: serializeUser(u),
      sync: syncByCollection,
      plans,
      orders: { asClient: ordersAsClient, asDietitian: ordersAsDietitian },
      messages,
      partnerShares: shares,
      dietitianProfile: profile,
    });
  }));

  /**
   * "Sign out & reset data": erases what the app synced (plan, logs, settings, cycle and so on) and the saved plan versions,
   * but keeps the account, orders, partner shares and subscription. Signing in again starts from an empty account.
   */
  r.delete('/data', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    await Promise.all([SyncRecord.deleteMany({ userId }), Plan.deleteMany({ userId })]);
    res.status(204).end();
  }));

  /**
   * Account deletion. Everything of hers goes now rather than in thirty days: there is no "restore",
   * so a grace period would only mean her cycle history sitting on the server for another month. The
   * purge job runs the same steps on a schedule and is the safety net - for accounts deleted before
   * this existed, for a row that arrives late, and for a step that fails here.
   *
   * Blocked while an order is in flight so nobody is left unpaid or unserved. The order itself is kept
   * afterwards (the dietitian's record of work delivered, and the figures kept for tax) with nothing of
   * hers left on it. What survives, and why, is listed in `purgePlan`.
   */
  r.delete('/', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const open = await Order.exists({ $or: [{ clientId: userId }, { dietitianId: userId }], status: { $in: ['paid', 'in_progress', 'delivered'] } });
    if (open) throw conflict('You have an order in progress. Finish or refund it before deleting your account.', 'open_orders');
    const u = await User.findById(userId);
    if (u) {
      // Keyed on the address, not on her id, so this is the last moment anything can find them.
      if (u.email) {
        await Promise.all([
          Lead.deleteMany({ email: u.email }),
          Otp.deleteOne({ key: `email:${u.email}` }),
          Otp.deleteOne({ key: `reset:${u.email}` }),
        ]);
      }
      // Marked deleted before a single row is touched, so a failure below leaves an account the job finishes.
      await User.collection.updateOne({ _id: u._id }, { $set: { deletedAt: new Date() } });
    }
    try {
      await purgeAccount(mongoPurgeOps(), userId);
    } catch (e) {
      log.error('account deletion did not finish; left for the purge job', { message: e instanceof Error ? e.message : String(e) });
    }
    res.status(204).end();
  }));

  return r;
}
