import { Router } from 'express';
import { z } from 'zod';
import { Cheer, PartnerShare } from '../models/PartnerShare';
import { CallBooking } from '../models/CallBooking';
import { DietitianProfile } from '../models/DietitianProfile';
import { Message } from '../models/Message';
import { Order } from '../models/Order';
import { Otp } from '../models/Otp';
import { Plan } from '../models/Plan';
import { RefreshToken } from '../models/RefreshToken';
import { SyncRecord } from '../models/SyncRecord';
import { User } from '../models/User';
import { displayNameField, phoneE164, termsVersionField } from '../schemas/common';
import { CURRENT_TERMS_VERSION } from '../services/signupProfile';
import { serializeUser } from '../services/users';
import { conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';

export function accountRoutes(): Router {
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
   * Account deletion. Orders are financial records and are retained (their parties are anonymised via the user row).
   * Blocked while an order is still in flight so nobody is left unpaid / unserved.
   */
  r.delete('/', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const open = await Order.exists({ $or: [{ clientId: userId }, { dietitianId: userId }], status: { $in: ['paid', 'in_progress', 'delivered'] } });
    if (open) throw conflict('You have an order in progress. Finish or refund it before deleting your account.', 'open_orders');
    const myShares = await PartnerShare.find({ $or: [{ ownerId: userId }, { partnerId: userId }] }).select('_id');
    await Promise.all([
      SyncRecord.deleteMany({ userId }),
      Plan.deleteMany({ userId }),
      RefreshToken.deleteMany({ userId }),
      Otp.deleteMany({ key: { $regex: `^phone:${userId}:` } }),
      Cheer.deleteMany({ shareId: { $in: myShares.map((s) => s._id) } }),
      PartnerShare.deleteMany({ _id: { $in: myShares.map((s) => s._id) } }),
      DietitianProfile.deleteMany({ userId }),
      CallBooking.deleteMany({ $or: [{ clientId: userId }, { dietitianId: userId }], status: { $ne: 'completed' } }),
      Message.updateMany({ senderId: userId }, { $set: { text: null, photoRef: null, planUpdate: null } }),
    ]);
    const u = await User.findById(userId);
    if (u) {
      await Otp.deleteOne({ key: `email:${u.email}` });
      await Otp.deleteOne({ key: `reset:${u.email}` });
      await User.collection.updateOne(
        { _id: u._id },
        {
          $set: { deletedAt: new Date(), roles: [], phoneVerified: false, subscription: { status: 'none' } },
          $unset: { email: '', displayName: '', phone: '', googleSub: '', appleSub: '', country: '', timezone: '' },
        },
      );
    }
    res.status(204).end();
  }));

  return r;
}
