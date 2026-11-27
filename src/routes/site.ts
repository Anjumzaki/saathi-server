import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Lead, type LeadKind } from '../models/Lead';
import { asyncHandler, parse } from '../utils/http';

const email = z.string().trim().toLowerCase().email().max(254);
const text = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

const waitlistSchema = z.object({ email, platform: z.enum(['android', 'iphone', 'both']).catch('android'), note: text(500), source: text(40) });
const proSchema = z.object({ email, name: z.string().trim().min(1).max(80), registration: text(200), source: text(40) });

/** The forms are public, so each address gets a small hourly allowance. */
const formLimiter = rateLimit({
  standardHeaders: true, legacyHeaders: false, windowMs: 60 * 60_000, limit: 10,
  message: { error: { code: 'too_many_requests', message: 'Too many requests, slow down.' } },
});

async function save(kind: LeadKind, fields: Record<string, string | null>): Promise<void> {
  const { email: address, ...rest } = fields;
  await Lead.updateOne({ kind, email: address }, { $set: rest, $setOnInsert: { kind, email: address } }, { upsert: true });
}

/** Website forms (download.html launch list, pro.html dietitian application). Public, same origin as the site. */
export function siteRoutes(): Router {
  const r = Router();
  r.use(formLimiter);

  r.post('/waitlist', asyncHandler(async (req, res) => {
    await save('waitlist', parse(waitlistSchema, req.body));
    res.status(201).json({ ok: true });
  }));

  r.post('/pro-application', asyncHandler(async (req, res) => {
    await save('pro_application', parse(proSchema, req.body));
    res.status(201).json({ ok: true });
  }));

  return r;
}
