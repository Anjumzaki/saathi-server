/** Pure sync helpers. Rule: last write wins per record by client `updatedAt`; ties keep the server copy. */

export const SYNC_COLLECTIONS = [
  'planItems',
  'logs',
  'metrics',
  'sleepLogs',
  'stepDays',
  'cycleRecords',
  'settings',
  'answers',
  'plans',
  'rules',
  'recipes',
  'feelings',
  'reflections',
] as const;
export type SyncCollection = (typeof SYNC_COLLECTIONS)[number];

export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Does the incoming record replace the stored one? (Mirrors the `updatedAt < incoming` filter used in Mongo.) */
export function incomingWins(existingUpdatedAt: Date | null | undefined, incomingUpdatedAt: Date): boolean {
  return !existingUpdatedAt || incomingUpdatedAt.getTime() > existingUpdatedAt.getTime();
}

/** A phone with a wrong clock must not win every future conflict: clamp to server time + tolerance. */
export function clampUpdatedAt(updatedAt: Date, now: Date, skewMs = MAX_CLOCK_SKEW_MS): Date {
  const max = now.getTime() + skewMs;
  return updatedAt.getTime() > max ? new Date(max) : updatedAt;
}

export interface PushRecord {
  collection: SyncCollection;
  clientId: string;
  updatedAt: Date;
  deleted: boolean;
  payload?: Record<string, unknown> | undefined;
}

/** Collapse duplicates inside one batch to the newest per (collection, clientId); later entries win ties. */
export function dedupeBatch<T extends { collection: string; clientId: string; updatedAt: Date }>(records: T[]): T[] {
  const m = new Map<string, T>();
  for (const r of records) {
    const k = `${r.collection}\u0000${r.clientId}`;
    const cur = m.get(k);
    if (!cur || r.updatedAt.getTime() >= cur.updatedAt.getTime()) m.set(k, r);
  }
  return [...m.values()];
}

/** Deleted records are kept as tombstones with no payload. */
export const payloadFor = (r: PushRecord): Record<string, unknown> => (r.deleted ? {} : (r.payload ?? {}));
