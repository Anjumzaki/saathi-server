import type { NextFunction, Request, Response } from 'express';
import { User } from '../models/User';
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
