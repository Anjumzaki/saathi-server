/**
 * Chat and call booking, shared by two products: Premium Plus (chat and calls with Saathi's own
 * dietitians) and the marketplace (chat and calls with the dietitian she bought a plan from). One
 * implementation, two ways in — `POST /representative` and `POST /order/:orderId`.
 *
 * There is no voice or video provider behind any of this. A booking is a time plus a note about who
 * rings whom, and nothing here says a call happens inside the app.
 *
 * Delivery is by polling: an open thread asks for messages newer than the last one it holds. A push goes
 * out alongside, carrying the thread id and no words, and the phone then fetches with the same `since`.
 */
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { CALL_CHANNELS, type CallChannel } from '../models/CallBooking';
import { Order } from '../models/Order';
import { DietitianProfile } from '../models/DietitianProfile';
import { User } from '../models/User';
import { requireFeature, requireRole } from '../middleware/auth';
import { SAATHI_STAFF_ROLE, otherUserIdOf, sideOf, type ThreadSide } from '../services/threadAccess';
import {
  CALL_CHANGE_NOTICE_HOURS,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  SAATHI_PLAN_INCLUDED_IN_PLUS,
  canChangeCall,
  channelNote,
  isBookableSlot,
  noticeMessage,
} from '../services/threadPolicy';
import { livePush, type PushService } from '../services/push';
import { assignment, pickNextQueued, queueView } from '../services/threadQueue';
import { mongoThreadStore, type ThreadRecord, type ThreadStore } from '../services/threadStore';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';

/** Chat opens once an order is paid for and closes if it was refunded. */
const CHAT_OPEN_STATUSES = ['paid', 'in_progress', 'delivered', 'released'];

export interface ThreadDeps {
  store: ThreadStore;
  /** The order behind a marketplace thread: its two sides and whether chat is open yet. */
  order(orderId: string): Promise<{ clientId: string; dietitianId: string; status: string } | null>;
  /** Her phone number, for the "she will call you on …" note. Null when she has not shared one. */
  phoneOf(userId: string): Promise<string | null>;
  /** The other side's name for the thread header, when there is one. */
  nameOf(userId: string): Promise<string | null>;
  /** The Premium Plus gate. Representative help is inside the trial, so this is the tier check only. */
  plusGate: RequestHandler;
  push: PushService;
}

export const mongoThreadDeps: Omit<ThreadDeps, 'push'> = {
  store: mongoThreadStore,
  async order(orderId) {
    const o = await Order.findById(orderId).select('clientId dietitianId status').lean();
    return o ? { clientId: String(o.clientId), dietitianId: String(o.dietitianId), status: String(o.status) } : null;
  },
  async phoneOf(userId) {
    const u = await User.findById(userId).select('phone').lean();
    return (u?.phone as string | undefined) ?? null;
  },
  async nameOf(userId) {
    const p = await DietitianProfile.findOne({ userId }).select('displayName').lean();
    return p?.displayName ?? null;
  },
  plusGate: requireFeature('representative_help'),
};

const slotsBody = z.object({
  slots: z
    .array(z.object({ start: z.coerce.date(), end: z.coerce.date() }).refine((s) => s.end > s.start, 'a slot must end after it starts'))
    .min(1)
    .max(20),
});
const bookBody = z.object({
  slotId: z.string().min(1).max(64),
  channel: z.enum(CALL_CHANNELS).default('they_call'),
  /** Only a number she already shares; nothing new is collected here. */
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
});

export function threadRoutes(overrides: Partial<ThreadDeps> = {}): Router {
  // livePush() is only reached when nothing is injected, so a test never builds the real service.
  const d: ThreadDeps = { ...mongoThreadDeps, push: overrides.push ?? livePush(), ...overrides };
  const r = Router();

  /** A thread is readable by its two sides and no one else, so a stranger gets the same answer as for a thread that is not there. */
  async function load(req: Parameters<RequestHandler>[0], idParam = 'id'): Promise<{ t: ThreadRecord; side: ThreadSide }> {
    const { userId } = authOf(req);
    const t = await d.store.threadById(objectId(req.params[idParam]));
    if (!t) throw notFound('Thread not found');
    const side = sideOf(t, userId);
    if (!side) throw notFound('Thread not found');
    return { t, side };
  }

  async function view(t: ThreadRecord, side: ThreadSide, now: Date) {
    const otherId = otherUserIdOf(t);
    return {
      id: t.id,
      kind: t.kind,
      orderId: t.orderId,
      otherName: otherId ? await d.nameOf(otherId) : null,
      /** Representative threads only: whether anyone has picked this up, with an honest wait line. */
      queue: t.kind === 'representative' ? queueView(t, now) : null,
      unread: await d.store.unreadFor(t, side),
      lastMessageAt: t.lastMessageAt,
      /** Times the other side has offered that she can still take. */
      slots: t.offeredSlots.filter((s) => isBookableSlot(s, now)).map((s) => ({ id: s.id, start: s.start, end: s.end })),
      noticeHours: CALL_CHANGE_NOTICE_HOURS,
    };
  }

  r.get('/', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const now = new Date();
    const threads = await d.store.threadsFor(userId);
    res.json({ threads: await Promise.all(threads.map((t) => view(t, sideOf(t, userId) ?? 'client', now))) });
  }));

  /** One number for the Profile badge, plus the per-thread counts the list uses. */
  r.get('/unread', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const threads = await d.store.threadsFor(userId);
    const counts = await Promise.all(
      threads.map(async (t) => ({ threadId: t.id, unread: await d.store.unreadFor(t, sideOf(t, userId) ?? 'client') })),
    );
    res.json({ total: counts.reduce((a, c) => a + c.unread, 0), threads: counts });
  }));

  /** Premium Plus: her one thread with Saathi's own dietitians. Opening it puts her in the queue. */
  r.post('/representative', d.plusGate, asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const now = new Date();
    const existing = await d.store.representativeThread(userId);
    const t = existing ?? (await d.store.createThread({
      kind: 'representative', clientId: userId, orderId: null, dietitianId: null,
      assignedStaffId: null, queuedAt: now, assignedAt: null,
    }));
    res.status(existing ? 200 : 201).json({ thread: await view(t, 'client', now) });
  }));

  /** Marketplace: the thread on an order, for whichever of its two sides is asking. */
  r.post('/order/:orderId', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const now = new Date();
    const orderId = objectId(req.params['orderId']);
    const o = await d.order(orderId);
    if (!o) throw notFound('Order not found');
    const side: ThreadSide | null = o.clientId === userId ? 'client' : o.dietitianId === userId ? 'other' : null;
    if (!side) throw notFound('Order not found'); // do not reveal that it exists
    if (!CHAT_OPEN_STATUSES.includes(o.status)) throw conflict('Chat opens once the order is paid for', 'chat_not_open');
    const existing = await d.store.threadByOrder(orderId);
    const t = existing ?? (await d.store.createThread({
      kind: 'order', clientId: o.clientId, orderId, dietitianId: o.dietitianId,
      assignedStaffId: null, queuedAt: null, assignedAt: null,
    }));
    res.status(existing ? 200 : 201).json({ thread: await view(t, side, now) });
  }));

  /** Every call she has, across both kinds of thread: one read for the "your calls" screen. */
  r.get('/calls', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const [calls, threads] = await Promise.all([d.store.callsFor(userId), d.store.threadsFor(userId)]);
    const byThread = new Map(threads.map((t) => [t.id, t]));
    const named = await Promise.all(
      calls.map(async (c) => {
        const t = c.threadId ? byThread.get(c.threadId) : undefined;
        const otherId = t ? otherUserIdOf(t) : null;
        return { ...c, threadKind: t?.kind ?? c.kind, otherName: otherId ? await d.nameOf(otherId) : null };
      }),
    );
    res.json({ calls: named, noticeHours: CALL_CHANGE_NOTICE_HOURS });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const { t, side } = await load(req);
    res.json({ thread: await view(t, side, new Date()), side });
  }));

  r.get('/:id/messages', asyncHandler(async (req, res) => {
    const { t } = await load(req);
    const q = parse(
      z.object({
        before: z.coerce.date().optional(),
        since: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).default(MESSAGE_PAGE_SIZE),
      }),
      req.query,
    );
    const page = await d.store.messages({ threadId: t.id, orderId: t.orderId }, { before: q.before, since: q.since, limit: q.limit });
    // `mine` saves the phone from having to know her own user id to lay the conversation out.
    const { userId } = authOf(req);
    res.json({ messages: page.messages.map((m) => ({ ...m, mine: m.senderId === userId })), hasMore: page.hasMore });
  }));

  /**
   * Text only in this first version. Attachments (photos of a meal, a lab report) are a later decision:
   * they need storage, a retention rule and a view on what a dietitian may keep, so nothing but text is
   * accepted here yet.
   */
  r.post('/:id/messages', asyncHandler(async (req, res) => {
    const { t, side } = await load(req);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(4000) }), req.body);
    const { userId } = authOf(req);
    const m = await d.store.addMessage({ threadId: t.id, orderId: t.orderId, senderId: userId, type: 'text', text, planUpdate: null });
    // Sending is also reading: her own message must never come back as unread to herself.
    await d.store.patchThread(t.id, { lastMessageAt: m.createdAt, ...(side === 'client' ? { clientReadAt: m.createdAt } : { otherReadAt: m.createdAt }) });
    // The other side of the thread, which is nobody while a Plus thread still waits in the queue.
    const recipient = side === 'client' ? otherUserIdOf(t) : t.clientId;
    if (recipient) d.push.notify(recipient, { type: 'chat_message', threadId: t.id, threadKind: t.kind, orderId: t.orderId });
    res.status(201).json({ message: m });
  }));

  r.post('/:id/read', asyncHandler(async (req, res) => {
    const { t, side } = await load(req);
    const now = new Date();
    await d.store.patchThread(t.id, side === 'client' ? { clientReadAt: now } : { otherReadAt: now });
    res.json({ readAt: now, unread: 0 });
  }));

  /** The other side offers times. She picks from these rather than proposing one of her own. */
  r.post('/:id/slots', asyncHandler(async (req, res) => {
    const { t, side } = await load(req);
    if (side !== 'other') throw forbidden('Only the other side offers times');
    const { userId } = authOf(req);
    const now = new Date();
    const { slots } = parse(slotsBody, req.body);
    if (slots.some((s) => s.start.getTime() <= now.getTime())) throw badRequest('Offer times in the future');
    const updated = await d.store.offerSlots(t.id, slots.map((s) => ({ start: s.start, end: s.end, offeredBy: userId })));
    res.status(201).json({ thread: await view(updated ?? t, side, now) });
  }));

  r.get('/:id/calls', asyncHandler(async (req, res) => {
    const { t } = await load(req);
    res.json({ calls: await d.store.calls(t.id), noticeHours: CALL_CHANGE_NOTICE_HOURS });
  }));

  /** She books one of the offered times. The other side offered it, so it is confirmed straight away. */
  r.post('/:id/calls', asyncHandler(async (req, res) => {
    const { t, side } = await load(req);
    if (side !== 'client') throw forbidden('Only she books the call');
    const now = new Date();
    const b = parse(bookBody, req.body);
    const slot = t.offeredSlots.find((s) => s.id === b.slotId);
    if (!slot) throw notFound('That time is not on offer');
    if (!isBookableSlot(slot, now)) throw conflict('That time has gone. Pick another one.', 'slot_taken');
    const other = otherUserIdOf(t);
    if (!other) throw conflict('No one is on this thread yet', 'thread_unassigned');
    if (!(await d.store.takeSlot(t.id, slot.id))) throw conflict('That time has gone. Pick another one.', 'slot_taken');
    const phone = b.phone ?? (await d.phoneOf(t.clientId));
    const call = await d.store.addCall({
      threadId: t.id, kind: t.kind, orderId: t.orderId, clientId: t.clientId, dietitianId: other,
      slotId: slot.id, slotStart: slot.start, slotEnd: slot.end, status: 'confirmed',
      channel: b.channel as CallChannel, channelNote: channelNote(b.channel as CallChannel, phone),
      cancelledBy: null, cancelReason: '', rescheduledFrom: null,
    });
    res.status(201).json({ call, noticeHours: CALL_CHANGE_NOTICE_HOURS });
  }));

  async function loadCall(req: Parameters<RequestHandler>[0]) {
    const { t, side } = await load(req);
    const call = await d.store.callById(objectId(req.params['callId']));
    if (!call || call.threadId !== t.id) throw notFound('Call not found');
    return { t, side, call };
  }

  /** Either side may call it off, inside the notice period. Who did it is recorded, so she is told plainly. */
  r.post('/:id/calls/:callId/cancel', asyncHandler(async (req, res) => {
    const { t, side, call } = await loadCall(req);
    const { reason } = parse(z.object({ reason: z.string().max(300).default('') }), req.body ?? {});
    if (call.status === 'cancelled') throw conflict('That call is already cancelled', 'already_cancelled');
    if (call.status === 'completed') throw conflict('That call has already happened', 'already_completed');
    if (!canChangeCall(call.slotStart, new Date())) throw conflict(noticeMessage(), 'too_late_to_change');
    if (call.slotId) await d.store.freeSlot(t.id, call.slotId);
    const updated = await d.store.patchCall(call.id, { status: 'cancelled', cancelledBy: side, cancelReason: reason });
    res.json({ call: updated });
  }));

  /** Moving a call is cancelling and re-booking in one step, so the same notice period applies. */
  r.post('/:id/calls/:callId/reschedule', asyncHandler(async (req, res) => {
    const { t, side, call } = await loadCall(req);
    if (side !== 'client') throw forbidden('Only she moves the call');
    const now = new Date();
    const { slotId } = parse(z.object({ slotId: z.string().min(1).max(64) }), req.body);
    if (call.status !== 'confirmed' && call.status !== 'requested') throw conflict(`That call is ${call.status}`, 'invalid_transition');
    if (!canChangeCall(call.slotStart, now)) throw conflict(noticeMessage(), 'too_late_to_change');
    const slot = t.offeredSlots.find((s) => s.id === slotId);
    if (!slot) throw notFound('That time is not on offer');
    if (!isBookableSlot(slot, now)) throw conflict('That time has gone. Pick another one.', 'slot_taken');
    if (!(await d.store.takeSlot(t.id, slot.id))) throw conflict('That time has gone. Pick another one.', 'slot_taken');
    if (call.slotId) await d.store.freeSlot(t.id, call.slotId);
    const updated = await d.store.patchCall(call.id, {
      slotId: slot.id, slotStart: slot.start, slotEnd: slot.end, rescheduledFrom: call.slotStart, status: 'confirmed',
    });
    res.json({ call: updated });
  }));

  /**
   * A plan written by a Saathi representative. Included in Premium Plus at no extra charge
   * (SAATHI_PLAN_INCLUDED_IN_PLUS), so this only opens her thread and asks; nothing is priced or paid.
   * Reachable from a thread and from the plan-source screen, which is why it takes no thread id.
   */
  r.post('/plan-request', d.plusGate, asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const now = new Date();
    const { note } = parse(z.object({ note: z.string().trim().max(1000).default('') }), req.body ?? {});
    const t = (await d.store.representativeThread(userId)) ?? (await d.store.createThread({
      kind: 'representative', clientId: userId, orderId: null, dietitianId: null,
      assignedStaffId: null, queuedAt: now, assignedAt: null,
    }));
    const text = note || 'I would like a plan written for me.';
    const m = await d.store.addMessage({ threadId: t.id, orderId: null, senderId: userId, type: 'text', text, planUpdate: null });
    await d.store.patchThread(t.id, { lastMessageAt: m.createdAt, clientReadAt: m.createdAt });
    res.status(201).json({ thread: await view(t, 'client', now), included: SAATHI_PLAN_INCLUDED_IN_PLUS, extraCharge: 0 });
  }));

  /** Saathi's own dietitian takes the oldest waiting thread. Nobody is overtaken. */
  r.post('/queue/next', requireRole(SAATHI_STAFF_ROLE), asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const now = new Date();
    const next = pickNextQueued(await d.store.queuedThreads());
    if (!next) return res.json({ thread: null });
    const patch = assignment(next, userId, now);
    if (!patch) throw conflict('Someone else has taken that thread', 'already_assigned');
    const updated = await d.store.patchThread(next.id, patch);
    return res.json({ thread: updated ? await view(updated, 'other', now) : null });
  }));

  return r;
}
