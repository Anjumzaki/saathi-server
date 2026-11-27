/** Pure partner-sharing rules. */
import { DAY, HOUR, utcDayKey } from '../utils/time';

export const INVITE_TTL_MS = 48 * HOUR;

export interface PartnerPermissions {
  effortRing: boolean;
  mealsLogged: boolean;
  waterWalk: boolean;
  weight: boolean;
  /** When true the partner receives ONLY shared "together" nudges, never any stats. */
  togetherNudgesOnly: boolean;
  /** Additive: lets the partner see that tonight is a Together evening. Never dates, phases or symptoms. */
  together?: boolean;
}

export const inviteExpiry = (now: Date): Date => new Date(now.getTime() + INVITE_TTL_MS);
export const isInviteValid = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() > now.getTime();

/** One cheer per UTC day per share. */
export function canCheer(lastCheerAt: Date | null | undefined, now: Date): boolean {
  return !lastCheerAt || utcDayKey(lastCheerAt) !== utcDayKey(now);
}

/**
 * Free preview (decided 26 Nov 2026): when someone she invites accepts, that person sees her day free for
 * PREVIEW_DAYS days. After that they need a package of their own. The window is counted from the moment the
 * invite was accepted and stored on the share, so a changed phone clock cannot extend it.
 */
export const PREVIEW_DAYS = 3;
export const PREVIEW_MS = PREVIEW_DAYS * DAY;

/**
 * Whether SHE needs a package to invite someone at all. Open question for Anjum; today sending is free, so
 * flipping this one line is the whole change (the server refuses POST /partner/invites with "premium_required"
 * and the app sends her to the Paywall).
 */
export const SENDING_REQUIRES_PACKAGE = false;

/** Where the viewer stands on one share. 'paused' means the preview ran out and they have no package. */
export type PartnerAccessState = 'invited' | 'preview' | 'active' | 'paused';

export interface PartnerAccess {
  state: PartnerAccessState;
  previewEndsAt: Date | null;
  /** Whole days of preview still to come, counting today; 1 on the last day, 0 once it has run out. */
  daysLeft: number;
  /** Last day of the preview: the app shows the Paywall. */
  lastPreviewDay: boolean;
  /** The only thing that decides whether the day may be read. */
  canSeeDay: boolean;
}

export const previewEnd = (acceptedAt: Date): Date => new Date(acceptedAt.getTime() + PREVIEW_MS);

export function previewDaysLeft(previewEndsAt: Date | null | undefined, now: Date): number {
  if (!previewEndsAt) return 0;
  const ms = previewEndsAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY);
}

export interface ShareAccessInput {
  status: string;
  previewEndsAt?: Date | null | undefined;
}

/**
 * The single rule every partner route and both screens follow. A package always wins (that is how paying
 * resumes a paused connection); without one, the day is readable only inside the preview window.
 */
export function partnerAccess(share: ShareAccessInput, viewerHasPackage: boolean, now: Date): PartnerAccess {
  const previewEndsAt = share.previewEndsAt ?? null;
  if (share.status === 'pending' || !previewEndsAt) {
    return { state: share.status === 'pending' ? 'invited' : 'paused', previewEndsAt, daysLeft: 0, lastPreviewDay: false, canSeeDay: false };
  }
  if (viewerHasPackage) return { state: 'active', previewEndsAt, daysLeft: 0, lastPreviewDay: false, canSeeDay: true };
  const daysLeft = previewDaysLeft(previewEndsAt, now);
  if (daysLeft <= 0) return { state: 'paused', previewEndsAt, daysLeft: 0, lastPreviewDay: false, canSeeDay: false };
  return { state: 'preview', previewEndsAt, daysLeft, lastPreviewDay: daysLeft === 1, canSeeDay: true };
}
