import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../interfaces';
import { previewEndsAtForViewer } from '../models/PartnerShare';
import { User } from '../models/User';
import {
  entitlementFromPlay,
  isPremiumActive,
  resolveEntitlement,
  type PurchaseSource,
} from '../services/entitlement';
import { getPaidPackages, tierOfProduct, type PaidTier } from '../services/packageCatalogue';
import type { StoreVerification } from '../services/storeTypes';
import { livePush, subscriptionNoticeFor, trialEndingDue, type PushService } from '../services/push';
import { getActivePackages } from '../services/feeConfig';
import { serializeUser } from '../services/users';
import { badRequest, conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';
import { log } from '../utils/logger';

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

export interface SubscriptionDeps { push: PushService }

export function subscriptionRoutes(s: Services, overrides: Partial<SubscriptionDeps> = {}): Router {
  // livePush() is only reached when nothing is injected, so a test never builds the real service.
  const d: SubscriptionDeps = { push: overrides.push ?? livePush(), ...overrides };
  const r = Router();

  r.get('/', asyncHandler(async (req, res) => {
    const u = await User.findById(authOf(req).userId);
    if (!u) throw notFound();
    const now = new Date();
    const view = serializeUser(u, now);
    const ent = resolveEntitlement(u.subscription as never, now);
    // The app asks this on every launch, which is the only moment we reliably have to warn her in time.
    if (trialEndingDue(u.subscription as never, now)) d.push.notifyOnce(String(u._id), { type: 'subscription', event: 'trial_ending' });
    // Reported so the app can say when a preview ends. The gate itself stays in the partner routes.
    const previewEndsAt = await previewEndsAtForViewer(authOf(req).userId);
    res.json({ subscription: { ...view.subscription, tier: ent.tier, features: ent.features, previewEndsAt } });
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
    v: StoreVerification,
    source: PurchaseSource,
    tier: PaidTier,
  ) {
    const taken = await User.exists({ _id: { $ne: userId }, 'subscription.purchaseToken': token });
    if (taken) throw conflict('This purchase is already linked to another account', 'purchase_token_in_use');
    // An upgrade or downgrade on Play arrives as a new token naming the one it replaces. If that older
    // token belongs to somebody else, this is not her upgrade to claim.
    if (v.linkedPurchaseToken) {
      const other = await User.exists({ _id: { $ne: userId }, 'subscription.purchaseToken': v.linkedPurchaseToken });
      if (other) throw conflict('This purchase replaces a subscription on another account', 'purchase_token_in_use');
    }
    if (!v.valid) {
      // A renewal the store could not take payment for fails here too, and she is not watching that one.
      // A forged or unknown token is not a payment problem and must not buzz her about one.
      const paymentProblem = v.invalidReason === undefined || v.invalidReason === 'payment';
      if (paymentProblem) d.push.notify(userId, { type: 'subscription', event: 'payment_problem' });
      throw badRequest('Purchase could not be verified', v.invalidReason ? { reason: v.invalidReason } : undefined);
    }
    const before = (await User.findById(userId).select('subscription').lean())?.subscription as { expiresAt?: Date | null } | null;
    const now = new Date();
    const ent = entitlementFromPlay(v, plan, now, source, tier);
    const u = await User.findByIdAndUpdate(
      userId,
      { $set: { subscription: { ...ent, productId, purchaseToken: token, playOrderId: v.orderId ?? null, updatedAt: now } } },
      { new: true },
    );
    if (!u) throw notFound();
    // Only now, with the entitlement stored, do we tell Google we have honoured the purchase: an
    // unacknowledged purchase is refunded after three days, which is what should happen if we got this far
    // and then lost her entitlement. A failure to acknowledge must not fail a purchase she has paid for,
    // so it is logged and Google's retry (or her next verify) tries again.
    if (source === 'google_play' && s.playBilling.acknowledge) {
      try {
        await s.playBilling.acknowledge({ productId, purchaseToken: token, kind: 'subscription' });
      } catch (e) {
        log.error('Play acknowledgement failed after the entitlement was stored', { message: e instanceof Error ? e.message : String(e) });
      }
    }
    // A first purchase is silent: she is looking at the screen that made it. A renewal she may have missed.
    const notice = subscriptionNoticeFor(before, ent);
    if (notice) d.push.notify(userId, { type: 'subscription', event: notice });
    const resolved = resolveEntitlement(ent, now);
    const previewEndsAt = await previewEndsAtForViewer(userId);
    return {
      subscription: { ...serializeUser(u, now).subscription, tier: resolved.tier, features: resolved.features, previewEndsAt },
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
