import { Router } from 'express';
import { z } from 'zod';
import { getEnv } from '../config/env';
import { DaySummary } from '../models/DaySummary';
import { Cheer, PartnerShare, VIEWER_STATUSES } from '../models/PartnerShare';
import { SyncRecord } from '../models/SyncRecord';
import { User } from '../models/User';
import { isPremiumActive } from '../services/entitlement';
import {
  INVITE_TTL_MS, PREVIEW_DAYS, SENDING_REQUIRES_PACKAGE, canCheer, inviteExpiry, isInviteValid, partnerAccess, previewEnd,
  type PartnerAccess,
} from '../services/partnerLogic';
import { serializePartnerView, type PartnerSnapshot } from '../services/serializers';
import { addRole } from '../services/users';
import { randomToken, sha256 } from '../utils/crypto';
import { ApiError, conflict, notFound, paymentRequired } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';
import { utcDayKey } from '../utils/time';

const permsSchema = z.object({
  effortRing: z.boolean().default(false),
  mealsLogged: z.boolean().default(false),
  waterWalk: z.boolean().default(false),
  weight: z.boolean().default(false),
  togetherNudgesOnly: z.boolean().default(false),
  together: z.boolean().default(false),
});

/** What the phone sends for one day. Numbers and flags only: no food names, no cycle dates. */
const summarySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effort: z.number().int().min(0).max(100),
  streak: z.number().int().min(0).max(10000),
  mealsDone: z.number().int().min(0).max(50),
  mealsTotal: z.number().int().min(0).max(50),
  waterCups: z.number().int().min(0).max(100),
  waterTarget: z.number().int().min(0).max(100),
  steps: z.number().int().min(0).max(200000),
  walkDone: z.boolean(),
  togetherTonight: z.boolean().default(false),
  weightKg: z.number().min(2).max(400).nullable().default(null),
  weightGoalKg: z.number().min(2).max(400).nullable().default(null),
}).strict();

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
  // The app's own day summary (PUT /partner/summary) is the real source; the record conventions above are a fallback.
  const day = (await DaySummary.findOne({ userId: ownerId, date }).lean()) ?? (await DaySummary.findOne({ userId: ownerId, updatedAt: { $gte: new Date(Date.now() - 36 * 3_600_000) } }).sort({ date: -1 }).lean());
  if (day) {
    const d = day.summary as Record<string, unknown>;
    const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
    snap.date = day.date;
    snap.effort = num('effort');
    snap.effortRing = snap.effort != null ? snap.effort / 100 : snap.effortRing ?? null;
    snap.streak = num('streak');
    snap.mealsDone = num('mealsDone');
    snap.mealsTotal = num('mealsTotal');
    snap.mealsLoggedToday = (snap.mealsDone ?? 0) > 0;
    snap.waterCups = num('waterCups');
    snap.waterTarget = num('waterTarget');
    snap.steps = num('steps');
    snap.walkDone = d['walkDone'] === true;
    snap.togetherTonight = d['togetherTonight'] === true;
    snap.weightKg = num('weightKg');
    snap.weightGoalKg = num('weightGoalKg');
  }
  return snap;
}

const ownerView = (s: InstanceType<typeof PartnerShare>) => ({
  id: String(s._id), status: s.status, partnerId: s.partnerId ? String(s.partnerId) : null,
  permissions: s.permissions, inviteExpiresAt: s.inviteExpiresAt ?? null, lastCheerAt: s.lastCheerAt ?? null,
  previewEndsAt: s.previewEndsAt ?? null,
});

/** Shape both screens read: never the raw dates alone, so the phone's clock is never the one deciding. */
const accessView = (a: PartnerAccess) => ({
  state: a.state, previewEndsAt: a.previewEndsAt ?? null, daysLeft: a.daysLeft, lastPreviewDay: a.lastPreviewDay, canSeeDay: a.canSeeDay,
});

type SubLike = Parameters<typeof isPremiumActive>[0];
const hasPackage = (sub: SubLike, now: Date): boolean => isPremiumActive(sub, now);

/** Does this user hold a package right now? One read, used by every viewer-side route. */
async function viewerHasPackage(userId: string, now: Date): Promise<boolean> {
  const u = await User.findById(userId).select('subscription').lean();
  return hasPackage((u?.subscription ?? null) as SubLike, now);
}

/**
 * Every viewer-side route goes through here: it finds the share, works out where the viewer stands, keeps the
 * stored status in step (paused when the preview ran out, active again the moment they pay) and refuses to hand
 * over the day without a package once the preview is over. Nothing is deleted either way: the share, its
 * permissions and its cheers all survive a pause and come back untouched.
 */
async function viewerShare(req: Parameters<typeof authOf>[0], shareId: string | undefined, needsDay: boolean) {
  const { userId } = authOf(req);
  const share = await PartnerShare.findOne({ _id: objectId(shareId), partnerId: userId, status: { $in: VIEWER_STATUSES } });
  if (!share) throw notFound();
  const now = new Date();
  // Accepted before the preview existed: start the window now rather than cutting an old partner off.
  if (share.status === 'active' && !share.previewEndsAt) {
    share.acceptedAt = share.acceptedAt ?? now;
    share.previewEndsAt = previewEnd(now);
    await share.save();
  }
  const access = partnerAccess({ status: share.status, previewEndsAt: share.previewEndsAt }, await viewerHasPackage(userId, now), now);
  await syncPausedFlag(share, access, now);
  if (needsDay && !access.canSeeDay) {
    throw new ApiError(402, 'preview_ended', `Your ${PREVIEW_DAYS} free days are over. Start your trial to stay connected.`);
  }
  return { share, access, now };
}

/** Writes the paused/active state the pure rule worked out, so her side sees it without the viewer opening the app. */
async function syncPausedFlag(share: InstanceType<typeof PartnerShare>, access: PartnerAccess, now: Date): Promise<void> {
  const paused = access.state === 'paused';
  if (paused && share.status !== 'paused') {
    await PartnerShare.updateOne({ _id: share._id, status: 'active' }, { $set: { status: 'paused', pausedAt: now } });
    share.status = 'paused';
  } else if (!paused && share.status === 'paused') {
    // Paid: the connection resumes exactly as it was.
    await PartnerShare.updateOne({ _id: share._id, status: 'paused' }, { $set: { status: 'active', pausedAt: null } });
    share.status = 'active';
  }
}

/** She may share for free today; SENDING_REQUIRES_PACKAGE is the one switch that changes that. */
async function requireOwnerMaySend(userId: string): Promise<void> {
  if (!SENDING_REQUIRES_PACKAGE) return;
  if (!(await viewerHasPackage(userId, new Date()))) throw paymentRequired('Sharing your day needs a package');
}

export function partnerRoutes(): Router {
  const r = Router();

  // Owner: the phone's summary of one day, replacing any earlier one for that date.
  r.put('/summary', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    await requireOwnerMaySend(userId);
    const { date, ...summary } = parse(summarySchema, req.body);
    await DaySummary.updateOne({ userId, date }, { $set: { summary } }, { upsert: true });
    res.status(204).end();
  }));

  r.post('/invites', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    await requireOwnerMaySend(userId);
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
    const now = new Date();
    // The free preview starts here, on server time, and is kept on the share: the phone cannot move it.
    share.acceptedAt = now;
    share.previewEndsAt = previewEnd(now);
    share.pausedAt = null;
    share.set('inviteTokenHash', undefined); // single use
    await share.save();
    await addRole(userId, 'partner');
    const access = partnerAccess({ status: share.status, previewEndsAt: share.previewEndsAt }, await viewerHasPackage(userId, now), now);
    res.json({ share: { id: String(share._id), status: share.status }, access: accessView(access) });
  }));

  r.get('/shares', asyncHandler(async (req, res) => {
    const shares = await PartnerShare.find({ ownerId: authOf(req).userId, status: { $ne: 'revoked' } }).lean();
    const partners = await User.find({ _id: { $in: shares.map((s) => s.partnerId).filter(Boolean) } }).select('displayName subscription').lean();
    const now = new Date();
    res.json({
      shares: shares.map((s) => {
        const partner = partners.find((p) => String(p._id) === String(s.partnerId));
        // An older share with no window yet is shown as a full preview; it starts counting on the viewer's next request.
        const previewEndsAt = s.previewEndsAt ?? (s.status === 'active' ? previewEnd(now) : null);
        const access = partnerAccess({ status: s.status, previewEndsAt }, hasPackage((partner?.subscription ?? null) as SubLike, now), now);
        return {
          id: String(s._id), status: s.status, partnerId: s.partnerId ? String(s.partnerId) : null,
          partnerName: partner?.displayName ?? null, permissions: s.permissions, inviteExpiresAt: s.inviteExpiresAt ?? null,
          lastCheerAt: s.lastCheerAt ?? null, previewEndsAt: s.previewEndsAt ?? null, access: accessView(access),
        };
      }),
    });
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
  // Names and where the viewer stands; never any of her day. Paused shares are listed so the app can explain itself.
  r.get('/shared-with-me', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const shares = await PartnerShare.find({ partnerId: userId, status: { $in: VIEWER_STATUSES } }).lean();
    const owners = await User.find({ _id: { $in: shares.map((s) => s.ownerId) } }).select('displayName').lean();
    const now = new Date();
    const paid = await viewerHasPackage(userId, now);
    res.json({
      shares: shares.map((s) => {
        const access = partnerAccess({ status: s.status, previewEndsAt: s.previewEndsAt }, paid, now);
        return {
          id: String(s._id), ownerName: owners.find((o) => String(o._id) === String(s.ownerId))?.displayName ?? null,
          canCheer: access.canSeeDay && canCheer(s.lastCheerAt, now), access: accessView(access),
        };
      }),
    });
  }));

  r.get('/shares/:id/view', asyncHandler(async (req, res) => {
    const { share, access } = await viewerShare(req, req.params['id'], true);
    const { date } = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(utcDayKey(new Date())) }), req.query);
    const snap = await buildSnapshot(String(share.ownerId), date);
    res.json({ view: serializePartnerView(share.permissions, snap), access: accessView(access) });
  }));

  r.post('/shares/:id/cheer', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const { share, now } = await viewerShare(req, req.params['id'], true);
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
