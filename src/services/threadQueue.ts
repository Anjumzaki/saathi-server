/**
 * The waiting queue for Premium Plus threads. A thread she opens waits until a Saathi dietitian picks it
 * up; nothing here promises a reply time, because there is no roster behind it yet.
 */

export const QUEUE_EXPECTATION_HOURS = 24;

export interface QueuedThread {
  id: string;
  queuedAt: Date | null;
  assignedStaffId: string | null;
  assignedAt: Date | null;
}

export type QueueState = 'waiting' | 'late' | 'assigned';

export interface QueueView {
  state: QueueState;
  /** Plain line for the screen. Honest: an expectation, never a guarantee. */
  text: string;
  waitingHours: number;
}

export function queueView(t: QueuedThread, now: Date): QueueView {
  if (t.assignedStaffId) return { state: 'assigned', text: 'A Saathi dietitian is on this thread with you.', waitingHours: 0 };
  const waitingHours = t.queuedAt ? (now.getTime() - t.queuedAt.getTime()) / 3_600_000 : 0;
  if (waitingHours > QUEUE_EXPECTATION_HOURS) {
    return { state: 'late', text: 'No one has answered yet, and it has taken longer than it should. Your message is still in the queue.', waitingHours };
  }
  return { state: 'waiting', text: 'Write whenever you like. A Saathi dietitian usually replies within a day.', waitingHours };
}

/** Oldest wait first, so nobody is overtaken. */
export function pickNextQueued<T extends QueuedThread>(threads: T[]): T | null {
  const waiting = threads.filter((t) => !t.assignedStaffId && t.queuedAt);
  if (!waiting.length) return null;
  return waiting.reduce((a, b) => (a.queuedAt!.getTime() <= b.queuedAt!.getTime() ? a : b));
}

/** The patch that assigns a thread. Returns null when someone else already took it. */
export function assignment(t: QueuedThread, staffId: string, now: Date): { assignedStaffId: string; assignedAt: Date } | null {
  if (t.assignedStaffId) return null;
  return { assignedStaffId: staffId, assignedAt: now };
}
