import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { User } from '../models/User';
import { hasFeature, tierNeededFor, tierOf, type Entitlement, type Feature } from '../services/entitlement';
import { isPremiumActive } from '../services/entitlement';
import { verifyAccessToken } from '../services/tokens';
import { forbidden, paymentRequired, unauthorized } from '../utils/errors';

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(unauthorized());
  try {
    req.auth = verifyAccessToken(h.slice(7));
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole =
  (...roles: string[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    if (!roles.some((r) => req.auth!.roles.includes(r))) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };

/** Premium gate: reads the entitlement from the database so expiry takes effect immediately. */
export async function requirePremium(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw unauthorized();
    const u = await User.findById(req.auth.userId).select('subscription deletedAt').lean();
    if (!u || u.deletedAt) throw unauthorized();
    if (!isPremiumActive(u.subscription as never, new Date())) throw paymentRequired();
    next();
  } catch (e) {
    next(e);
  }
}

/** Reads the live subscription, so an expiry or an upgrade takes effect on the next request. */
type SubLoader = (userId: string) => Promise<Entitlement | null>;

const loadSubscription: SubLoader = async (userId) => {
  const u = await User.findById(userId).select('subscription deletedAt').lean();
  if (!u || u.deletedAt) throw unauthorized();
  return (u.subscription ?? null) as Entitlement | null;
};

/** Exported for tests, which have no database: the gate with its lookup swapped out. */
export function makeRequireFeature(load: SubLoader) {
  return (feature: Feature): RequestHandler =>
    (req, _res, next) => {
      void (async () => {
        try {
          if (!req.auth) throw unauthorized();
          const sub = await load(req.auth.userId);
          const now = new Date();
          if (hasFeature(sub, feature, now)) return next();
          // Tell her why: a trial that does not include this, or a tier she is not on yet.
          const needed = tierNeededFor(feature);
          const onTier = tierOf(sub, now);
          if (onTier !== 'free' && needed && (onTier === needed || onTier === 'plus')) {
            throw paymentRequired('This one starts after your first payment');
          }
          throw paymentRequired(needed === 'plus' ? 'Premium Plus required' : 'Premium subscription required');
        } catch (e) {
          next(e);
        }
      })();
    };
}

/**
 * Feature gate: the single place a paid feature is checked. Use this rather than requirePremium, so the
 * tier and the trial exclusion are applied in one place.
 */
export const requireFeature = makeRequireFeature(loadSubscription);
