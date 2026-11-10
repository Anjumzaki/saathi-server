import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../interfaces';
import { PackageConfig } from '../models/PackageConfig';
import { User } from '../models/User';
import { entitlementFromPlay, isPremiumActive, type PlayVerification, type PurchaseSource } from '../services/entitlement';
import { getActivePackages } from '../services/feeConfig';
import { serializeUser } from '../services/users';
import { badRequest, conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';

/** Public price list (no fee data is exposed). */
export function packagesRoutes(): Router {
  const r = Router();
  r.get('/', asyncHandler(async (_req, res) => {
    res.json({ packages: await getActivePackages() });
  }));
  return r;
}

export function subscriptionRoutes(s: Services): Router {
  const r = Router();

  r.get('/', asyncHandler(async (req, res) => {
    const u = await User.findById(authOf(req).userId);
    if (!u) throw notFound();
    const view = serializeUser(u);
    res.json({ subscription: view.subscription });
  }));

  /** Look up the Premium variant for a store product id. */
  async function premiumVariant(productId: string) {
    const pkg = await PackageConfig.findOne({ kind: 'premium', active: true, 'variants.productId': productId }).lean();
    const variant = pkg?.variants.find((v) => v.productId === productId);
    if (!pkg || !variant || (variant.variant !== 'monthly' && variant.variant !== 'yearly')) throw badRequest('Unknown Premium product');
    return variant.variant;
  }

  async function grant(userId: string, productId: string, token: string, plan: 'monthly' | 'yearly', v: PlayVerification, source: PurchaseSource) {
    const taken = await User.exists({ _id: { $ne: userId }, 'subscription.purchaseToken': token });
    if (taken) throw conflict('This purchase is already linked to another account', 'purchase_token_in_use');
    if (!v.valid) throw badRequest('Purchase could not be verified');
    const now = new Date();
    const ent = entitlementFromPlay(v, plan, now, source);
    const u = await User.findByIdAndUpdate(
      userId,
      { $set: { subscription: { ...ent, productId, purchaseToken: token, playOrderId: v.orderId ?? null, updatedAt: now } } },
      { new: true },
    );
    if (!u) throw notFound();
    return { subscription: serializeUser(u).subscription, isPremium: isPremiumActive(ent, now) };
  }

  /**
   * Android: the app completes the Play Billing purchase, then sends productId + purchaseToken here. The server
   * verifies it with Google (PlayBilling) and stores the entitlement on the user.
   */
  r.post('/google-play/verify', asyncHandler(async (req, res) => {
    const body = parse(z.object({ productId: z.string().min(1).max(200), purchaseToken: z.string().min(1).max(4000) }), req.body);
    const plan = await premiumVariant(body.productId);
    const v = await s.playBilling.verify({ productId: body.productId, purchaseToken: body.purchaseToken, kind: 'subscription' });
    res.json(await grant(authOf(req).userId, body.productId, body.purchaseToken, plan, v, 'google_play'));
  }));

  /** iOS: the app completes the StoreKit purchase, then sends productId + originalTransactionId here. */
  r.post('/app-store/verify', asyncHandler(async (req, res) => {
    const body = parse(z.object({ productId: z.string().min(1).max(200), transactionId: z.string().min(1).max(200) }), req.body);
    const plan = await premiumVariant(body.productId);
    const v = await s.appStoreBilling.verify({ productId: body.productId, transactionId: body.transactionId });
    res.json(await grant(authOf(req).userId, body.productId, body.transactionId, plan, v, 'app_store'));
  }));

  return r;
}
