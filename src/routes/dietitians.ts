import { Types } from 'mongoose';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth';
import { DietitianProfile } from '../models/DietitianProfile';
import { Order } from '../models/Order';
import { PackageConfig } from '../models/PackageConfig';
import { User } from '../models/User';
import { clientOrderView, dueLine } from '../services/dietitianClients';
import { PAYOUT_NOTE, summariseEarnings, type EarningRow } from '../services/dietitianEarnings';
import {
  canAddDocument, documentProblemMessage, documentView, liveDocuments, profileCompleteness,
  proProfileSchema, reviewBody, reviewHeadline, reviewStateOf, submitBlock, submitBlockMessage,
  tidyProfile, unknownBands,
} from '../services/dietitianProfile';
import { reviewPlanForPublish } from '../services/dietitianPublish';
import { getFileStore, getFileStoreConfig, checkUpload, dietitianScope, keyBelongsTo, normaliseMime, uploadProblemMessage } from '../services/fileStore';
import { getFeeConfig } from '../services/feeConfig';
import { DOC_KINDS } from '../services/verification';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';

const PUBLIC_FIELDS = 'userId displayName bio credentials specialties languages countries cities yearsOfPractice photoRef';

type ProfileDoc = InstanceType<typeof DietitianProfile>;

/** Her own application, or 404. Everything under /me is scoped to the signed-in account and nothing else. */
async function myProfile(req: Request): Promise<ProfileDoc> {
  const p = await DietitianProfile.findOne({ userId: authOf(req).userId });
  if (!p) throw notFound('No dietitian profile');
  return p;
}

/**
 * Gate for the working side of Pro (clients, plans). It reads the approval from this service's own
 * record rather than the access token, so a dietitian approved five minutes ago is not told to wait
 * for her token to refresh.
 */
async function myApprovedProfile(req: Request): Promise<ProfileDoc> {
  const p = await myProfile(req);
  if (p.status !== 'approved') throw forbidden('Your application has not been approved yet');
  return p;
}

/** Everything the app needs to draw her application in one response. */
function profilePayload(p: ProfileDoc) {
  const review = reviewStateOf(p);
  return {
    profile: p,
    review: { ...review, headline: reviewHeadline(review), body: reviewBody(review) },
    completeness: profileCompleteness(p),
    documents: p.documents.map((d) => documentView(d.toObject() as never)),
  };
}

const uploadSchema = z.union([
  // A key stored elsewhere (the S3 pre-signed path): the bytes never come through this service.
  z.object({ kind: z.enum(DOC_KINDS), ref: z.string().min(1).max(500), replaces: z.string().max(64).optional() }),
  // The bytes themselves, which this service stores through the FileStore.
  z.object({ kind: z.enum(DOC_KINDS), mime: z.string().min(3).max(100), dataBase64: z.string().min(16), replaces: z.string().max(64).optional() }),
]);

/** Applicant-facing routes (/v1/dietitians). */
export function dietitianRoutes(): Router {
  const r = Router();

  // public directory: approved only, no documents, no review notes
  r.get('/', asyncHandler(async (req, res) => {
    const q = parse(z.object({ country: z.string().length(2).toUpperCase().optional(), specialty: z.string().max(60).optional() }), req.query);
    const filter: Record<string, unknown> = { status: 'approved' };
    if (q.country) filter['countries'] = q.country;
    if (q.specialty) filter['specialties'] = q.specialty;
    res.json({ dietitians: await DietitianProfile.find(filter).select(PUBLIC_FIELDS).lean() });
  }));

  r.get('/me', asyncHandler(async (req, res) => {
    res.json(profilePayload(await myProfile(req)));
  }));

  // Any signed-in user may apply; the dietitian role is granted on approval.
  r.put('/me', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const body = tidyProfile(parse(proProfileSchema, req.body));
    const existing = await DietitianProfile.findOne({ userId });
    if (existing && !reviewStateOf(existing).canEdit) throw conflict('Profile can only be edited while draft or after a review asked for changes');
    if (body.bandIds.length) {
      const active = await PackageConfig.find({ kind: 'dietitian_plan', active: true }).select('bandId').lean();
      const unknown = unknownBands(body.bandIds, active.map((x) => String(x.bandId)));
      if (unknown.length) throw badRequest(`Saathi does not offer these prices: ${unknown.join(', ')}`, { code: 'unknown_band' });
    }
    const p = await DietitianProfile.findOneAndUpdate(
      { userId },
      { $set: body, $setOnInsert: { userId, status: 'draft' } },
      { upsert: true, new: true },
    );
    res.json(profilePayload(p!));
  }));

  /** The price bands she may choose from, with what a client in each country would pay. */
  r.get('/me/bands', asyncHandler(async (_req, res) => {
    const bands = await PackageConfig.find({ kind: 'dietitian_plan', active: true }).sort({ sortOrder: 1 }).lean();
    res.json({
      bands: bands.map((b) => {
        const full = b.variants.find((v) => v.variant === 'full');
        return {
          bandId: b.bandId, key: b.key, label: b.label,
          prices: (full?.prices ?? []).map((x) => ({ country: x.country, currency: x.currency, amountMinor: x.amountMinor })),
        };
      }),
    });
  }));

  /**
   * A licence or an ID. Either the bytes (stored through the FileStore) or a key stored elsewhere.
   * Government IDs are flagged for deletion after review by the reviewer's own route.
   */
  r.post('/me/documents', asyncHandler(async (req, res) => {
    const body = parse(uploadSchema, req.body);
    const p = await myProfile(req);
    if (!reviewStateOf(p).canEdit) throw conflict('Documents can only be added while draft or after a review asked for changes');

    const replaced = body.replaces ? p.documents.find((d) => String(d._id) === body.replaces) : undefined;
    if (body.replaces && !replaced) throw notFound(documentProblemMessage('not_found'));
    if (replaced?.deletedAt) throw conflict(documentProblemMessage('already_deleted'));
    const problem = canAddDocument(p.documents, !!replaced);
    if (problem) throw conflict(documentProblemMessage(problem), 'too_many_documents');

    let entry: { kind: typeof body.kind; ref: string; mime?: string; bytes?: number; storedBy?: string };
    if ('dataBase64' in body) {
      const cfg = getFileStoreConfig();
      const data = Buffer.from(body.dataBase64, 'base64');
      const bad = checkUpload({ mime: body.mime, bytes: data.byteLength }, cfg);
      if (bad) throw badRequest(uploadProblemMessage(bad, cfg), { code: `document_${bad}` });
      const stored = await getFileStore().put({ scope: dietitianScope(String(p.userId)), mime: normaliseMime(body.mime), data });
      entry = { kind: body.kind, ref: stored.key, mime: stored.mime, bytes: stored.bytes, storedBy: stored.driver };
    } else {
      entry = { kind: body.kind, ref: body.ref };
    }

    if (replaced) {
      // The old bytes go now: a replaced licence has no reason to stay on disk.
      const oldRef = replaced.ref;
      const oldDriver = replaced.storedBy;
      p.documents.pull({ _id: replaced._id });
      if (oldDriver && keyBelongsTo(oldRef, dietitianScope(String(p.userId)))) {
        await getFileStore().remove(oldRef).catch(() => undefined);
      }
    }
    p.documents.push(entry as never);
    await p.save();
    res.status(201).json(profilePayload(p));
  }));

  /** The bytes back, for her own preview. Only ever her own: the key must sit under her own scope. */
  r.get('/me/documents/:docId/file', asyncHandler(async (req, res) => {
    const p = await myProfile(req);
    const d = p.documents.find((x) => String(x._id) === String(req.params['docId']));
    if (!d || d.deletedAt) throw notFound('That document is no longer here');
    if (!d.storedBy || !keyBelongsTo(d.ref, dietitianScope(String(p.userId)))) throw notFound('That document is not stored here');
    const file = await getFileStore().get(d.ref);
    if (!file) throw notFound('That document is no longer here');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.type(file.mime).send(file.data);
  }));

  r.delete('/me/documents/:docId', asyncHandler(async (req, res) => {
    const p = await myProfile(req);
    if (!reviewStateOf(p).canEdit) throw conflict('Documents cannot be changed while the application is with the reviewer');
    const d = p.documents.find((x) => String(x._id) === String(req.params['docId']));
    if (!d) throw notFound(documentProblemMessage('not_found'));
    const { ref, storedBy } = d;
    p.documents.pull({ _id: d._id });
    await p.save();
    if (storedBy && keyBelongsTo(ref, dietitianScope(String(p.userId)))) await getFileStore().remove(ref).catch(() => undefined);
    res.json(profilePayload(p));
  }));

  r.post('/me/submit', asyncHandler(async (req, res) => {
    const p = await myProfile(req);
    const block = submitBlock({ ...(p.toObject() as never), status: p.status, documents: p.documents });
    if (block) throw conflict(submitBlockMessage(block), block === 'wrong_status' ? 'invalid_transition' : block);
    p.status = 'submitted';
    p.submittedAt = new Date();
    // A new submission is not carrying the last review's answer.
    p.reviewNote = undefined;
    p.reviewOutcome = null;
    await p.save();
    res.json(profilePayload(p));
  }));

  /** Her clients: every order assigned to her, what she owes each one and by when. */
  r.get('/me/clients', asyncHandler(async (req, res) => {
    const p = await myApprovedProfile(req);
    const [orders, fees] = await Promise.all([
      Order.find({ dietitianId: p.userId }).select('-purchaseToken').sort({ createdAt: -1 }).limit(200).lean(),
      getFeeConfig(),
    ]);
    const [clients, pkgs] = await Promise.all([
      User.find({ _id: { $in: [...new Set(orders.map((o) => String(o.clientId)))] } }).select('displayName country').lean(),
      PackageConfig.find({ key: { $in: [...new Set(orders.map((o) => o.packageKey))] } }).select('key label').lean(),
    ]);
    const names = new Map(clients.map((c) => [String(c._id), c.displayName ?? null]));
    const labels = new Map(pkgs.map((x) => [x.key, x.label]));
    const now = new Date();
    res.json({
      clients: orders.map((o) => {
        const view = clientOrderView(o, now, fees.refundWindowHours);
        return {
          orderId: String(o._id),
          clientName: names.get(String(o.clientId)) ?? null,
          packageLabel: labels.get(o.packageKey) ?? o.packageKey,
          status: o.status,
          currency: o.currency,
          pricePaid: o.pricePaid,
          settlement: o.settlement ?? null,
          planId: o.planId ? String(o.planId) : null,
          paidAt: o.paidAt ?? null,
          startedAt: o.startedAt ?? null,
          deliveredAt: o.deliveredAt ?? null,
          ...view,
          dueText: dueLine(view.dueAt, now),
        };
      }),
    });
  }));

  /**
   * Check a plan before it is sent. The app calls this from the confirm step, so she sees the same
   * verdict the publish itself applies rather than finding out afterwards.
   */
  r.post('/me/plan-review', asyncHandler(async (req, res) => {
    await myApprovedProfile(req);
    const { plan, waterTargetMl, acknowledgedTweakIds } = parse(
      z.object({ plan: z.unknown(), waterTargetMl: z.number().int().min(0).max(10_000).nullish(), acknowledgedTweakIds: z.array(z.string().max(120)).max(100).default([]) }),
      req.body,
    );
    res.json({ review: reviewPlanForPublish(plan, { waterTargetMl: waterTargetMl ?? null, acknowledgedTweakIds }) });
  }));

  r.get('/me/earnings', requireRole('dietitian'), asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const [orders, fees] = await Promise.all([
      Order.find({ dietitianId: new Types.ObjectId(userId) }).select('status currency pricePaid settlement deliveredAt releasedAt').lean(),
      getFeeConfig(),
    ]);
    const summary = summariseEarnings(orders as unknown as EarningRow[], fees);
    res.json({
      ...summary,
      payoutNote: PAYOUT_NOTE,
      feePercent: { store: fees.playFeePercent, saathi: fees.platformFeePercent },
      holdHours: fees.payoutDelayHours,
      // Kept for anything already reading the old shape: her share per currency and state.
      earnings: summary.currencies.flatMap((c) => [
        { currency: c.currency, status: 'delivered', totalMinor: c.heldMinor, orders: c.orders },
        { currency: c.currency, status: 'released', totalMinor: c.clearedMinor, orders: c.orders },
      ]),
    });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const p = await DietitianProfile.findOne({ userId: objectId(req.params['id']), status: 'approved' }).select(PUBLIC_FIELDS).lean();
    if (!p) throw notFound();
    res.json({ dietitian: p });
  }));

  return r;
}

/** Exported so a future route can list only what she is allowed to see. */
export const visibleDocumentsOf = (p: ProfileDoc) => liveDocuments(p.documents.map((d) => d.toObject() as never));
