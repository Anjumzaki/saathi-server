/**
 * Saathi Pro: her professional profile and where it stands with the reviewer. Pure — no database here,
 * so the routes and the tests share exactly the same rules.
 */
import { z } from 'zod';
import { canVerificationTransition, readyToSubmit, type DocRef, type VerificationStatus } from './verification';

/** What she may tell us about herself. Everything optional is genuinely optional. */
export const proProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(100),
  bio: z.string().trim().max(2000).optional(),
  /** Her qualifications, in her own words ("BSc Nutrition, RD"). */
  credentials: z.string().trim().max(500).optional(),
  specialties: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  languages: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  yearsOfPractice: z.number().int().min(0).max(60).optional(),
  countries: z.array(z.string().trim().length(2).toUpperCase()).max(50).default([]),
  cities: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  /** The server's price bands she works in. Prices themselves are set per band by Saathi, never here. */
  bandIds: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
  photoRef: z.string().trim().max(500).optional(),
  payoutAccountRef: z.string().trim().max(500).optional(),
});
export type ProProfileInput = z.infer<typeof proProfileSchema>;

/** Duplicates (the same city typed twice) are dropped rather than refused. */
export function tidyProfile(input: ProProfileInput): ProProfileInput {
  const uniq = (xs: string[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];
  return { ...input, specialties: uniq(input.specialties), languages: uniq(input.languages), countries: uniq(input.countries), cities: uniq(input.cities), bandIds: [...new Set(input.bandIds)] };
}

/** Bands she asked for that Saathi does not offer (or has retired). */
export const unknownBands = (asked: string[], active: string[]): string[] => asked.filter((b) => !active.includes(b));

// ---------- is it ready to send? ----------

export interface ProfileLike {
  displayName?: string | null;
  credentials?: string | null;
  specialties?: string[];
  languages?: string[];
  yearsOfPractice?: number | null;
  countries?: string[];
  cities?: string[];
  bandIds?: string[];
}

/** Named in her words, so the app can list what is left without inventing its own copy. */
export const PROFILE_REQUIREMENTS = [
  { field: 'displayName', label: 'Your name' },
  { field: 'credentials', label: 'Your qualifications' },
  { field: 'specialties', label: 'What you work with' },
  { field: 'languages', label: 'Languages you speak' },
  { field: 'yearsOfPractice', label: 'Years of practice' },
  { field: 'places', label: 'Where you work' },
  { field: 'bandIds', label: 'Your prices' },
] as const;
export type ProfileField = (typeof PROFILE_REQUIREMENTS)[number]['field'];

export interface Completeness {
  missing: { field: ProfileField; label: string }[];
  ready: boolean;
}

export function profileCompleteness(p: ProfileLike): Completeness {
  const has: Record<ProfileField, boolean> = {
    displayName: !!p.displayName?.trim(),
    credentials: !!p.credentials?.trim(),
    specialties: (p.specialties ?? []).length > 0,
    languages: (p.languages ?? []).length > 0,
    yearsOfPractice: typeof p.yearsOfPractice === 'number' && p.yearsOfPractice >= 0,
    // A city or a country is enough: some work across a country, some in one city.
    places: (p.countries ?? []).length > 0 || (p.cities ?? []).length > 0,
    bandIds: (p.bandIds ?? []).length > 0,
  };
  const missing = PROFILE_REQUIREMENTS.filter((r) => !has[r.field]).map((r) => ({ field: r.field, label: r.label }));
  return { missing, ready: missing.length === 0 };
}

// ---------- where the application stands ----------

/**
 * What she is shown. The stored statuses are the reviewer's; `more_info` is a rejection the reviewer
 * wants answered rather than a final no, which is why it is derived and not a sixth stored status.
 */
export type ProReviewState = 'draft' | 'submitted' | 'in_review' | 'more_info' | 'approved' | 'rejected';
export type ReviewOutcome = 'changes_requested' | 'declined';

export interface ReviewView {
  state: ProReviewState;
  /** The reviewer's own words, or null. Never summarised or softened. */
  note: string | null;
  canEdit: boolean;
  canSubmit: boolean;
  /** Nothing more for her to do. */
  settled: boolean;
}

const EDITABLE: VerificationStatus[] = ['draft', 'rejected'];
export const canEditProfile = (status: VerificationStatus): boolean => EDITABLE.includes(status);

export function reviewStateOf(p: { status: VerificationStatus; reviewNote?: string | null; reviewOutcome?: ReviewOutcome | null }): ReviewView {
  const note = p.reviewNote?.trim() ? p.reviewNote.trim() : null;
  const state: ProReviewState =
    p.status !== 'rejected'
      ? p.status
      // The reviewer's own outcome wins; without one, a note means she was asked for something.
      : p.reviewOutcome === 'declined'
        ? 'rejected'
        : p.reviewOutcome === 'changes_requested' || note
          ? 'more_info'
          : 'rejected';
  return {
    state,
    note,
    canEdit: canEditProfile(p.status),
    canSubmit: canVerificationTransition(p.status, 'submitted'),
    settled: p.status === 'approved',
  };
}

/** One line for the top of her Pro screens. Honest about who is waiting on whom. */
export function reviewHeadline(v: ReviewView): string {
  switch (v.state) {
    case 'draft': return 'Not sent yet';
    case 'submitted': return 'Sent for review';
    case 'in_review': return 'Being reviewed';
    case 'more_info': return 'More information needed';
    case 'approved': return 'Approved';
    case 'rejected': return 'Not approved';
  }
}

export function reviewBody(v: ReviewView): string {
  switch (v.state) {
    case 'draft': return 'Finish your profile and add your documents, then send it for review.';
    case 'submitted': return 'Someone at Saathi will look at it. You cannot change it while it is with them.';
    case 'in_review': return 'A reviewer is reading it now. You cannot change it while it is with them.';
    case 'more_info': return 'Read the note below, change what it asks for, and send it again.';
    case 'approved': return 'Clients can find you and order a plan from you.';
    case 'rejected': return 'You can change your profile and send it again.';
  }
}

// ---------- submitting ----------

export type SubmitBlock = 'wrong_status' | 'profile_incomplete' | 'documents_missing';

/** Everything that stops a submission, in the order she should fix it. Null means it can go. */
export function submitBlock(p: ProfileLike & { status: VerificationStatus; documents: Pick<DocRef, 'kind' | 'deletedAt'>[] }): SubmitBlock | null {
  if (!canVerificationTransition(p.status, 'submitted')) return 'wrong_status';
  if (!profileCompleteness(p).ready) return 'profile_incomplete';
  if (!readyToSubmit(p.documents)) return 'documents_missing';
  return null;
}

export function submitBlockMessage(b: SubmitBlock): string {
  if (b === 'wrong_status') return 'This application is already with the reviewer.';
  if (b === 'profile_incomplete') return 'Fill in the rest of your profile first.';
  return 'Add a government ID and a licence or certificate first.';
}

// ---------- documents ----------

export interface DocumentLike extends DocRef {
  _id?: unknown;
  mime?: string | null;
  bytes?: number | null;
  uploadedAt?: Date | null;
}

/** Most documents per application, so one account cannot fill the disk. */
export const MAX_DOCUMENTS = 8;

/** What she still holds: a purged government ID is gone and is not offered back. */
export const liveDocuments = <T extends Pick<DocRef, 'deletedAt'>>(docs: T[]): T[] => docs.filter((d) => !d.deletedAt);

export type DocumentProblem = 'too_many' | 'not_found' | 'already_deleted';

/** Can another document be added, given what is already there? */
export function canAddDocument(docs: Pick<DocRef, 'deletedAt'>[], replacing: boolean): DocumentProblem | null {
  if (replacing) return null; // a replacement takes the place of one that is already counted
  return liveDocuments(docs).length >= MAX_DOCUMENTS ? 'too_many' : null;
}

export function documentProblemMessage(p: DocumentProblem): string {
  if (p === 'too_many') return `You can keep ${MAX_DOCUMENTS} documents. Replace one instead.`;
  if (p === 'already_deleted') return 'That document has already been removed.';
  return 'We could not find that document.';
}

/** What the app is told about a document. The storage key never leaves the server. */
export interface DocumentView {
  id: string;
  kind: DocRef['kind'];
  mime: string | null;
  bytes: number | null;
  uploadedAt: Date | null;
  /** True once the government ID has been purged after review, so the app can say so plainly. */
  removed: boolean;
}

export function documentView(d: DocumentLike): DocumentView {
  return {
    id: String(d._id ?? ''),
    kind: d.kind,
    mime: d.mime ?? null,
    bytes: d.bytes ?? null,
    uploadedAt: d.uploadedAt ?? null,
    removed: !!d.deletedAt,
  };
}
