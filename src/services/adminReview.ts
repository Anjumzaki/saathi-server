/**
 * What a reviewer may do to a dietitian's application, and what a reviewer may see of it. Pure: the
 * route holds the database and the bytes, so the rules a reviewer is held to can be tested on their own
 * and the review tool can be told, rather than guess, which decisions it must not offer.
 */
import { documentView, type DocumentLike, type DocumentView, type ReviewOutcome } from './dietitianProfile';
import { dietitianScope, keyBelongsTo } from './fileStore';
import { GOV_ID_RETENTION_DAYS, canVerificationTransition, type VerificationStatus } from './verification';

/** The statuses a reviewer can write. `submitted` is hers to set, never ours. */
export const REVIEW_DECISIONS = ['in_review', 'approved', 'rejected'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * A reviewer thinks in actions, not statuses: "decline" and "ask for more information" are both the
 * `rejected` status and differ only in the outcome she is shown.
 */
export const REVIEW_ACTIONS = ['start', 'approve', 'more_info', 'decline'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export interface ReviewActionView {
  action: ReviewAction;
  label: string;
  decision: ReviewDecision;
  outcome: ReviewOutcome | null;
  /** What it does to her, in plain words, before the reviewer commits to it. */
  effect: string;
  /** The application can never leave the state this puts it in. */
  irreversible: boolean;
  /** Starts the retention clock on her government ID, whatever happens next. */
  deletesGovernmentId: boolean;
  /** She is owed a reason, so the tool must not send this one empty. */
  noteRequired: boolean;
}

const GOV_ID_LINE = `Her government ID is deleted ${GOV_ID_RETENTION_DAYS} days from now.`;

const ACTIONS: Record<ReviewAction, Omit<ReviewActionView, 'action'>> = {
  start: {
    label: 'Start reviewing',
    decision: 'in_review',
    outcome: null,
    effect: 'Says a reviewer has it now. She cannot change it while you hold it, and you cannot put it back to waiting.',
    irreversible: false,
    deletesGovernmentId: false,
    noteRequired: false,
  },
  approve: {
    label: 'Approve',
    decision: 'approved',
    outcome: null,
    effect: `She becomes a dietitian on Saathi at once: clients can find her and order a plan from her. Nothing can take an approval back. ${GOV_ID_LINE}`,
    irreversible: true,
    deletesGovernmentId: true,
    noteRequired: false,
  },
  more_info: {
    label: 'Ask for more information',
    decision: 'rejected',
    outcome: 'changes_requested',
    effect: `She is shown your note and can change the application and send it again. ${GOV_ID_LINE} She may have to upload it a second time.`,
    irreversible: false,
    deletesGovernmentId: true,
    noteRequired: true,
  },
  decline: {
    label: 'Decline',
    decision: 'rejected',
    outcome: 'declined',
    effect: `She is told she was not approved, with your note. ${GOV_ID_LINE} She can still change the application and send it again.`,
    irreversible: false,
    deletesGovernmentId: true,
    noteRequired: true,
  },
};

export const reviewAction = (a: ReviewAction): ReviewActionView => ({ action: a, ...ACTIONS[a] });

/** Only what this status may actually become, so the tool never offers a decision the API will refuse. */
export function reviewActionsFor(status: VerificationStatus): ReviewActionView[] {
  return REVIEW_ACTIONS.map(reviewAction).filter((a) => canVerificationTransition(status, a.decision));
}

// ---------- the decision itself ----------

export interface ReviewDecisionInput {
  decision: ReviewDecision;
  note?: string | undefined;
  outcome?: ReviewOutcome | undefined;
}

export interface ReviewPatch {
  status: VerificationStatus;
  /** Her copy of the reviewer's words. Undefined clears the last review's note. */
  reviewNote: string | undefined;
  reviewOutcome: ReviewOutcome | null;
  /** Null while it is only being read: the clock starts when a decision is made. */
  reviewedAt: Date | null;
  flagDocuments: boolean;
  grantsDietitianRole: boolean;
}

/** Everything a decision changes, in one place, so the route only has to save it. */
export function reviewPatch(input: ReviewDecisionInput, now: Date): ReviewPatch {
  const note = input.note?.trim() ? input.note.trim() : undefined;
  const settling = input.decision !== 'in_review';
  return {
    status: input.decision,
    reviewNote: note,
    // Say which kind of rejection it is, so she is not told "not approved" when she only needs to add a document.
    reviewOutcome: input.decision === 'rejected' ? input.outcome ?? (note ? 'changes_requested' : 'declined') : null,
    reviewedAt: settling ? now : null,
    flagDocuments: settling,
    grantsDietitianRole: input.decision === 'approved',
  };
}

// ---------- what the reviewer sees ----------

export interface AdminDocumentView extends DocumentView {
  /** A reviewer should know the ID is already on its way out before she asks for it again. */
  flaggedForDeletion: boolean;
  deleteAfter: Date | null;
}

export const adminDocumentView = (d: DocumentLike & { deleteAfter?: Date | null }): AdminDocumentView => ({
  ...documentView(d),
  flaggedForDeletion: !!d.flaggedForDeletion,
  deleteAfter: d.deleteAfter ?? null,
});

export interface AdminProfileLike {
  _id?: unknown;
  userId?: unknown;
  displayName?: string | null;
  bio?: string | null;
  credentials?: string | null;
  specialties?: string[];
  languages?: string[];
  yearsOfPractice?: number | null;
  countries?: string[];
  cities?: string[];
  bandIds?: string[];
  photoRef?: string | null;
  payoutAccountRef?: string | null;
  status?: VerificationStatus;
  reviewNote?: string | null;
  reviewOutcome?: ReviewOutcome | null;
  reviewedBy?: unknown;
  submittedAt?: Date | null;
  reviewedAt?: Date | null;
  documents?: (DocumentLike & { deleteAfter?: Date | null })[];
}

/**
 * The application as the review tool draws it. Storage keys stay on the server — a reviewer asks for a
 * document by its id, exactly as its owner does, and never by its key.
 */
export function adminProfileView(p: AdminProfileLike) {
  const status = p.status ?? 'draft';
  return {
    id: String(p._id ?? ''),
    userId: String(p.userId ?? ''),
    displayName: p.displayName ?? null,
    bio: p.bio ?? null,
    credentials: p.credentials ?? null,
    specialties: p.specialties ?? [],
    languages: p.languages ?? [],
    yearsOfPractice: p.yearsOfPractice ?? null,
    countries: p.countries ?? [],
    cities: p.cities ?? [],
    bandIds: p.bandIds ?? [],
    hasPhoto: !!p.photoRef,
    hasPayoutAccount: !!p.payoutAccountRef,
    status,
    reviewNote: p.reviewNote ?? null,
    reviewOutcome: p.reviewOutcome ?? null,
    reviewedBy: p.reviewedBy ? String(p.reviewedBy) : null,
    submittedAt: p.submittedAt ?? null,
    reviewedAt: p.reviewedAt ?? null,
    documents: (p.documents ?? []).map(adminDocumentView),
    actions: reviewActionsFor(status),
  };
}

// ---------- one document's bytes ----------

export type DocumentBlock = 'not_found' | 'purged' | 'not_stored_here';
export type DocumentPick = { ok: true; ref: string } | { ok: false; reason: DocumentBlock };

/** A stored document as the record holds it: `storedBy` is the driver that wrote it, null for a bare reference. */
export type StoredDocument = DocumentLike & { storedBy?: string | null };

/**
 * Which stored object a reviewer is allowed to read, by document id. The same isolation rule the owner's
 * own download uses: the key must sit under the scope of the account that owns the application, so an
 * admin cannot be talked into fetching some other key a record happens to carry.
 */
export function pickAdminDocument(p: { userId?: unknown; documents?: StoredDocument[] }, docId: string): DocumentPick {
  const d = (p.documents ?? []).find((x) => String(x._id ?? '') === String(docId));
  if (!d) return { ok: false, reason: 'not_found' };
  if (d.deletedAt) return { ok: false, reason: 'purged' };
  if (!d.storedBy || !keyBelongsTo(d.ref, dietitianScope(String(p.userId ?? '')))) return { ok: false, reason: 'not_stored_here' };
  return { ok: true, ref: d.ref };
}

// ---------- the retention job ----------

export interface PurgeTarget {
  id: string;
  /** The stored object to delete, or null where the bytes are not ours to delete. */
  ref: string | null;
}

/**
 * The documents whose retention window has run out. `ref` is set only where this service stored the
 * bytes under the owner's own scope, so the job deletes what it wrote and never guesses at a reference
 * some other uploader put there.
 */
export function purgeTargets(p: { userId?: unknown; documents?: StoredDocument[] }, now: Date): PurgeTarget[] {
  const scope = dietitianScope(String(p.userId ?? ''));
  return (p.documents ?? [])
    .filter((d) => d.flaggedForDeletion && !d.deletedAt && !!d.deleteAfter && d.deleteAfter <= now)
    .map((d) => ({ id: String(d._id ?? ''), ref: d.storedBy && keyBelongsTo(d.ref, scope) ? d.ref : null }));
}

/** Never says whether the id existed: one message for a document a reviewer cannot have. */
export const documentBlockMessage = (r: DocumentBlock): string =>
  r === 'purged' ? 'That document has been deleted' : 'That document is not here';
