/**
 * Erasing a deleted account for good.
 *
 * `DELETE /me` strips her name, email and phone from the user row straight away and clears the big
 * collections, but several collections keyed on her id were never touched, so her day summaries, push
 * tokens and the labels she typed herself outlived the account. The privacy page promises "the server
 * copy within 30 days", and this is the job that makes that true.
 *
 * Three rules shape every step below.
 *
 * 1. A step is a filter plus an operation, never a read-modify-write, so running it twice is the same as
 *    running it once and a run that dies half way is simply run again.
 * 2. Where a row belongs to two people, only her side goes. The other woman keeps her share, the
 *    dietitian keeps the record of the order she delivered.
 * 3. Where a row must survive (money, tax), it is anonymised in place: nothing is left on it that names
 *    her, and no store credential stays behind that could be used to ask Google or Apple about her.
 */
import { Types } from 'mongoose';
import { CallBooking } from '../models/CallBooking';
import { UserOption } from '../models/Dataset';
import { DaySummary } from '../models/DaySummary';
import { DeviceToken } from '../models/DeviceToken';
import { DietitianProfile } from '../models/DietitianProfile';
import { Message, Thread } from '../models/Message';
import { Order } from '../models/Order';
import { Otp } from '../models/Otp';
import { Cheer, PartnerShare } from '../models/PartnerShare';
import { Plan } from '../models/Plan';
import { RefreshToken } from '../models/RefreshToken';
import { StoreEvent } from '../models/StoreEvent';
import { SyncRecord } from '../models/SyncRecord';
import { User } from '../models/User';
import { getFileStore } from './fileStore';
import { emailChangeOtpKeyPrefix } from './users';
import { log } from '../utils/logger';

/** The grace period the privacy page promises before the server copy goes. */
export const PURGE_AFTER_DAYS = 30;
export const purgeCutoff = (now: Date = new Date()): Date => new Date(now.getTime() - PURGE_AFTER_DAYS * 24 * 3_600_000);

/** Collections the purge touches. Named rather than passed as models so a step can be read and asserted on. */
export const PURGE_COLLECTIONS = [
  'SyncRecord', 'Plan', 'DaySummary', 'DeviceToken', 'UserOption', 'RefreshToken', 'Otp', 'Cheer',
  'PartnerShare', 'Thread', 'Message', 'CallBooking', 'Order', 'StoreEvent', 'DietitianProfile', 'User',
] as const;
export type PurgeColl = (typeof PURGE_COLLECTIONS)[number];

export interface PurgeStep {
  /** Short name, used as the key in the count the job returns. */
  readonly name: string;
  readonly coll: PurgeColl;
  readonly op: 'delete' | 'anonymise';
  readonly filter: Record<string, unknown>;
  /** Set on an `anonymise` step only. */
  readonly update?: Record<string, unknown>;
  /** Why a row survives, kept next to the step so the reason and the code cannot drift apart. */
  readonly keeps?: string;
}

/**
 * Everything that happens to one account, in order. Pure, so the whole policy can be read in one place
 * and tested without a database.
 *
 * `threadIds` are the threads where she is the client; her messages are found through them because a
 * message carries no user id but the one on the sender.
 */
export function purgePlan(userId: string, threadIds: readonly string[] = []): PurgeStep[] {
  const id = userId;
  return [
    // ---- hers alone: erased ----
    { name: 'syncRecords', coll: 'SyncRecord', op: 'delete', filter: { userId: id } },
    { name: 'plans', coll: 'Plan', op: 'delete', filter: { userId: id } },
    { name: 'daySummaries', coll: 'DaySummary', op: 'delete', filter: { userId: id } },
    { name: 'deviceTokens', coll: 'DeviceToken', op: 'delete', filter: { userId: id } },
    { name: 'ownDatasetOptions', coll: 'UserOption', op: 'delete', filter: { userId: id } },
    { name: 'refreshTokens', coll: 'RefreshToken', op: 'delete', filter: { userId: id } },
    { name: 'phoneCodes', coll: 'Otp', op: 'delete', filter: { key: { $regex: `^phone:${id}:` } } },
    { name: 'emailChangeCodes', coll: 'Otp', op: 'delete', filter: { key: { $regex: `^${emailChangeOtpKeyPrefix(id)}` } } },
    // A cheer carries the id of whoever sent it, so one she sent cannot stay on another woman's wall.
    { name: 'cheers', coll: 'Cheer', op: 'delete', filter: { $or: [{ fromUserId: id }, { toUserId: id }] } },
    // Her own sharing arrangements, and the invite hashes in them.
    { name: 'sharesSheOwned', coll: 'PartnerShare', op: 'delete', filter: { ownerId: id } },

    // ---- the other side of a two-sided row: she is detached, the row stays with its owner ----
    {
      name: 'sharesSheWatched', coll: 'PartnerShare', op: 'anonymise',
      filter: { partnerId: id },
      update: { $set: { partnerId: null, status: 'revoked', inviteTokenHash: null }, $unset: { acceptedAt: '', previewEndsAt: '' } },
      keeps: 'another woman set this share up; she only loses the person who was cheering her on',
    },

    // ---- chat: her threads and every message in them go; threads that are not hers lose only her ----
    { name: 'messagesInHerThreads', coll: 'Message', op: 'delete', filter: { threadId: { $in: [...threadIds] } } },
    { name: 'messagesSheSent', coll: 'Message', op: 'delete', filter: { senderId: id } },
    { name: 'herThreads', coll: 'Thread', op: 'delete', filter: { clientId: id } },
    {
      name: 'threadsSheAnswered', coll: 'Thread', op: 'anonymise',
      filter: { $or: [{ dietitianId: id }, { assignedStaffId: id }] },
      update: { $set: { dietitianId: null, assignedStaffId: null }, $pull: { offeredSlots: { offeredBy: new Types.ObjectId(id) } } },
      keeps: 'she was the dietitian on another woman\'s thread; that conversation is the client\'s',
    },

    // ---- calls ----
    {
      name: 'herCalls', coll: 'CallBooking', op: 'delete', filter: { clientId: id },
      keeps: 'nothing: the phone number and the note on a booking are hers, and the order records the delivery',
    },

    // ---- money: kept, with nothing of hers left on it ----
    {
      name: 'ordersSheBought', coll: 'Order', op: 'anonymise',
      filter: { clientId: id },
      update: { $unset: { purchaseToken: '' } },
      keeps: 'the dietitian\'s record of work delivered and the figures Anjum must keep for tax; the store credential is not needed for either',
    },
    {
      name: 'storeEvents', coll: 'StoreEvent', op: 'anonymise',
      filter: { userId: id },
      update: { $set: { userId: null }, $unset: { purchaseToken: '', originalTransactionId: '' } },
      keeps: 'the billing audit trail for a charge she disputed; it no longer points at her or at her store account',
    },

    // ---- professional record, if she was a dietitian. The stored documents go first (see purgeAccount). ----
    { name: 'dietitianProfile', coll: 'DietitianProfile', op: 'delete', filter: { userId: id } },

    /**
     * The row itself stays as an empty marker, because an order keeps her id and a dangling reference is
     * worse than one that resolves to "an account that was deleted". Everything that could name her or
     * sign her in is gone, the password hash included.
     */
    {
      name: 'account', coll: 'User', op: 'anonymise',
      filter: { _id: id },
      update: {
        $set: { roles: [], phoneVerified: false, failedLogins: 0, subscription: { status: 'none' }, purgedAt: new Date() },
        $unset: {
          email: '', displayName: '', phone: '', googleSub: '', appleSub: '', country: '', timezone: '',
          passwordHash: '', emailVerifiedAt: '', termsAcceptedAt: '', termsVersion: '', loginLockedUntil: '',
        },
      },
      keeps: 'an empty marker, so the orders that reference her still resolve',
    },
  ];
}

/** What the executor needs. Narrow on purpose: a fake of this is the whole test harness. */
export interface PurgeOps {
  /** Accounts whose grace period has run out and that have not been purged yet, oldest first. */
  dueAccounts(cutoff: Date, limit: number): Promise<string[]>;
  ids(coll: PurgeColl, filter: Record<string, unknown>): Promise<string[]>;
  deleteMany(coll: PurgeColl, filter: Record<string, unknown>): Promise<number>;
  updateMany(coll: PurgeColl, filter: Record<string, unknown>, update: Record<string, unknown>): Promise<number>;
  /**
   * Every stored object that belongs to her: the documents and photo on a dietitian profile, and the
   * photos in her chats. The bytes go before the rows that point at them.
   */
  storedFiles(userId: string, threadIds: readonly string[]): Promise<string[]>;
  removeFile(ref: string): Promise<void>;
}

export interface PurgeResult {
  /** Accounts erased in this run. */
  accounts: number;
  /** Accounts left for the next run because something failed. */
  failed: number;
  /** Stored documents (licences, government ID) deleted. */
  files: number;
  /** Rows erased or anonymised, per step, so a run can be read rather than trusted. */
  counts: Record<string, number>;
}

/**
 * One account. The order matters in one place only: a stored document is deleted before the row that
 * holds its reference, so a failure half way leaves a reference to try again rather than bytes in the
 * bucket that nothing points at. Everything else is independent and idempotent.
 */
export async function purgeAccount(ops: PurgeOps, userId: string): Promise<{ counts: Record<string, number>; files: number }> {
  const counts: Record<string, number> = {};
  let files = 0;
  const threadIds = await ops.ids('Thread', { clientId: userId });
  for (const ref of await ops.storedFiles(userId, threadIds)) {
    if (!ref || ref === 'purged') continue;
    await ops.removeFile(ref);
    files++;
  }
  for (const step of purgePlan(userId, threadIds)) {
    // An empty $in matches nothing; skip it rather than ask the database.
    if (step.name === 'messagesInHerThreads' && threadIds.length === 0) { counts[step.name] = 0; continue; }
    const n = step.op === 'delete'
      ? await ops.deleteMany(step.coll, step.filter)
      : await ops.updateMany(step.coll, step.filter, step.update ?? {});
    counts[step.name] = (counts[step.name] ?? 0) + n;
  }
  return { counts, files };
}

/**
 * The job. Takes a batch of due accounts so one run is bounded, and returns what it did; an account that
 * throws is left due, so the next run picks it up instead of leaving half of her behind.
 */
export async function purgeDeletedAccounts(
  ops: PurgeOps,
  opts: { now?: Date; limit?: number } = {},
): Promise<PurgeResult> {
  const { now = new Date(), limit = 200 } = opts;
  const due = await ops.dueAccounts(purgeCutoff(now), limit);
  const out: PurgeResult = { accounts: 0, failed: 0, files: 0, counts: {} };
  for (const userId of due) {
    try {
      const { counts, files } = await purgeAccount(ops, userId);
      out.accounts++;
      out.files += files;
      for (const [k, v] of Object.entries(counts)) out.counts[k] = (out.counts[k] ?? 0) + v;
    } catch (e) {
      out.failed++;
      // No user id in the log line: a deleted account is not something to write into stdout.
      log.error('account purge failed', { message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * The three calls the executor makes on a model. Sixteen Mongoose models in one map produce a union
 * TypeScript will not represent, so the map is typed down to what is actually used.
 */
interface PurgeableModel {
  find(filter: Record<string, unknown>): { select(fields: string): { lean(): Promise<{ _id: unknown }[]> } };
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ modifiedCount?: number }>;
}
const MODELS = {
  SyncRecord, Plan, DaySummary, DeviceToken, UserOption, RefreshToken, Otp, Cheer,
  PartnerShare, Thread, Message, CallBooking, Order, StoreEvent, DietitianProfile, User,
} as unknown as Record<PurgeColl, PurgeableModel>;

/**
 * The real thing, against Mongo.
 *
 * The user row is read and written through the raw collection, as `DELETE /me` already does: `purgedAt`
 * is the marker that keeps a second run from walking over accounts that are already empty, and it is not
 * in the schema yet (see qa/wiring/privacy.md).
 */
export function mongoPurgeOps(): PurgeOps {
  const objectId = (v: string) => new Types.ObjectId(v);
  return {
    async dueAccounts(cutoff, limit) {
      const rows = await User.collection
        .find({ deletedAt: { $ne: null, $lte: cutoff }, purgedAt: null }, { projection: { _id: 1 }, sort: { deletedAt: 1 }, limit })
        .toArray();
      return rows.map((r) => String(r._id));
    },
    async ids(coll, filter) {
      const rows = await MODELS[coll].find(filter).select('_id').lean();
      return rows.map((r) => String(r._id));
    },
    async deleteMany(coll, filter) {
      const r = await MODELS[coll].deleteMany(filter);
      return r.deletedCount ?? 0;
    },
    async updateMany(coll, filter, update) {
      // The marker is not on the schema, so the account step goes through the raw collection.
      if (coll === 'User') {
        const r = await User.collection.updateMany({ _id: objectId(String(filter['_id'])) }, update as never);
        return r.modifiedCount ?? 0;
      }
      const r = await MODELS[coll].updateMany(filter, update);
      return r.modifiedCount ?? 0;
    },
    async storedFiles(userId, threadIds) {
      const profile = (await DietitianProfile.findOne({ userId }).select('documents.ref photoRef').lean()) as
        | { photoRef?: string | null; documents?: { ref?: string }[] }
        | null;
      // A photo she sent in a chat is as much hers as a licence she uploaded.
      const messages = (await Message.find({ $or: [{ senderId: userId }, { threadId: { $in: [...threadIds] } }] })
        .select('photoRef')
        .lean()) as { photoRef?: string | null }[];
      const refs = [
        ...(profile?.documents ?? []).map((d) => d.ref),
        profile?.photoRef,
        ...messages.map((m) => m.photoRef),
      ];
      return [...new Set(refs.filter((r): r is string => !!r && r !== 'purged'))];
    },
    async removeFile(ref) {
      await getFileStore().remove(ref);
    },
  };
}
