import { Router } from 'express';
import { z } from 'zod';
import { getEnv } from '../config/env';
import { Cheer, PartnerShare } from '../models/PartnerShare';
import { SyncRecord } from '../models/SyncRecord';
import { User } from '../models/User';
import { INVITE_TTL_MS, canCheer, inviteExpiry, isInviteValid } from '../services/partnerLogic';
import { serializePartnerView, type PartnerSnapshot } from '../services/serializers';
import { addRole } from '../services/users';
import { randomToken, sha256 } from '../utils/crypto';
import { conflict, notFound } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';
import { utcDayKey } from '../utils/time';

const permsSchema = z.object({
  effortRing: z.boolean().default(false),
  mealsLogged: z.boolean().default(false),
  waterWalk: z.boolean().default(false),
  weight: z.boolean().default(false),
  togetherNudgesOnly: z.boolean().default(false),
});

/**
 * Snapshot conventions (documented in README): the phone syncs
 *  - metrics {type:'effort', date, ring, streak}, metrics {type:'weight', date, kg}
 *  - logs {kind:'meal'|'water', date, amountMl?}, stepDays {date, steps}
 *  - settings record clientId "together_nudges" {items: string[]}
 * `cycleRecords` is NEVER read here.
 */
async function buildSnapshot(ownerId: string, date: string): Promise<PartnerSnapshot> {
  const recs = await SyncRecord.find({ userId: ownerId, deleted: false, coll: { $in: ['metrics', 'logs', 'stepDays', 'settings'] } }).sort({ updatedAt: -1 }).limit(1000).lean();
  const snap: PartnerSnapshot = { date, mealsLoggedToday: false, waterMl: 0 };
  let sawWater = false;
  for (const rec of recs) {
    const p = rec.payload as Record<string, unknown>;
    if (rec.coll === 'metrics' && p['type'] === 'effort' && p['date'] === date && snap.effortRing === undefined) {
      snap.effortRing = Number(p['ring']);
      snap.streak = Number(p['streak']);
    } else if (rec.coll === 'metrics' && p['type'] === 'weight' && snap.weightKg === undefined) {
      snap.weightKg = Number(p['kg']);
    } else if (rec.coll === 'logs' && p['date'] === date) {
      if (p['kind'] === 'meal') snap.mealsLoggedToday = true;
      if (p['kind'] === 'water') {
        sawWater = true;
        snap.waterMl = (snap.waterMl ?? 0) + (Number(p['amountMl']) || 0);
      }
    } else if (rec.coll === 'stepDays' && p['date'] === date) {
      snap.steps = Number(p['steps']);
    } else if (rec.coll === 'settings' && rec.clientId === 'together_nudges' && Array.isArray(p['items'])) {
      snap.togetherNudges = (p['items'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20);
    }
  }
  if (!sawWater) snap.waterMl = null;
  return snap;
}

const ownerView = (s: InstanceType<typeof PartnerShare>) => ({
  id: String(s._id), status: s.status, partnerId: s.partnerId ? String(s.partnerId) : null,
  permissions: s.permissions, inviteExpiresAt: s.inviteExpiresAt ?? null, lastCheerAt: s.lastCheerAt ?? null,
});

export function partnerRoutes(): Router {
  const r = Router();

  r.post('/invites', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const permissions = parse(permsSchema, req.body?.permissions ?? {});
    const token = randomToken(24);
    const share = await PartnerShare.create({ ownerId: userId, inviteTokenHash: sha256(token), inviteExpiresAt: inviteExpiry(new Date()), permissions });
    res.status(201).json({
      share: ownerView(share),
      inviteToken: token, // shown once; only its hash is stored
      inviteLink: `${getEnv().APP_LINK_BASE}/partner/join?token=${token}`,
      expiresInHours: INVITE_TTL_MS / 3_600_000,
    });
  }));

  r.post('/invites/accept', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const share = await PartnerShare.findOne({ inviteTokenHash: sha256(token) });
    if (!share || share.status !== 'pending' || !share.inviteExpiresAt || !isInviteValid(share.inviteExpiresAt, new Date())) {
      throw notFound('Invite is invalid or expired');
    }
    if (String(share.ownerId) === userId) throw conflict('You cannot accept your own invite');
    share.partnerId = (await User.findById(userId).select('_id'))?._id ?? null;
    share.status = 'active';
    share.set('inviteTokenHash', undefined); // single use
    await share.save();
    await addRole(userId, 'partner');
    res.json({ share: { id: String(share._id), status: share.status } });
  }));

  r.get('/shares', asyncHandler(async (req, res) => {
    const shares = await PartnerShare.find({ ownerId: authOf(req).userId, status: { $ne: 'revoked' } }).lean();
    res.json({ shares: shares.map((s) => ({ id: String(s._id), status: s.status, partnerId: s.partnerId ? String(s.partnerId) : null, permissions: s.permissions, inviteExpiresAt: s.inviteExpiresAt ?? null, lastCheerAt: s.lastCheerAt ?? null })) });
  }));

  r.patch('/shares/:id', asyncHandler(async (req, res) => {
    const share = await PartnerShare.findOne({ _id: objectId(req.params['id']), ownerId: authOf(req).userId, status: { $ne: 'revoked' } });
    if (!share) throw notFound();
    share.permissions = parse(permsSchema, req.body?.permissions ?? {});
    await share.save();
    res.json({ share: ownerView(share) });
  }));

  r.delete('/shares/:id', asyncHandler(async (req, res) => {
    const share = await PartnerShare.findOne({ _id: objectId(req.params['id']), ownerId: authOf(req).userId });
    if (!share) throw notFound();
    share.status = 'revoked';
    share.set('inviteTokenHash', undefined);
    await share.save();
    res.status(204).end();
  }));

  // partner side
  r.get('/shared-with-me', asyncHandler(async (req, res) => {
    const shares = await PartnerShare.find({ partnerId: authOf(req).userId, status: 'active' }).lean();
    const owners = await User.find({ _id: { $in: shares.map((s) => s.ownerId) } }).select('displayName').lean();
    res.json({ shares: shares.map((s) => ({ id: String(s._id), ownerName: owners.find((o) => String(o._id) === String(s.ownerId))?.displayName ?? null, canCheer: canCheer(s.lastCheerAt, new Date()) })) });
  }));

  r.get('/shares/:id/view', asyncHandler(async (req, res) => {
    const share = await PartnerShare.findOne({ _id: objectId(req.params['id']), partnerId: authOf(req).userId, status: 'active' });
    if (!share) throw notFound();
    const { date } = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(utcDayKey(new Date())) }), req.query);
    const snap = await buildSnapshot(String(share.ownerId), date);
    res.json({ view: serializePartnerView(share.permissions, snap) });
  }));

  r.post('/shares/:id/cheer', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const share = await PartnerShare.findOne({ _id: objectId(req.params['id']), partnerId: userId, status: 'active' });
    if (!share) throw notFound();
    const now = new Date();
    if (!canCheer(share.lastCheerAt, now)) throw conflict('You already cheered today', 'cheer_limit');
    const { emoji } = parse(z.object({ emoji: z.string().max(8).default('👏') }), req.body ?? {});
    // atomic once-per-day guard against double taps
    const dayStart = new Date(`${utcDayKey(now)}T00:00:00.000Z`);
    const claimed = await PartnerShare.updateOne({ _id: share._id, $or: [{ lastCheerAt: null }, { lastCheerAt: { $lt: dayStart } }] }, { $set: { lastCheerAt: now } });
    if (claimed.modifiedCount !== 1) throw conflict('You already cheered today', 'cheer_limit');
    await Cheer.create({ shareId: share._id, fromUserId: userId, toUserId: share.ownerId, emoji });
    res.status(201).json({ ok: true });
  }));

  r.get('/cheers', asyncHandler(async (req, res) => {
    const cheers = await Cheer.find({ toUserId: authOf(req).userId }).sort({ createdAt: -1 }).limit(50).select('emoji createdAt seenAt').lean();
    res.json({ cheers });
  }));

  return r;
}
