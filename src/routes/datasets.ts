import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { Dataset, UserOption } from '../models/Dataset';
import { MAX_CUSTOM_PER_DATASET, labelKey, optionsFor, shortId, validateCustomLabel } from '../services/datasetLogic';
import { requireAuth } from '../middleware/auth';
import { verifyAccessToken } from '../services/tokens';
import { badRequest, conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, parse } from '../utils/http';

/** Attach req.auth when a valid token is present; anonymous callers (onboarding before sign-in) are allowed. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      req.auth = verifyAccessToken(h.slice(7));
    } catch {
      /* treat a bad token as anonymous */
    }
  }
  next();
}

export function datasetRoutes(): Router {
  const r = Router();

  // Public read. Region-filtered; the caller's own custom options are merged when signed in.
  r.get('/', optionalAuth, asyncHandler(async (req, res) => {
    const q = parse(z.object({ country: z.string().length(2).optional(), since: z.coerce.date().optional() }), req.query);
    const serverTime = new Date();
    const filter: Record<string, unknown> = { active: true };
    if (q.since) filter['updatedAt'] = { $gt: q.since };
    const rows = await Dataset.find(filter).sort({ order: 1, key: 1 }).lean();
    const mine = req.auth
      ? await UserOption.find({ userId: req.auth.userId, datasetKey: { $in: rows.map((d) => d.key) } }).lean()
      : [];
    const datasets = rows.map((d) => {
      const opts = optionsFor(d as never, q.country).map((o) => ({ ...o }));
      const own = mine.filter((m) => m.datasetKey === d.key).map((m) => ({ id: m.optionId, label: m.label, source: 'user' as const, order: 10_000 }));
      return {
        key: d.key, question: d.question, selection: d.selection, allowCustom: d.allowCustom,
        minPick: d.minPick, showIf: d.showIf ?? undefined, version: d.version, options: [...opts, ...own],
      };
    });
    res.json({ datasets, serverTime: serverTime.toISOString() });
  }));

  // Add the signed-in user's own option. Idempotent by case-insensitive label.
  r.post('/:key/options', optionalAuth, asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const key = String(req.params['key']);
    const { label: raw } = parse(z.object({ label: z.string() }), req.body);
    const v = validateCustomLabel(raw);
    if (!v.ok) throw badRequest(v.reason);
    const d = await Dataset.findOne({ key, active: true }).lean();
    if (!d) throw notFound();
    if (!d.allowCustom) throw badRequest('This question does not accept custom options');

    const lk = labelKey(v.label);
    const seedMatch = d.options.find((o) => o.active !== false && o.label.toLocaleLowerCase() === lk);
    if (seedMatch) return void res.json({ option: { id: seedMatch.id, label: seedMatch.label, source: seedMatch.source } });

    const existing = await UserOption.findOne({ userId, datasetKey: key, labelKey: lk }).lean();
    if (existing) return void res.json({ option: { id: existing.optionId, label: existing.label, source: 'user' } });

    if ((await UserOption.countDocuments({ userId, datasetKey: key })) >= MAX_CUSTOM_PER_DATASET) {
      throw conflict(`You can add up to ${MAX_CUSTOM_PER_DATASET} of your own options here`);
    }
    const doc = await UserOption.create({ userId, datasetKey: key, optionId: `u_${shortId()}`, label: v.label, labelKey: lk });
    res.status(201).json({ option: { id: doc.optionId, label: doc.label, source: 'user' } });
  }));

  // Rename one of the signed-in user's own options.
  r.patch('/:key/options/:optionId', requireAuth, asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const key = String(req.params['key']);
    const optionId = String(req.params['optionId']);
    const { label: raw } = parse(z.object({ label: z.string() }), req.body);
    const v = validateCustomLabel(raw);
    if (!v.ok) throw badRequest(v.reason);
    const doc = await UserOption.findOne({ userId, datasetKey: key, optionId });
    if (!doc) throw notFound();
    const lk = labelKey(v.label);
    const d = await Dataset.findOne({ key, active: true }).lean();
    if (d?.options.some((o) => o.active !== false && o.label.toLocaleLowerCase() === lk)) throw conflict('That is already in the list.');
    if (await UserOption.exists({ userId, datasetKey: key, labelKey: lk, optionId: { $ne: optionId } })) throw conflict('You already added that.');
    doc.label = v.label;
    doc.labelKey = lk;
    await doc.save();
    res.json({ option: { id: doc.optionId, label: doc.label, source: 'user' } });
  }));

  // Delete one of the signed-in user's own options.
  r.delete('/:key/options/:optionId', requireAuth, asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    await UserOption.deleteOne({ userId, datasetKey: String(req.params['key']), optionId: String(req.params['optionId']) });
    res.status(204).end();
  }));

  return r;
}
