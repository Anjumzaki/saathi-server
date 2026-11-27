/**
 * Everything the thread routes read and write, behind one interface. The Mongoose implementation is what
 * runs; the in-memory one lets the routes be tested end to end without a database, the way the stub
 * services do for billing and email.
 */
import { CallBooking, type CallChannel, type CallStatus } from '../models/CallBooking';
import { Message, Thread, type ThreadKind } from '../models/Message';
import { isUnreadFor, type ThreadSide } from './threadAccess';

export interface OfferedSlot {
  id: string;
  start: Date;
  end: Date;
  offeredBy: string;
  taken: boolean;
}

export interface ThreadRecord {
  id: string;
  kind: ThreadKind;
  clientId: string;
  orderId: string | null;
  dietitianId: string | null;
  assignedStaffId: string | null;
  queuedAt: Date | null;
  assignedAt: Date | null;
  clientReadAt: Date | null;
  otherReadAt: Date | null;
  lastMessageAt: Date | null;
  offeredSlots: OfferedSlot[];
  createdAt: Date;
}

export type MessageKind = 'text' | 'photo' | 'plan_update';

export interface MessageRecord {
  id: string;
  threadId: string | null;
  senderId: string;
  type: MessageKind;
  text: string | null;
  planUpdate: unknown;
  createdAt: Date;
}

export interface CallRecord {
  id: string;
  threadId: string | null;
  kind: ThreadKind;
  orderId: string | null;
  clientId: string;
  dietitianId: string;
  slotId: string | null;
  slotStart: Date;
  slotEnd: Date;
  status: CallStatus;
  channel: CallChannel;
  channelNote: string;
  cancelledBy: 'client' | 'other' | null;
  cancelReason: string;
  rescheduledFrom: Date | null;
  createdAt: Date;
}

export type NewThread = Omit<ThreadRecord, 'id' | 'createdAt' | 'offeredSlots' | 'clientReadAt' | 'otherReadAt' | 'lastMessageAt'> &
  Partial<Pick<ThreadRecord, 'offeredSlots' | 'lastMessageAt'>>;
/** Slots are added through `offerSlots`, so a patch can never rewrite them and lose their ids. */
export type ThreadPatch = Partial<Omit<ThreadRecord, 'id' | 'createdAt' | 'offeredSlots'>>;
export interface SlotOffer { start: Date; end: Date; offeredBy: string }
export type NewMessage = Omit<MessageRecord, 'id' | 'createdAt'> & { orderId?: string | null };
export type NewCall = Omit<CallRecord, 'id' | 'createdAt'>;
export type CallPatch = Partial<Omit<CallRecord, 'id' | 'createdAt'>>;

export interface PageOpts {
  /** Older than this (the previous page's oldest message). */
  before?: Date | undefined;
  /** Newer than this: what an open thread polls with. */
  since?: Date | undefined;
  limit: number;
}
export interface MessagePage {
  messages: MessageRecord[];
  hasMore: boolean;
}

export interface ThreadStore {
  threadById(id: string): Promise<ThreadRecord | null>;
  threadByOrder(orderId: string): Promise<ThreadRecord | null>;
  representativeThread(clientId: string): Promise<ThreadRecord | null>;
  threadsFor(userId: string): Promise<ThreadRecord[]>;
  queuedThreads(): Promise<ThreadRecord[]>;
  createThread(t: NewThread): Promise<ThreadRecord>;
  patchThread(id: string, patch: ThreadPatch): Promise<ThreadRecord | null>;
  /** Adds times to the end of the offer list; existing slots keep their ids. */
  offerSlots(threadId: string, slots: SlotOffer[]): Promise<ThreadRecord | null>;
  /** Marks a slot taken only if it was free, so two bookings cannot share one slot. */
  takeSlot(threadId: string, slotId: string): Promise<boolean>;
  /** Puts a slot back on offer when a booking on it is moved or called off. */
  freeSlot(threadId: string, slotId: string): Promise<void>;
  messages(key: { threadId: string; orderId: string | null }, opts: PageOpts): Promise<MessagePage>;
  addMessage(m: NewMessage): Promise<MessageRecord>;
  unreadFor(t: ThreadRecord, side: ThreadSide): Promise<number>;
  calls(threadId: string): Promise<CallRecord[]>;
  callById(id: string): Promise<CallRecord | null>;
  addCall(c: NewCall): Promise<CallRecord>;
  patchCall(id: string, patch: CallPatch): Promise<CallRecord | null>;
}

const str = (v: unknown): string => String(v ?? '');
const idOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const dateOrNull = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(str(v)) : null);
const date = (v: unknown): Date => dateOrNull(v) ?? new Date(0);

type Doc = Record<string, unknown>;

function toThread(d: Doc): ThreadRecord {
  return {
    id: str(d['_id']),
    kind: (d['kind'] as ThreadKind) ?? 'order',
    clientId: str(d['clientId']),
    orderId: idOrNull(d['orderId']),
    dietitianId: idOrNull(d['dietitianId']),
    assignedStaffId: idOrNull(d['assignedStaffId']),
    queuedAt: dateOrNull(d['queuedAt']),
    assignedAt: dateOrNull(d['assignedAt']),
    clientReadAt: dateOrNull(d['clientReadAt']),
    otherReadAt: dateOrNull(d['otherReadAt']),
    lastMessageAt: dateOrNull(d['lastMessageAt']),
    offeredSlots: ((d['offeredSlots'] as Doc[] | undefined) ?? []).map((s) => ({
      id: str(s['_id']),
      start: date(s['start']),
      end: date(s['end']),
      offeredBy: str(s['offeredBy']),
      taken: s['taken'] === true,
    })),
    createdAt: date(d['createdAt']),
  };
}

function toMessage(d: Doc): MessageRecord {
  return {
    id: str(d['_id']),
    threadId: idOrNull(d['threadId']),
    senderId: str(d['senderId']),
    type: (d['type'] as MessageKind) ?? 'text',
    text: (d['text'] as string | undefined) ?? null,
    planUpdate: d['planUpdate'] ?? null,
    createdAt: date(d['createdAt']),
  };
}

function toCall(d: Doc): CallRecord {
  return {
    id: str(d['_id']),
    threadId: idOrNull(d['threadId']),
    kind: (d['kind'] as ThreadKind) ?? 'order',
    orderId: idOrNull(d['orderId']),
    clientId: str(d['clientId']),
    dietitianId: str(d['dietitianId']),
    slotId: idOrNull(d['slotId']),
    slotStart: date(d['slotStart']),
    slotEnd: date(d['slotEnd']),
    status: (d['status'] as CallStatus) ?? 'requested',
    channel: (d['channel'] as CallChannel) ?? 'they_call',
    channelNote: (d['channelNote'] as string | undefined) ?? '',
    cancelledBy: (d['cancelledBy'] as 'client' | 'other' | null) ?? null,
    cancelReason: (d['cancelReason'] as string | undefined) ?? '',
    rescheduledFrom: dateOrNull(d['rescheduledFrom']),
    createdAt: date(d['createdAt']),
  };
}

/** Messages of an order thread include the plan-update cards an order wrote before the thread existed. */
const messageMatch = (key: { threadId: string; orderId: string | null }): Doc =>
  key.orderId ? { $or: [{ threadId: key.threadId }, { orderId: key.orderId }] } : { threadId: key.threadId };

export const mongoThreadStore: ThreadStore = {
  async threadById(id) {
    const d = await Thread.findById(id).lean();
    return d ? toThread(d as Doc) : null;
  },
  async threadByOrder(orderId) {
    const d = await Thread.findOne({ orderId }).lean();
    return d ? toThread(d as Doc) : null;
  },
  async representativeThread(clientId) {
    const d = await Thread.findOne({ kind: 'representative', clientId }).lean();
    return d ? toThread(d as Doc) : null;
  },
  async threadsFor(userId) {
    const ds = await Thread.find({ $or: [{ clientId: userId }, { dietitianId: userId }, { assignedStaffId: userId }] })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(100)
      .lean();
    return ds.map((d) => toThread(d as Doc));
  },
  async queuedThreads() {
    const ds = await Thread.find({ kind: 'representative', assignedStaffId: null }).sort({ queuedAt: 1 }).limit(100).lean();
    return ds.map((d) => toThread(d as Doc));
  },
  async createThread(t) {
    const d = await Thread.create({ ...t });
    return toThread(d.toObject() as Doc);
  },
  async patchThread(id, patch) {
    const d = await Thread.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    return d ? toThread(d as Doc) : null;
  },
  async offerSlots(threadId, slots) {
    const d = await Thread.findByIdAndUpdate(threadId, { $push: { offeredSlots: { $each: slots.map((s) => ({ ...s, taken: false })) } } }, { new: true }).lean();
    return d ? toThread(d as Doc) : null;
  },
  async takeSlot(threadId, slotId) {
    const r = await Thread.updateOne(
      { _id: threadId, offeredSlots: { $elemMatch: { _id: slotId, taken: false } } },
      { $set: { 'offeredSlots.$.taken': true } },
    );
    return r.modifiedCount === 1;
  },
  async freeSlot(threadId, slotId) {
    await Thread.updateOne({ _id: threadId, 'offeredSlots._id': slotId }, { $set: { 'offeredSlots.$.taken': false } });
  },
  async messages(key, opts) {
    const match = messageMatch(key);
    if (opts.since) {
      const ds = await Message.find({ ...match, createdAt: { $gt: opts.since } }).sort({ createdAt: 1 }).limit(opts.limit).lean();
      return { messages: ds.map((d) => toMessage(d as Doc)), hasMore: ds.length === opts.limit };
    }
    const filter = opts.before ? { ...match, createdAt: { $lt: opts.before } } : match;
    const ds = await Message.find(filter).sort({ createdAt: -1 }).limit(opts.limit + 1).lean();
    const page = ds.slice(0, opts.limit).map((d) => toMessage(d as Doc)).reverse();
    return { messages: page, hasMore: ds.length > opts.limit };
  },
  async addMessage(m) {
    const d = await Message.create({ ...m });
    return toMessage(d.toObject() as Doc);
  },
  async unreadFor(t, side) {
    const sender = side === 'client' ? { senderId: { $ne: t.clientId } } : { senderId: t.clientId };
    const readAt = side === 'client' ? t.clientReadAt : t.otherReadAt;
    const match = messageMatch({ threadId: t.id, orderId: t.orderId });
    return Message.countDocuments({ ...match, ...sender, ...(readAt ? { createdAt: { $gt: readAt } } : {}) });
  },
  async calls(threadId) {
    const ds = await CallBooking.find({ threadId }).sort({ slotStart: 1 }).lean();
    return ds.map((d) => toCall(d as Doc));
  },
  async callById(id) {
    const d = await CallBooking.findById(id).lean();
    return d ? toCall(d as Doc) : null;
  },
  async addCall(c) {
    const d = await CallBooking.create({ ...c });
    return toCall(d.toObject() as Doc);
  },
  async patchCall(id, patch) {
    const d = await CallBooking.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    return d ? toCall(d as Doc) : null;
  },
};

/** In-memory store for tests and local runs with no database. */
export function createMemoryThreadStore(): ThreadStore & { reset(): void } {
  let n = 0;
  // Ids look like real ObjectIds, so routes that validate the shape of an id behave the same here.
  const id = () => (++n).toString(16).padStart(24, 'a');
  let threads: ThreadRecord[] = [];
  let msgs: (MessageRecord & { orderId: string | null })[] = [];
  let calls: CallRecord[] = [];
  const find = (tid: string) => threads.find((t) => t.id === tid) ?? null;
  const mine = (m: { threadId: string | null; orderId: string | null }, key: { threadId: string; orderId: string | null }) =>
    m.threadId === key.threadId || (!!key.orderId && m.orderId === key.orderId);

  return {
    reset() {
      n = 0;
      threads = [];
      msgs = [];
      calls = [];
    },
    async threadById(tid) {
      return find(tid);
    },
    async threadByOrder(orderId) {
      return threads.find((t) => t.orderId === orderId) ?? null;
    },
    async representativeThread(clientId) {
      return threads.find((t) => t.kind === 'representative' && t.clientId === clientId) ?? null;
    },
    async threadsFor(userId) {
      return threads
        .filter((t) => t.clientId === userId || t.dietitianId === userId || t.assignedStaffId === userId)
        .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
    },
    async queuedThreads() {
      return threads.filter((t) => t.kind === 'representative' && !t.assignedStaffId);
    },
    async createThread(t) {
      const rec: ThreadRecord = {
        offeredSlots: [],
        lastMessageAt: null,
        clientReadAt: null,
        otherReadAt: null,
        ...t,
        id: id(),
        createdAt: new Date(),
      };
      threads.push(rec);
      return rec;
    },
    async patchThread(tid, patch) {
      const t = find(tid);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
    async offerSlots(tid, slots) {
      const t = find(tid);
      if (!t) return null;
      for (const s of slots) t.offeredSlots.push({ ...s, id: id(), taken: false });
      return t;
    },
    async takeSlot(tid, slotId) {
      const slot = find(tid)?.offeredSlots.find((s) => s.id === slotId);
      if (!slot || slot.taken) return false;
      slot.taken = true;
      return true;
    },
    async freeSlot(tid, slotId) {
      const slot = find(tid)?.offeredSlots.find((s) => s.id === slotId);
      if (slot) slot.taken = false;
    },
    async messages(key, opts) {
      const all = msgs.filter((m) => mine(m, key)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (opts.since) {
        const after = all.filter((m) => m.createdAt.getTime() > opts.since!.getTime()).slice(0, opts.limit);
        return { messages: after, hasMore: after.length === opts.limit };
      }
      const older = opts.before ? all.filter((m) => m.createdAt.getTime() < opts.before!.getTime()) : all;
      const page = older.slice(Math.max(0, older.length - opts.limit));
      return { messages: page, hasMore: older.length > page.length };
    },
    async addMessage(m) {
      const rec = { ...m, orderId: m.orderId ?? null, id: id(), createdAt: new Date() };
      msgs.push(rec);
      return rec;
    },
    async unreadFor(t, side) {
      const readAt = side === 'client' ? t.clientReadAt : t.otherReadAt;
      return msgs.filter((m) => mine(m, { threadId: t.id, orderId: t.orderId }) && isUnreadFor(side, m, t, readAt)).length;
    },
    async calls(threadId) {
      return calls.filter((c) => c.threadId === threadId).sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime());
    },
    async callById(cid) {
      return calls.find((c) => c.id === cid) ?? null;
    },
    async addCall(c) {
      const rec: CallRecord = { ...c, id: id(), createdAt: new Date() };
      calls.push(rec);
      return rec;
    },
    async patchCall(cid, patch) {
      const c = calls.find((x) => x.id === cid);
      if (!c) return null;
      Object.assign(c, patch);
      return c;
    },
  };
}
