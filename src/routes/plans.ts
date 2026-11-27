import { Router } from 'express';
import { z } from 'zod';
import { getEnv } from '../config/env';
import type { Services } from '../interfaces';
import { requirePremium } from '../middleware/auth';
import { aiReadLimiter } from '../middleware/rateLimit';
import { Plan } from '../models/Plan';
import { RegionPack } from '../models/RegionPack';
import { planContentSchema, planItemSchema, planProfileSchema } from '../schemas/plan';
import { aiNotConfigured, createPlanGenerator, type AiPlanGenerator } from '../services/anthropicPlanGenerator';
import { DEFAULT_PROTEIN_KEYWORDS, checkPlan } from '../services/planCheck';
import { nextVersion, type StoredVersion } from '../services/planVersioning';
import { badRequest, notFound } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';

/** Largest document accepted (decoded). A phone photo is usually 1 to 4 MB; a plan PDF a few hundred KB. */
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const fileSchema = z.object({
  mediaType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(1).max(Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/=\s]+$/, 'not base64'),
});
const importSchema = z
  .object({ text: z.string().min(1).max(50_000).optional(), fileRef: z.string().min(1).max(500).optional(), file: fileSchema.optional(), locale: z.string().max(20).optional() })
  .refine((v) => [v.text, v.fileRef, v.file].filter((x) => !!x).length === 1, { message: 'Provide exactly one of text, file or fileRef' });

/** "Let Saathi write it": her answers, sent by the app. Her tier is read from the database, never from this body. */
const generateSchema = z.object({
  profile: planProfileSchema,
  /** Anything she wants to add in her own words. */
  note: z.string().max(1000).optional(),
  locale: z.string().max(20).optional(),
});

const checkSchema = z.object({
  items: z.array(planItemSchema.partial({ key: true, daysOfWeek: true, tier: true, options: true })).max(200),
  waterTargetMl: z.number().int().min(0).max(20_000).nullable().optional(),
  country: z.string().length(2).optional(),
  proteinKeywords: z.array(z.string().min(1).max(40)).max(200).optional(),
  day: z.number().int().min(0).max(6).optional(),
});

const createSchema = planContentSchema.extend({
  title: z.string().min(1).max(200),
  source: z.enum(['own', 'ai_import']).default('own'),
  note: z.string().max(1000).optional(),
});

export function planRoutes(s: Services): Router {
  const r = Router();

  /** Premium only. ALWAYS returns a draft for the review screen; this route never persists a plan. */
  r.post('/import-ai', requirePremium, aiReadLimiter, asyncHandler(async (req, res) => {
    const input = parse(importSchema, req.body);
    const draft = await s.aiPlanReader.read(input);
    res.json({ draft, saved: false, requiresReview: true });
  }));

  /**
   * Premium only. Writes a week's plan from her answers and returns a draft for the review screen; never persists.
   * As expensive as the reader, so it shares the reader's hourly limit.
   */
  r.post('/generate-ai', requirePremium, aiReadLimiter, asyncHandler(async (req, res) => {
    const b = parse(generateSchema, req.body);
    // Until `Services` carries the generator, it is resolved here; a stub can be passed in for tests.
    const generator = (s as { aiPlanGenerator?: AiPlanGenerator }).aiPlanGenerator ?? createPlanGenerator(getEnv());
    if (!generator) throw aiNotConfigured();
    const { draft, check } = await generator.generate(b);
    res.json({ draft, check, saved: false, requiresReview: true });
  }));

  /** Structural check (pure functions). Open to everyone. */
  r.post('/check', asyncHandler(async (req, res) => {
    const b = parse(checkSchema, req.body);
    let keywords = b.proteinKeywords;
    if (!keywords && b.country) {
      const region = await RegionPack.findOne({ country: b.country.toUpperCase() }).lean();
      if (region?.proteinKeywords.length) keywords = [...new Set([...DEFAULT_PROTEIN_KEYWORDS, ...region.proteinKeywords])];
    }
    res.json(checkPlan(b.items, { proteinKeywords: keywords ?? DEFAULT_PROTEIN_KEYWORDS, waterTargetMl: b.waterTargetMl, day: b.day }));
  }));

  r.post('/', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const b = parse(createSchema, req.body);
    const v = nextVersion(null, b);
    const plan = await Plan.create({
      userId,
      title: b.title,
      currentVersion: 1,
      versions: [{ ...v, createdBy: userId, source: b.source, note: b.note }],
    });
    res.status(201).json({ plan });
  }));

  r.get('/', asyncHandler(async (req, res) => {
    const plans = await Plan.find({ userId: authOf(req).userId }).select('-versions').sort({ updatedAt: -1 }).lean();
    res.json({ plans });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const plan = await Plan.findOne({ _id: objectId(req.params['id']), userId: authOf(req).userId }).lean();
    if (!plan) throw notFound();
    res.json({ plan });
  }));

  r.post('/:id/versions', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const b = parse(planContentSchema.extend({ note: z.string().max(1000).optional(), source: z.enum(['own', 'ai_import']).default('own') }), req.body);
    const plan = await Plan.findOne({ _id: objectId(req.params['id']), userId });
    if (!plan) throw notFound();
    const prev = plan.versions[plan.versions.length - 1];
    if (!prev) throw badRequest('Plan has no versions');
    const v = nextVersion(prev as unknown as StoredVersion, b);
    plan.versions.push({ ...v, createdBy: userId, source: b.source, note: b.note } as never);
    plan.currentVersion = v.number;
    await plan.save();
    res.status(201).json({ version: v.number, diff: v.diff });
  }));

  return r;
}
