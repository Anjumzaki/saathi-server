import { Types } from 'mongoose';
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth';
import { DietitianProfile } from '../models/DietitianProfile';
import { DOC_KINDS, canVerificationTransition, readyToSubmit } from '../services/verification';
import { conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';
import { Order } from '../models/Order';

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  bio: z.string().max(2000).optional(),
  credentials: z.string().max(500).optional(),
  specialties: z.array(z.string().max(60)).max(20).default([]),
  languages: z.array(z.string().max(30)).max(10).default([]),
  countries: z.array(z.string().length(2).toUpperCase()).max(50).default([]),
  photoRef: z.string().max(500).optional(),
  payoutAccountRef: z.string().max(500).optional(),
});

const PUBLIC_FIELDS = 'userId displayName bio credentials specialties languages countries photoRef';

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
    const p = await DietitianProfile.findOne({ userId: authOf(req).userId }).lean();
    if (!p) throw notFound('No dietitian profile');
    res.json({ profile: p });
  }));

  // Any signed-in user may apply; the dietitian role is granted on approval.
  r.put('/me', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const body = parse(profileSchema, req.body);
    const existing = await DietitianProfile.findOne({ userId });
    if (existing && !['draft', 'rejected'].includes(existing.status)) throw conflict('Profile can only be edited while draft or after rejection');
    const p = await DietitianProfile.findOneAndUpdate({ userId }, { $set: body, $setOnInsert: { userId, status: 'draft' } }, { upsert: true, new: true });
    res.json({ profile: p });
  }));

  /** Documents are REFERENCES only (object-storage keys). Government ID is flagged for deletion after review. */
  r.post('/me/documents', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const body = parse(z.object({ kind: z.enum(DOC_KINDS), ref: z.string().min(1).max(500) }), req.body);
    const p = await DietitianProfile.findOne({ userId });
    if (!p) throw notFound('Create your profile first');
    if (!['draft', 'rejected'].includes(p.status)) throw conflict('Documents can only be added while draft or after rejection');
    p.documents.push(body as never);
    await p.save();
    res.status(201).json({ profile: p });
  }));

  r.post('/me/submit', asyncHandler(async (req, res) => {
    const p = await DietitianProfile.findOne({ userId: authOf(req).userId });
    if (!p) throw notFound('Create your profile first');
    if (!canVerificationTransition(p.status, 'submitted')) throw conflict(`Cannot submit from status ${p.status}`);
    if (!readyToSubmit(p.documents)) throw conflict('Add a government ID and a license or certificate reference first', 'documents_missing');
    p.status = 'submitted';
    p.submittedAt = new Date();
    await p.save();
    res.json({ profile: p });
  }));

  r.get('/me/earnings', requireRole('dietitian'), asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const rows = await Order.aggregate([
      { $match: { dietitianId: new Types.ObjectId(userId), status: { $in: ['delivered', 'released'] } } },
      { $group: { _id: { currency: '$currency', status: '$status' }, total: { $sum: '$settlement.dietitian' }, orders: { $sum: 1 } } },
    ]);
    res.json({ earnings: rows.map((x) => ({ currency: x._id.currency, status: x._id.status, totalMinor: x.total, orders: x.orders })) });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const p = await DietitianProfile.findOne({ userId: objectId(req.params['id']), status: 'approved' }).select(PUBLIC_FIELDS).lean();
    if (!p) throw notFound();
    res.json({ dietitian: p });
  }));

  return r;
}
