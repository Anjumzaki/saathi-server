import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../interfaces';
import { Dataset, UserOption } from '../models/Dataset';
import { slugId } from '../services/datasetLogic';
import { DietitianProfile } from '../models/DietitianProfile';
import { LEAD_KINDS, Lead } from '../models/Lead';
import { Order } from '../models/Order';
import { FeeConfigModel, PackageConfig } from '../models/PackageConfig';
import { PLUS_FEATURES } from '../services/entitlement';
import { applyDiscount } from '../services/money';
import { mongoPurgeOps, purgeDeletedAccounts } from '../services/accountPurge';
import { invalidateConfigCaches } from '../services/adminConfigCache';
import { REVIEW_DECISIONS, adminProfileView, documentBlockMessage, pickAdminDocument, purgeTargets, reviewPatch } from '../services/adminReview';
import { getFeeConfig } from '../services/feeConfig';
import { getFileStore } from '../services/fileStore';
import { canRelease, isRefundEligible } from '../services/orderState';
import { VERIFICATION_STATUSES, canVerificationTransition, flagDocsAfterReview } from '../services/verification';
import { addRole } from '../services/users';
import { badRequest, conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';
import { log } from '../utils/logger';
import { refundOrder } from './orders';

const pricePoint = z.object({ country: z.string().min(1).max(2), currency: z.string().length(3).toUpperCase(), amountMinor: z.number().int().min(0) });
const variant = z.object({ variant: z.string().min(1).max(32), productId: z.string().min(1).max(200), prices: z.array(pricePoint).max(100) });

const packageBase = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,64}$/),
  label: z.string().min(1).max(100),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
const packageSchema = z.discriminatedUnion('kind', [
  packageBase.extend({
    kind: z.literal('dietitian_plan'),
    bandId: z.string().min(1).max(64),
    variants: z.array(variant.extend({ variant: z.enum(['full', 'premium', 'followUp']) })).min(1).max(3),
  }),
  packageBase.extend({
    kind: z.literal('premium'),
    trialDays: z.number().int().min(0).max(365).default(30),
    /**
     * What the package is and what it opens. Optional, and left alone when it is not sent, so an edit
     * that only moves a price cannot quietly demote Premium Plus or empty its feature list.
     */
    tier: z.enum(['premium', 'plus']).optional(),
    features: z.array(z.string().max(60)).max(50).optional()
      .refine((fs) => !fs || fs.every((f) => (PLUS_FEATURES as string[]).includes(f)), { message: `Unknown feature. The ones that exist: ${PLUS_FEATURES.join(', ')}` }),
    perks: z.array(z.string().min(1).max(200)).max(20).optional(),
    variants: z.array(variant.extend({ variant: z.enum(['monthly', 'yearly']) })).min(1).max(2),
  }),
]);

const feeSchema = z.object({
  playFeePercent: z.number().min(0).max(100),
  platformFeePercent: z.number().min(0).max(100),
  payoutDelayHours: z.number().int().min(0).max(24 * 30),
  refundWindowHours: z.number().int().min(0).max(24 * 30),
  premiumDiscountPercent: z.number().min(0).max(100),
  followUpDiscountPercent: z.number().min(0).max(100),
});

/** Mounted under /v1/admin behind requireAuth + requireRole('admin'). */
export function adminRoutes(s: Services): Router {
  const r = Router();

  // ----- fees -----
  r.get('/fee-config', asyncHandler(async (_req, res) => {
    res.json({ feeConfig: await getFeeConfig() });
  }));
  r.put('/fee-config', asyncHandler(async (req, res) => {
    const body = parse(feeSchema.partial().strict(), req.body);
    await FeeConfigModel.findOneAndUpdate({ key: 'default' }, { $set: body, $setOnInsert: { key: 'default' } }, { upsert: true });
    invalidateConfigCaches();
    res.json({ feeConfig: await getFeeConfig() });
  }));

  // ----- packages -----
  r.get('/packages', asyncHandler(async (_req, res) => {
    res.json({ packages: await PackageConfig.find().sort({ kind: 1, sortOrder: 1 }).lean() });
  }));
  r.post('/packages', asyncHandler(async (req, res) => {
    const body = parse(packageSchema, req.body);
    if (await PackageConfig.exists({ key: body.key })) throw conflict('Package key already exists');
    const p = await PackageConfig.create(body);
    invalidateConfigCaches();
    res.status(201).json({ package: p });
  }));
  r.put('/packages/:id', asyncHandler(async (req, res) => {
    const body = parse(packageSchema, req.body);
    const p = await PackageConfig.findByIdAndUpdate(objectId(req.params['id']), { $set: body }, { new: true });
    if (!p) throw notFound();
    invalidateConfigCaches();
    res.json({ package: p });
  }));
  r.delete('/packages/:id', asyncHandler(async (req, res) => {
    // Orders keep their own price snapshot, so deleting a package never changes history.
    const p = await PackageConfig.findByIdAndDelete(objectId(req.params['id']));
    if (!p) throw notFound();
    invalidateConfigCaches();
    res.status(204).end();
  }));
  /** Recompute premium and followUp prices of a dietitian_plan band from its `full` prices and the current discount %. */
  r.post('/packages/:id/derive-variants', asyncHandler(async (req, res) => {
    const p = await PackageConfig.findById(objectId(req.params['id']));
    if (!p || p.kind !== 'dietitian_plan') throw notFound();
    const full = p.variants.find((v) => v.variant === 'full');
    if (!full) throw conflict('Band has no full variant');
    const fees = await getFeeConfig();
    const derive = (name: 'premium' | 'followUp', pct: number) => {
      const prev = p.variants.find((v) => v.variant === name);
      return { variant: name, productId: prev?.productId ?? `${full.productId.replace(/_full$/, '')}_${name.toLowerCase()}`, prices: full.prices.map((x) => ({ country: x.country, currency: x.currency, amountMinor: applyDiscount(x.amountMinor, pct) })) };
    };
    p.set('variants', [full, derive('premium', fees.premiumDiscountPercent), derive('followUp', fees.followUpDiscountPercent)]);
    await p.save();
    invalidateConfigCaches();
    res.json({ package: p });
  }));

  // ----- dietitian verification -----
  // The queue. `status` takes one or several ("submitted,in_review"), oldest submission first: she has waited longest.
  r.get('/dietitians', asyncHandler(async (req, res) => {
    const { status } = parse(z.object({ status: z.string().max(100).optional() }), req.query);
    const wanted = (status ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const unknown = wanted.filter((x) => !(VERIFICATION_STATUSES as readonly string[]).includes(x));
    if (unknown.length) throw badRequest(`Unknown status: ${unknown.join(', ')}`);
    const profiles = await DietitianProfile.find(wanted.length ? { status: { $in: wanted } } : {}).sort({ submittedAt: 1 }).limit(200).lean();
    res.json({ profiles: profiles.map((p) => adminProfileView(p as never)) });
  }));

  /** One application in full, with the decisions this status actually allows. */
  r.get('/dietitians/:id', asyncHandler(async (req, res) => {
    const p = await DietitianProfile.findById(objectId(req.params['id'])).lean();
    if (!p) throw notFound();
    res.json({ profile: adminProfileView(p as never) });
  }));

  /**
   * A document's bytes, for the reviewer who has to look at the licence. The admin equivalent of
   * GET /v1/dietitians/me/documents/:docId/file and held to the same rule: the key must belong to the
   * scope of the account that owns the application, and it is reached by document id, never by key.
   */
  r.get('/dietitians/:id/documents/:docId/file', asyncHandler(async (req, res) => {
    const p = await DietitianProfile.findById(objectId(req.params['id'])).lean();
    if (!p) throw notFound();
    const pick = pickAdminDocument(p as never, String(req.params['docId']));
    if (!pick.ok) throw notFound(documentBlockMessage(pick.reason));
    const file = await getFileStore().get(pick.ref);
    if (!file) throw notFound('That document is no longer here');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.type(file.mime).send(file.data);
  }));
  r.post('/dietitians/:id/review', asyncHandler(async (req, res) => {
    const body = parse(z.object({ decision: z.enum(REVIEW_DECISIONS), note: z.string().max(1000).optional(), outcome: z.enum(['changes_requested', 'declined']).optional() }), req.body);
    const p = await DietitianProfile.findById(objectId(req.params['id']));
    if (!p) throw notFound();
    if (!canVerificationTransition(p.status, body.decision)) throw conflict(`Cannot move ${p.status} -> ${body.decision}`, 'invalid_transition');
    const patch = reviewPatch(body, new Date());
    p.status = patch.status;
    p.reviewNote = patch.reviewNote;
    p.reviewOutcome = patch.reviewOutcome;
    if (patch.reviewedAt) {
      p.reviewedAt = patch.reviewedAt;
      p.reviewedBy = authOf(req).userId as never;
    }
    if (patch.flagDocuments) p.set('documents', flagDocsAfterReview(p.documents.map((d) => d.toObject()), patch.reviewedAt ?? new Date()));
    await p.save();
    if (patch.grantsDietitianRole) await addRole(String(p.userId), 'dietitian');
    res.json({ profile: adminProfileView(p.toObject() as never) });
  }));
  /**
   * Deletes a document whose retention window has run out: the stored object goes first, then the
   * reference is marked purged. The bytes are deleted before the record, so a failure half way through
   * leaves a record that is tried again rather than a file nothing points at any more.
   */
  r.post('/jobs/purge-flagged-documents', asyncHandler(async (_req, res) => {
    const now = new Date();
    const profiles = await DietitianProfile.find({ 'documents.flaggedForDeletion': true });
    let purged = 0;
    let kept = 0;
    for (const p of profiles) {
      for (const target of purgeTargets(p as never, now)) {
        if (target.ref) {
          try {
            await getFileStore().remove(target.ref);
          } catch (e) {
            // Leave the record alone: the next run tries again rather than losing the only reference to it.
            kept++;
            log.error('purge failed', { documentId: target.id, message: e instanceof Error ? e.message : String(e) });
            continue;
          }
        }
        const d = p.documents.find((x) => String(x._id) === target.id);
        if (!d) continue;
        d.deletedAt = now;
        d.ref = 'purged';
        purged++;
      }
      await p.save();
    }
    res.json({ purged, kept });
  }));

  /**
   * Erases accounts whose thirty days are up. `DELETE /me` already runs these steps at the moment she
   * asks, so on a healthy server this finds nothing; it exists for the accounts deleted before that was
   * true, for a row that arrived after she left, and for a step that failed the first time.
   *
   * Every step is a filter plus an operation, so a run that dies half way is simply run again, and the
   * counts come back per collection rather than as one number: a step that keeps returning rows is the
   * signal that something is being missed.
   */
  r.post('/jobs/purge-deleted-accounts', asyncHandler(async (req, res) => {
    const { limit } = parse(z.object({ limit: z.number().int().min(1).max(1000).default(200) }).strict(), req.body ?? {});
    res.json(await purgeDeletedAccounts(mongoPurgeOps(), { limit }));
  }));

  // ----- scheduled settlement (call from Heroku Scheduler) -----
  r.post('/jobs/settle-orders', asyncHandler(async (_req, res) => {
    const now = new Date();
    const fees = await getFeeConfig();
    let refunded = 0;
    let released = 0;
    for (const o of await Order.find({ status: { $in: ['paid', 'in_progress'] } })) {
      if (isRefundEligible(o, now, fees.refundWindowHours)) {
        await refundOrder(s, o, 'auto: nothing delivered within refund window');
        refunded++;
      }
    }
    for (const o of await Order.find({ status: 'delivered' })) {
      if (canRelease(o, now, fees.payoutDelayHours, false)) {
        o.status = 'released';
        o.releasedAt = now;
        await o.save();
        released++;
      }
    }
    res.json({ refunded, released });
  }));

  // ---- datasets (onboarding / settings questions) ----
  const optionBody = z.object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/),
    label: z.string().min(1).max(60), icon: z.string().max(30).optional(),
    tags: z.array(z.string().max(30)).max(10).default([]), regions: z.array(z.string().length(2).toUpperCase()).max(50).default([]),
    source: z.enum(['seed', 'user', 'dietitian', 'promoted']).default('seed'), order: z.number().int().default(0), active: z.boolean().default(true),
  });
  const datasetBody = z.object({
    question: z.string().min(1).max(200),
    allowCustom: z.boolean(), minPick: z.number().int().min(0).max(10), active: z.boolean().default(true),
    showIf: z.record(z.array(z.string())).nullable().default(null), options: z.array(optionBody).max(200),
  });

  r.get('/datasets', asyncHandler(async (_req, res) => {
    res.json({ datasets: await Dataset.find().sort({ order: 1 }).lean() });
  }));

  r.put('/datasets/:key', asyncHandler(async (req, res) => {
    const body = parse(datasetBody, req.body);
    if (new Set(body.options.map((o) => o.id)).size !== body.options.length) throw conflict('Option ids must be unique');
    const d = await Dataset.findOneAndUpdate({ key: String(req.params['key']) }, { $set: body, $inc: { version: 1 } }, { new: true });
    if (!d) throw notFound();
    res.json({ dataset: d });
  }));

  // Custom entries typed by users, grouped, most common first. `min` = distinct users who typed the same thing.
  r.get('/datasets/:key/custom', asyncHandler(async (req, res) => {
    const { min } = parse(z.object({ min: z.coerce.number().int().min(1).default(5) }), req.query);
    const rows = await UserOption.aggregate([
      { $match: { datasetKey: String(req.params['key']) } },
      { $group: { _id: '$labelKey', label: { $first: '$label' }, users: { $sum: 1 } } },
      { $match: { users: { $gte: min } } },
      { $sort: { users: -1 } }, { $limit: 200 },
    ]);
    res.json({ custom: rows.map((x) => ({ labelKey: x._id, label: x.label, users: x.users })) });
  }));

  // Promote a popular custom entry into the shared list (appended, source 'promoted'; clients get it on next fetch).
  r.post('/datasets/:key/promote', asyncHandler(async (req, res) => {
    const key = String(req.params['key']);
    const body = parse(z.object({ label: z.string().min(1).max(60), tags: z.array(z.string().max(30)).default([]) }), req.body);
    const d = await Dataset.findOne({ key });
    if (!d) throw notFound();
    const id = `p_${slugId(body.label)}`;
    if (d.options.some((o) => o.id === id || o.label.toLowerCase() === body.label.toLowerCase())) throw conflict('Already in the list');
    d.options.push({ id, label: body.label, tags: body.tags, regions: [], source: 'promoted', order: d.options.length, active: true } as never);
    d.version += 1;
    await d.save();
    // Existing users who typed this label keep working: map their user option id to the promoted id is a client concern
    // (the label now matches a seed option, so the add-option endpoint resolves to it).
    res.status(201).json({ option: { id, label: body.label } });
  }));

  /** Website forms: the launch list and Saathi Pro applications, newest first. */
  r.get('/leads', asyncHandler(async (req, res) => {
    const q = parse(z.object({ kind: z.enum(LEAD_KINDS).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    const leads = await Lead.find(q.kind ? { kind: q.kind } : {}).sort({ createdAt: -1 }).limit(q.limit).lean();
    res.json({ leads });
  }));

  return r;
}
