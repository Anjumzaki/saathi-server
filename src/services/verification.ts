/** Pure dietitian-verification workflow. Documents are references only. */
export const VERIFICATION_STATUSES = ['draft', 'submitted', 'in_review', 'approved', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const NEXT: Record<VerificationStatus, VerificationStatus[]> = {
  draft: ['submitted'],
  submitted: ['in_review'],
  in_review: ['approved', 'rejected'],
  approved: [],
  rejected: ['submitted'], // resubmission
};
export const canVerificationTransition = (a: VerificationStatus, b: VerificationStatus) => NEXT[a].includes(b);

export const DOC_KINDS = ['license', 'certificate', 'government_id'] as const;
export interface DocRef {
  kind: (typeof DOC_KINDS)[number];
  ref: string;
  flaggedForDeletion: boolean;
  deleteAfter?: Date | null;
  deletedAt?: Date | null;
}

export const GOV_ID_RETENTION_DAYS = 7;

/** After an approve/reject decision every government-ID reference is flagged for deletion. */
export function flagDocsAfterReview<T extends DocRef>(docs: T[], now: Date): T[] {
  return docs.map((d) =>
    d.kind === 'government_id' && !d.deletedAt
      ? { ...d, flaggedForDeletion: true, deleteAfter: new Date(now.getTime() + GOV_ID_RETENTION_DAYS * 86_400_000) }
      : d,
  );
}

export function readyToSubmit(docs: Pick<DocRef, 'kind' | 'deletedAt'>[]): boolean {
  const live = docs.filter((d) => !d.deletedAt);
  return live.some((d) => d.kind === 'government_id') && live.some((d) => d.kind === 'license' || d.kind === 'certificate');
}
