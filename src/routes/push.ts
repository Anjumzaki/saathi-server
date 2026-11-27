/**
 * Where a phone says "buzz me here" and "stop buzzing me here". Both are idempotent: the app re-registers
 * on every launch and on every token refresh, and signing out unregisters, so a phone she has given away
 * stops hearing from us.
 */
import { Router } from 'express';
import { z } from 'zod';
import { PUSH_PLATFORMS } from '../models/DeviceToken';
import { livePush, type PushService } from '../services/push';
import { asyncHandler, authOf, parse } from '../utils/http';

const registerBody = z.object({
  /** An FCM registration token. Long, opaque, and not a secret of hers. */
  token: z.string().trim().min(10).max(4096),
  platform: z.enum(PUSH_PLATFORMS),
  appVersion: z.string().trim().max(32).default(''),
});

const unregisterBody = z.object({ token: z.string().trim().min(10).max(4096) });

export function pushRoutes(overrides: { push?: PushService } = {}): Router {
  const push = overrides.push ?? livePush();
  const r = Router();

  r.post('/register', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const b = parse(registerBody, req.body);
    await push.register({ userId, token: b.token, platform: b.platform, appVersion: b.appVersion });
    // `configured` lets the app stop asking for a permission that would buy her nothing.
    res.json({ ok: true, push: push.configured });
  }));

  r.post('/unregister', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const b = parse(unregisterBody, req.body);
    await push.unregister(userId, b.token);
    res.status(204).end();
  }));

  return r;
}
