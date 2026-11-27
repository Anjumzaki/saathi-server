/** Who may read a thread. A thread has exactly two sides and no third reader, not even an admin. */
import type { Feature } from './entitlement';
import type { ThreadKind } from '../models/Message';

/**
 * The role a Saathi dietitian needs to answer Premium Plus threads. Nobody holds it yet, so the queue
 * simply waits until the role is added to the user record.
 */
export const SAATHI_STAFF_ROLE = 'saathi_dietitian';

export type ThreadSide = 'client' | 'other';

export interface ThreadSides {
  kind: ThreadKind;
  clientId: string;
  dietitianId: string | null;
  assignedStaffId: string | null;
}

/** The user on the other side of the thread from her, or null while a Plus thread is still waiting. */
export function otherUserIdOf(t: ThreadSides): string | null {
  return t.kind === 'order' ? t.dietitianId : t.assignedStaffId;
}

/**
 * Her side, the other side, or null. Null means not a participant: the route must then answer as if the
 * thread does not exist, so no one can learn it is there. Admin roles get no side on purpose — a
 * private conversation is not an admin tool.
 */
export function sideOf(t: ThreadSides, userId: string): ThreadSide | null {
  if (userId === t.clientId) return 'client';
  if (userId && userId === otherUserIdOf(t)) return 'other';
  return null;
}

export const canRead = (t: ThreadSides, userId: string): boolean => sideOf(t, userId) !== null;

/** The entitlement a thread kind needs from her. Order threads need only that she bought the order. */
export function featureForThreadKind(kind: ThreadKind): Feature | null {
  return kind === 'representative' ? 'representative_help' : null;
}

/**
 * Unread for a side, counted from that side's read mark. Her unread are the messages she did not send;
 * the other side's unread are the ones she did.
 */
export function isUnreadFor(
  side: ThreadSide,
  message: { senderId: string; createdAt: Date },
  t: { clientId: string },
  readAt: Date | null,
): boolean {
  const fromHer = message.senderId === t.clientId;
  if (side === 'client' ? fromHer : !fromHer) return false;
  return !readAt || message.createdAt.getTime() > readAt.getTime();
}
