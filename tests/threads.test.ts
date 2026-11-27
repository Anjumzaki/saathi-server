import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireAuth } from '../src/middleware/auth';
import { errorHandler, notFoundHandler } from '../src/middleware/error';
import { threadRoutes } from '../src/routes/threads';
import { hasFeature, PAID_ONLY_FEATURES, PLUS_ONLY_FEATURES } from '../src/services/entitlement';
import { SAATHI_STAFF_ROLE, isUnreadFor, otherUserIdOf, sideOf } from '../src/services/threadAccess';
import {
  CALL_CHANGE_NOTICE_HOURS,
  REPRESENTATIVE_HELP_IN_TRIAL,
  SAATHI_PLAN_INCLUDED_IN_PLUS,
  canChangeCall,
  channelNote,
} from '../src/services/threadPolicy';
import { assignment, pickNextQueued, queueView } from '../src/services/threadQueue';
import { createMemoryThreadStore } from '../src/services/threadStore';
import { signAccessToken } from '../src/services/tokens';
import { paymentRequired } from '../src/utils/errors';

const HER = '507f1f77bcf86cd799439011';
const DIETITIAN = '507f1f77bcf86cd799439012';
const STRANGER = '507f1f77bcf86cd799439013';
const ADMIN = '507f1f77bcf86cd799439014';
const STAFF = '507f1f77bcf86cd799439015';
const STAFF2 = '507f1f77bcf86cd799439016';
const ORDER = '507f1f77bcf86cd79943a001';

const store = createMemoryThreadStore();
const plus = new Set<string>([HER]);
const orders = new Map<string, { clientId: string; dietitianId: string; status: string }>();

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/v1/threads',
    requireAuth,
    threadRoutes({
      store,
      order: async (id) => orders.get(id) ?? null,
      phoneOf: async () => '+923001234567',
      nameOf: async () => 'Dr Sara',
      // Stands in for the live tier lookup; the trial is covered by the entitlement tests below.
      plusGate: (req, _res, next) => (plus.has(req.auth!.userId) ? next() : next(paymentRequired('Premium Plus required'))),
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tok = (userId: string, roles: string[] = ['client']) => signAccessToken(userId, roles);
async function call(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** An order thread with chat open, ready for the two sides to use. */
async function orderThread() {
  orders.set(ORDER, { clientId: HER, dietitianId: DIETITIAN, status: 'in_progress' });
  const r = await call('POST', `/v1/threads/order/${ORDER}`, tok(HER));
  return r.body.thread.id as string;
}
async function repThread() {
  const r = await call('POST', '/v1/threads/representative', tok(HER));
  return r.body.thread.id as string;
}

beforeEach(() => {
  store.reset();
  orders.clear();
  plus.clear();
  plus.add(HER);
});

describe('a thread has exactly two sides', () => {
  const sides = { kind: 'order' as const, clientId: HER, dietitianId: DIETITIAN, assignedStaffId: null };

  it('gives a side to her and to the dietitian, and none to anyone else', () => {
    expect(sideOf(sides, HER)).toBe('client');
    expect(sideOf(sides, DIETITIAN)).toBe('other');
    expect(sideOf(sides, STRANGER)).toBeNull();
    expect(sideOf(sides, ADMIN)).toBeNull();
  });

  it('gives no side on a Plus thread until a dietitian picks it up', () => {
    const waiting = { kind: 'representative' as const, clientId: HER, dietitianId: null, assignedStaffId: null };
    expect(otherUserIdOf(waiting)).toBeNull();
    expect(sideOf(waiting, STAFF)).toBeNull();
    expect(sideOf({ ...waiting, assignedStaffId: STAFF }, STAFF)).toBe('other');
  });

  it('shuts a stranger and an admin out of every endpoint, as if the thread were not there', async () => {
    const id = await orderThread();
    await call('POST', `/v1/threads/${id}/messages`, tok(HER), { text: 'hello' });
    for (const who of [tok(STRANGER), tok(ADMIN, ['admin'])]) {
      expect((await call('GET', `/v1/threads/${id}`, who)).status).toBe(404);
      expect((await call('GET', `/v1/threads/${id}/messages`, who)).status).toBe(404);
      expect((await call('POST', `/v1/threads/${id}/messages`, who, { text: 'let me in' })).status).toBe(404);
      expect((await call('GET', `/v1/threads/${id}/calls`, who)).status).toBe(404);
      expect((await call('POST', `/v1/threads/${id}/read`, who)).status).toBe(404);
    }
    // and nothing a stranger sent got in
    const seen = await call('GET', `/v1/threads/${id}/messages`, tok(HER));
    expect(seen.body.messages.map((m: { text: string }) => m.text)).toEqual(['hello']);
  });

  it('lists only her own threads', async () => {
    await orderThread();
    await repThread();
    expect((await call('GET', '/v1/threads', tok(HER))).body.threads).toHaveLength(2);
    expect((await call('GET', '/v1/threads', tok(DIETITIAN))).body.threads).toHaveLength(1);
    expect((await call('GET', '/v1/threads', tok(STRANGER))).body.threads).toEqual([]);
  });

  it('refuses a marketplace thread to someone who did not buy the order, and before it is paid for', async () => {
    orders.set(ORDER, { clientId: HER, dietitianId: DIETITIAN, status: 'in_progress' });
    expect((await call('POST', `/v1/threads/order/${ORDER}`, tok(STRANGER))).status).toBe(404);
    orders.set(ORDER, { clientId: HER, dietitianId: DIETITIAN, status: 'requested' });
    const r = await call('POST', `/v1/threads/order/${ORDER}`, tok(HER));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('chat_not_open');
  });

  it('opens one thread per order and one Plus thread per woman', async () => {
    const a = await orderThread();
    expect((await call('POST', `/v1/threads/order/${ORDER}`, tok(DIETITIAN))).body.thread.id).toBe(a);
    const b = await repThread();
    expect((await call('POST', '/v1/threads/representative', tok(HER))).body.thread.id).toBe(b);
  });
});

describe('sending and paging', () => {
  it('takes text and refuses an empty message or an attachment', async () => {
    const id = await orderThread();
    expect((await call('POST', `/v1/threads/${id}/messages`, tok(HER), { text: 'I am bloated today' })).status).toBe(201);
    expect((await call('POST', `/v1/threads/${id}/messages`, tok(HER), { text: '   ' })).status).toBe(400);
    expect((await call('POST', `/v1/threads/${id}/messages`, tok(HER), { type: 'photo', photoRef: 'x' })).status).toBe(400);
  });

  it('pages oldest-last, a page at a time, and polls with since', async () => {
    const id = await orderThread();
    for (let i = 1; i <= 7; i++) await call('POST', `/v1/threads/${id}/messages`, tok(HER), { text: `m${i}` });
    const first = await call('GET', `/v1/threads/${id}/messages?limit=3`, tok(HER));
    expect(first.body.messages.map((m: { text: string }) => m.text)).toEqual(['m5', 'm6', 'm7']);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.messages.every((m: { mine: boolean }) => m.mine)).toBe(true);
    const older = await call('GET', `/v1/threads/${id}/messages?limit=3&before=${first.body.messages[0].createdAt}`, tok(HER));
    expect(older.body.messages.map((m: { text: string }) => m.text)).toEqual(['m2', 'm3', 'm4']);
    const oldest = await call('GET', `/v1/threads/${id}/messages?limit=3&before=${older.body.messages[0].createdAt}`, tok(HER));
    expect(oldest.body.messages.map((m: { text: string }) => m.text)).toEqual(['m1']);
    expect(oldest.body.hasMore).toBe(false);
    // what an open thread polls with
    const since = first.body.messages[2].createdAt;
    expect((await call('GET', `/v1/threads/${id}/messages?since=${since}`, tok(HER))).body.messages).toEqual([]);
    await call('POST', `/v1/threads/${id}/messages`, tok(DIETITIAN), { text: 'how are you sleeping?' });
    const fresh = await call('GET', `/v1/threads/${id}/messages?since=${since}`, tok(HER));
    expect(fresh.body.messages.map((m: { text: string }) => m.text)).toEqual(['how are you sleeping?']);
    expect(fresh.body.messages[0].mine).toBe(false); // hers vs the dietitian's, decided by the server
  });
});

describe('unread counts', () => {
  it('counts only what the other side sent, and clears on read', async () => {
    const id = await orderThread();
    await call('POST', `/v1/threads/${id}/messages`, tok(HER), { text: 'hello' });
    expect((await call('GET', `/v1/threads/${id}`, tok(HER))).body.thread.unread).toBe(0);
    expect((await call('GET', `/v1/threads/${id}`, tok(DIETITIAN))).body.thread.unread).toBe(1);
    await call('POST', `/v1/threads/${id}/messages`, tok(DIETITIAN), { text: 'tell me more' });
    await call('POST', `/v1/threads/${id}/messages`, tok(DIETITIAN), { text: 'and your energy?' });
    expect((await call('GET', `/v1/threads/${id}`, tok(HER))).body.thread.unread).toBe(2);
    expect((await call('GET', `/v1/threads/${id}`, tok(DIETITIAN))).body.thread.unread).toBe(0);
    await call('POST', `/v1/threads/${id}/read`, tok(HER));
    expect((await call('GET', `/v1/threads/${id}`, tok(HER))).body.thread.unread).toBe(0);
  });

  it('totals unread across her threads', async () => {
    const id = await orderThread();
    await repThread();
    await call('POST', `/v1/threads/${id}/messages`, tok(DIETITIAN), { text: 'one' });
    const r = await call('GET', '/v1/threads/unread', tok(HER));
    expect(r.body.total).toBe(1);
    expect(r.body.threads).toHaveLength(2);
  });

  it('counts a message as unread only for the side that did not send it', () => {
    const t = { clientId: HER };
    const fromHer = { senderId: HER, createdAt: new Date(2_000) };
    const fromThem = { senderId: DIETITIAN, createdAt: new Date(2_000) };
    expect(isUnreadFor('client', fromThem, t, null)).toBe(true);
    expect(isUnreadFor('client', fromHer, t, null)).toBe(false);
    expect(isUnreadFor('other', fromHer, t, null)).toBe(true);
    expect(isUnreadFor('client', fromThem, t, new Date(3_000))).toBe(false);
  });
});

describe('booking a call', () => {
  /** The dietitian offers times; she books one. */
  async function withSlots(hours: number[]) {
    const id = await orderThread();
    await call('POST', `/v1/threads/${id}/slots`, tok(DIETITIAN), {
      slots: hours.map((h) => ({ start: hoursFromNow(h), end: hoursFromNow(h + 0.5) })),
    });
    const t = await call('GET', `/v1/threads/${id}`, tok(HER));
    return { id, slots: t.body.thread.slots as { id: string; start: string }[] };
  }

  it('only the other side offers times, and only she books', async () => {
    const { id, slots } = await withSlots([10]);
    expect((await call('POST', `/v1/threads/${id}/slots`, tok(HER), { slots: [{ start: hoursFromNow(5), end: hoursFromNow(6) }] })).status).toBe(403);
    expect((await call('POST', `/v1/threads/${id}/calls`, tok(DIETITIAN), { slotId: slots[0]!.id })).status).toBe(403);
  });

  it('is confirmed as soon as she books, with a note about who rings whom and no in-app call', async () => {
    const { id, slots } = await withSlots([10]);
    const r = await call('POST', `/v1/threads/${id}/calls`, tok(HER), { slotId: slots[0]!.id });
    expect(r.status).toBe(201);
    expect(r.body.call.status).toBe('confirmed');
    expect(r.body.call.channelNote).toBe('She will call you on +923001234567');
    expect(r.body.noticeHours).toBe(CALL_CHANGE_NOTICE_HOURS);
    // the slot is gone from the offer list, so two bookings cannot share it
    expect((await call('GET', `/v1/threads/${id}`, tok(HER))).body.thread.slots).toHaveLength(0);
    expect((await call('POST', `/v1/threads/${id}/calls`, tok(HER), { slotId: slots[0]!.id })).body.error.code).toBe('slot_taken');
  });

  it('refuses a time that was never offered', async () => {
    const { id } = await withSlots([10]);
    expect((await call('POST', `/v1/threads/${id}/calls`, tok(HER), { slotId: 'aaaaaaaaaaaaaaaaaaaaaaaa' })).status).toBe(404);
  });

  it('cancels inside the notice period, says who did it, and puts the time back on offer', async () => {
    const { id, slots } = await withSlots([10]);
    const booked = await call('POST', `/v1/threads/${id}/calls`, tok(HER), { slotId: slots[0]!.id });
    const r = await call('POST', `/v1/threads/${id}/calls/${booked.body.call.id}/cancel`, tok(HER), { reason: 'travelling' });
    expect(r.status).toBe(200);
    expect(r.body.call.status).toBe('cancelled');
    expect(r.body.call.cancelledBy).toBe('client');
    expect((await call('GET', `/v1/threads/${id}`, tok(HER))).body.thread.slots).toHaveLength(1);
  });

  it('records the other side cancelling, so she can be told who it was', async () => {
    const { id, slots } = await withSlots([10]);
    const booked = await call('POST', `/v1/threads/${id}/calls`, tok(HER), { slotId: slots[0]!.id });
    const r = await call('POST', `/v1/threads/${id}/calls/${booked.body.call.id}/cancel`, tok(DIETITIAN), {});
    expect(r.body.call.cancelledBy).toBe('other');
  });

  it('refuses a cancellation and a move once the notice period has passed', async () => {
    const { id, slots } = await withSlots([1, 20]);
    const booked = await call('POST', `/v1/threads/${id}/calls`, tok(HER), { slotId: slots[0]!.id });
    const late = await call('POST', `/v1/threads/${id}/calls/${booked.body.call.id}/cancel`, tok(HER), {});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('too_late_to_change');
    expect(late.body.error.message).toContain(`${CALL_CHANGE_NOTICE_HOURS} hours`);
    const move = await call('POST', `/v1/threads/${id}/calls/${booked.body.call.id}/reschedule`, tok(HER), { slotId: slots[1]!.id });
    expect(move.body.error.code).toBe('too_late_to_change');
  });

  it('moves a call to another offered time and remembers the old one', async () => {
    const { id, slots } = await withSlots([10, 30]);
    const booked = await call('POST', `/v1/threads/${id}/calls`, tok(HER), { slotId: slots[0]!.id });
    const r = await call('POST', `/v1/threads/${id}/calls/${booked.body.call.id}/reschedule`, tok(HER), { slotId: slots[1]!.id });
    expect(r.status).toBe(200);
    expect(r.body.call.status).toBe('confirmed');
    expect(new Date(r.body.call.slotStart).getTime()).toBeGreaterThan(new Date(booked.body.call.slotStart).getTime());
    expect(r.body.call.rescheduledFrom).toBe(booked.body.call.slotStart);
    // the time she left goes back on offer; the one she took does not
    expect((await call('GET', `/v1/threads/${id}`, tok(HER))).body.thread.slots.map((s: { id: string }) => s.id)).toEqual([slots[0]!.id]);
  });

  it('states the notice period as a rule, not as a surprise', () => {
    const start = new Date('2026-12-01T12:00:00Z');
    expect(canChangeCall(start, new Date('2026-12-01T07:00:00Z'))).toBe(true);
    expect(canChangeCall(start, new Date('2026-12-01T08:00:00Z'))).toBe(true);
    expect(canChangeCall(start, new Date('2026-12-01T08:00:01Z'))).toBe(false);
    expect(channelNote('they_call', null)).toBe('She will call you on the number on your account');
    expect(channelNote('she_calls', '+971500000000')).toContain('You will call on');
  });
});

describe('the Premium Plus queue', () => {
  it('keeps a woman who is not on Plus out of representative help', async () => {
    plus.delete(HER);
    const r = await call('POST', '/v1/threads/representative', tok(HER));
    expect(r.status).toBe(402);
    expect((await call('POST', '/v1/threads/plan-request', tok(HER), {})).status).toBe(402);
  });

  it('waits with an honest line, not a promise', async () => {
    const id = await repThread();
    const t = await call('GET', `/v1/threads/${id}`, tok(HER));
    expect(t.body.thread.queue.state).toBe('waiting');
    expect(t.body.thread.queue.text).toContain('usually replies within a day');
  });

  it('says so plainly once the wait has run long', () => {
    const now = new Date('2026-12-02T00:00:00Z');
    const queued = { id: 'a', queuedAt: new Date('2026-11-30T00:00:00Z'), assignedStaffId: null, assignedAt: null };
    expect(queueView(queued, now).state).toBe('late');
    expect(queueView(queued, now).text).toContain('longer than it should');
    expect(queueView({ ...queued, assignedStaffId: STAFF }, now).state).toBe('assigned');
  });

  it('is picked up oldest first and only by Saathi staff', async () => {
    const id = await repThread();
    expect((await call('POST', '/v1/threads/queue/next', tok(STAFF))).status).toBe(403);
    const r = await call('POST', '/v1/threads/queue/next', tok(STAFF, [SAATHI_STAFF_ROLE]));
    expect(r.status).toBe(200);
    expect(r.body.thread.id).toBe(id);
    expect(r.body.thread.queue.state).toBe('assigned');
    // nothing left waiting, and the staff member who took it can now read and answer
    expect((await call('POST', '/v1/threads/queue/next', tok(STAFF2, [SAATHI_STAFF_ROLE]))).body.thread).toBeNull();
    expect((await call('POST', `/v1/threads/${id}/messages`, tok(STAFF), { text: 'I am here, tell me what is going on' })).status).toBe(201);
    expect((await call('GET', `/v1/threads/${id}`, tok(STAFF2, [SAATHI_STAFF_ROLE]))).status).toBe(404);
  });

  it('never overtakes someone who has waited longer', () => {
    const t = (id: string, h: number) => ({ id, queuedAt: new Date(h * 3_600_000), assignedStaffId: null, assignedAt: null });
    expect(pickNextQueued([t('new', 10), t('old', 1), t('mid', 5)])?.id).toBe('old');
    expect(pickNextQueued([{ ...t('taken', 1), assignedStaffId: STAFF }])).toBeNull();
    expect(pickNextQueued([])).toBeNull();
    expect(assignment({ ...t('x', 1), assignedStaffId: STAFF }, STAFF2, new Date())).toBeNull();
  });
});

describe('the two defaults left open', () => {
  it('includes a plan from a Saathi representative in Premium Plus at no extra charge', async () => {
    expect(SAATHI_PLAN_INCLUDED_IN_PLUS).toBe(true);
    const r = await call('POST', '/v1/threads/plan-request', tok(HER), { note: 'Please write me a plan for PCOS' });
    expect(r.status).toBe(201);
    expect(r.body.included).toBe(true);
    expect(r.body.extraCharge).toBe(0);
    // it opens her thread and asks there, so she can be answered in one place
    const msgs = await call('GET', `/v1/threads/${r.body.thread.id}/messages`, tok(HER));
    expect(msgs.body.messages[0].text).toBe('Please write me a plan for PCOS');
  });

  it('keeps representative chat and calls inside the 7-day trial, with only the discounts held back', () => {
    expect(REPRESENTATIVE_HELP_IN_TRIAL).toBe(true);
    const trialing = { status: 'trialing' as const, tier: 'plus' as const, trialEndsAt: new Date('2026-12-04T00:00:00Z') };
    const now = new Date('2026-12-01T00:00:00Z');
    for (const f of PLUS_ONLY_FEATURES) expect(hasFeature(trialing, f, now)).toBe(true);
    expect(hasFeature(trialing, 'dietitian_discount', now)).toBe(false);
    expect(hasFeature(trialing, 'merchant_discount', now)).toBe(false);
    // the constant above and the trial exclusion list must not drift apart
    expect(REPRESENTATIVE_HELP_IN_TRIAL).toBe(!PAID_ONLY_FEATURES.includes('representative_help'));
    expect(PAID_ONLY_FEATURES).toEqual(['dietitian_discount', 'merchant_discount']);
  });
});
