import rateLimit from 'express-rate-limit';

const base = { standardHeaders: true, legacyHeaders: false } as const;
const body = { error: { code: 'too_many_requests', message: 'Too many requests, slow down.' } };

/** Applied to every /v1/auth route (per IP). OTP-specific cooldown/lock logic is separate and per-account. */
export const authLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, limit: 30, message: body });
export const apiLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 300, message: body });

/** "Read with AI" costs money per call: 12 reads an hour per signed-in user (falls back to IP). */
export const aiReadLimiter = rateLimit({
  ...base, windowMs: 60 * 60_000, limit: 12,
  keyGenerator: (req) => ((req as { auth?: { userId?: string } }).auth?.userId) ?? 'anon',
  message: { error: { code: 'too_many_requests', message: "You've read a lot of plans this hour. Please try again a little later." } },
});
