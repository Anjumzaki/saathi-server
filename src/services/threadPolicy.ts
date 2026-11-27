/** Pure rules for chat and call bookings: paging sizes, the notice period, and the two product defaults. */
import type { CallChannel } from '../models/CallBooking';

export const MESSAGE_PAGE_SIZE = 30;
export const MESSAGE_PAGE_MAX = 100;

/**
 * A plan written by a Saathi representative is included in Premium Plus at no extra charge.
 * Reversible assumption: flip this to false and a request would have to be priced and paid for first.
 */
export const SAATHI_PLAN_INCLUDED_IN_PLUS = true;

/**
 * Representative chat and calls are available during the 7-day trial. The only features the trial holds
 * back are the dietitian and merchant discounts (PAID_ONLY_FEATURES in ./entitlement).
 * Reversible assumption: to hold chat back too, add 'representative_help' to PAID_ONLY_FEATURES.
 */
export const REPRESENTATIVE_HELP_IN_TRIAL = true;

/** How much warning either side must give to move or call off a booked time. */
export const CALL_CHANGE_NOTICE_HOURS = 4;

export const hoursUntil = (when: Date, now: Date): number => (when.getTime() - now.getTime()) / 3_600_000;

/** True while there is still enough notice to cancel or move a booking. */
export function canChangeCall(slotStart: Date, now: Date, noticeHours: number = CALL_CHANGE_NOTICE_HOURS): boolean {
  return hoursUntil(slotStart, now) >= noticeHours;
}

/** Said in full wherever a change is refused, so the number is never a surprise. */
export function noticeMessage(noticeHours: number = CALL_CHANGE_NOTICE_HOURS): string {
  return `Calls can be changed up to ${noticeHours} hours before they start. Send a message instead and she will see it.`;
}

/** What she is told about joining. There is no in-app call, so this only ever describes a phone call. */
export function channelNote(channel: CallChannel, phone: string | null): string {
  if (channel === 'she_calls') return phone ? `You will call on ${phone}` : 'You will call on the number she shares with you';
  return phone ? `She will call you on ${phone}` : 'She will call you on the number on your account';
}

/** A slot she may still book: in the future and not already taken. */
export function isBookableSlot(slot: { start: Date; taken: boolean }, now: Date): boolean {
  return !slot.taken && slot.start.getTime() > now.getTime();
}
