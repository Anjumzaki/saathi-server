import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../interfaces';
import { User } from '../models/User';
import {
  entitlementFromPlay,
  isPremiumActive,
  resolveEntitlement,
  type PlayVerification,
  type PurchaseSource,
} from '../services/entitlement';
import { getPaidPackages, tierOfProduct, type PaidTier } from '../services/packageCatalogue';
import { getActivePackages } from '../services/feeConfig';
import { serializeUser } from '../services/users';
import { badRequest, conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';

/**
 * Public price list (no fee data is exposed). `packages` is the raw config the dietitian price bands use;
 * `premiumPackages` is the paid subscription catalogue the paywall reads (Premium and Premium Plus).
 */
export function packagesRoutes(): Router {
  const r = Router();
  r.get('/', asyncHandler(async (_req, res) => {
    const [packages, premiumPackages] = await Promise.all([getActivePackages(), getPaidPackages()]);
    res.json({ packages, premiumPackages });
  }));
  return r;
}

export function subscriptionRoutes(s: Services): Router {
  const r = Router();

  r.get('/', asyncHandler(async (req, res) => {
    const u = await User.findById(authOf(req).userId);
    if (!u) throw notFound();
    const now = new Date();
    const view = serializeUser(u, now);
    const ent = resolveEntitlement(u.subscription as never, now);
    res.json({
      subscription: {
        ...view.subscription,
        tier: ent.tier,
        features: ent.features,
        // The partner preview window: owned by the partner slice, null until it sets one.
        previewEndsAt: null,
      },
    });
  }));

  /** Which package and billing period a store product id belongs to. */
  async function productPackage(productId: string): Promise<{ tier: PaidTier; plan: 'monthly' | 'yearly' }> {
    const found = tierOfProduct(await getPaidPackages(), productId);
    if (!found) throw badRequest('Unknown Premium product');
    return found;
  }

  async function grant(
    userId: string,
    productId: string,
    token: string,
    plan: 'monthly' | 'yearly',
    v: PlayVerification,
    source: PurchaseSource,
    tier: PaidTier,
  ) {
    const taken = await User.exists({ _id: { $ne: userId }, 'subscription.purchaseToken': token });
    if (taken) throw conflict('This purchase is already linked to another account', 'purchase_token_in_use');
    if (!v.valid) throw badRequest('Purchase could not be verified');
    const now = new Date();
    const ent = entitlementFromPlay(v, plan, now, source, tier);
    const u = await User.findByIdAndUpdate(
      userId,
      { $set: { subscription: { ...ent, productId, purchaseToken: token, playOrderId: v.orderId ?? null, updatedAt: now } } },
      { new: true },
    );
    if (!u) throw notFound();
    const resolved = resolveEntitlement(ent, now);
    return {
      subscription: { ...serializeUser(u, now).subscription, tier: resolved.tier, features: resolved.features, previewEndsAt: null },
      isPremium: isPremiumActive(ent, now),
    };
  }

  /**
   * Android: the app completes the Play Billing purchase, then sends productId + purchaseToken here. The server
   * verifies it with Google (PlayBilling) and stores the entitlement on the user.
   */
  r.post('/google-play/verify', asyncHandler(async (req, res) => {
    const body = parse(z.object({ productId: z.string().min(1).max(200), purchaseToken: z.string().min(1).max(4000) }), req.body);
    const pkg = await productPackage(body.productId);
    const v = await s.playBilling.verify({ productId: body.productId, purchaseToken: body.purchaseToken, kind: 'subscription' });
    res.json(await grant(authOf(req).userId, body.productId, body.purchaseToken, pkg.plan, v, 'google_play', pkg.tier));
  }));

  /** iOS: the app completes the StoreKit purchase, then sends productId + originalTransactionId here. */
  r.post('/app-store/verify', asyncHandler(async (req, res) => {
    const body = parse(z.object({ productId: z.string().min(1).max(200), transactionId: z.string().min(1).max(200) }), req.body);
    const pkg = await productPackage(body.productId);
    const v = await s.appStoreBilling.verify({ productId: body.productId, transactionId: body.transactionId });
    res.json(await grant(authOf(req).userId, body.productId, body.transactionId, pkg.plan, v, 'app_store', pkg.tier));
  }));

  return r;
}
