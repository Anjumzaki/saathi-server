/**
 * Her side of an order: what she owes this client, and by when. Pure.
 *
 * The deadline is not a new rule — it is the refund window the client already has. If she has not
 * delivered by then the order refunds itself, so that is the date she needs to see.
 */
import { HOUR } from '../utils/time';
import type { OrderStatus } from './orderState';

export interface ClientOrderRow {
  status: OrderStatus;
  paidAt?: Date | null;
  startedAt?: Date | null;
  deliveredAt?: Date | null;
  releasedAt?: Date | null;
  planId?: unknown;
}

/** What she has to do next, in her words. */
export type ProTodo = 'nothing' | 'wait_for_payment' | 'start' | 'write_plan' | 'deliver' | 'done';

export interface ClientOrderView {
  todo: ProTodo;
  owes: string;
  /** When the client gets an automatic refund if nothing has been delivered. Null once delivered. */
  dueAt: Date | null;
  overdue: boolean;
  canStart: boolean;
  canDeliver: boolean;
  canPublish: boolean;
  canSeeClientData: boolean;
}

const ACTIVE: OrderStatus[] = ['paid', 'in_progress', 'delivered'];

export function clientOrderView(o: ClientOrderRow, now: Date, refundWindowHours: number): ClientOrderView {
  const dueAt = o.paidAt && !o.deliveredAt && (o.status === 'paid' || o.status === 'in_progress')
    ? new Date(o.paidAt.getTime() + refundWindowHours * HOUR)
    : null;
  const hasPlan = !!o.planId;
  const todo: ProTodo =
    o.status === 'requested' ? 'wait_for_payment'
    : o.status === 'paid' ? 'start'
    : o.status === 'in_progress' ? (hasPlan ? 'deliver' : 'write_plan')
    : o.status === 'delivered' || o.status === 'released' ? 'done'
    : 'nothing';
  return {
    todo,
    owes: owedLine(todo),
    dueAt,
    overdue: !!dueAt && dueAt.getTime() <= now.getTime(),
    canStart: o.status === 'paid',
    canDeliver: o.status === 'in_progress' && hasPlan,
    canPublish: ACTIVE.includes(o.status),
    canSeeClientData: ACTIVE.includes(o.status),
  };
}

export function owedLine(todo: ProTodo): string {
  switch (todo) {
    case 'wait_for_payment': return 'Waiting for her to pay. Nothing for you to do yet.';
    case 'start': return 'She has paid. Open her answers and start.';
    case 'write_plan': return 'Write her week and send it.';
    case 'deliver': return 'Her plan is with her. Mark the order delivered.';
    case 'done': return 'Delivered. Nothing outstanding.';
    case 'nothing': return 'This order is closed.';
  }
}

/** "3 days left" / "2 days late", from the refund deadline. Null when there is no deadline. */
export function dueLine(dueAt: Date | null, now: Date): string | null {
  if (!dueAt) return null;
  const hours = Math.round((dueAt.getTime() - now.getTime()) / HOUR);
  if (hours < 0) {
    const late = Math.abs(hours);
    return late >= 24 ? `${Math.floor(late / 24)} day${Math.floor(late / 24) === 1 ? '' : 's'} late` : `${late} hour${late === 1 ? '' : 's'} late`;
  }
  if (hours >= 24) return `${Math.floor(hours / 24)} day${Math.floor(hours / 24) === 1 ? '' : 's'} left`;
  return `${hours} hour${hours === 1 ? '' : 's'} left`;
}
