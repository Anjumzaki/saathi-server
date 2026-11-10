/**
 * Privacy serializers. Cycle dates/symptoms are NEVER exposed to dietitians or partners.
 * Both views are WHITELIST based, and `redactCycle` additionally strips anything cycle-shaped from free-form payloads.
 */
import type { PartnerPermissions } from './partnerLogic';

const CYCLE_KEY_RE = /cycle|period|symptom|menstru|ovulat|flow|pms|luteal|follicular/i;

/** Recursively drop keys that look cycle-related. */
export function redactCycle<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactCycle(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CYCLE_KEY_RE.test(k)) continue;
      out[k] = redactCycle(v);
    }
    return out as T;
  }
  return value;
}

/** Collections a dietitian may ever see. cycleRecords and settings are excluded outright. */
export const DIETITIAN_VISIBLE_COLLECTIONS = ['planItems', 'logs', 'metrics', 'sleepLogs', 'stepDays'] as const;

export interface PlanLike {
  items: { category: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

export function serializePlanForDietitian<P extends PlanLike>(plan: P): P {
  return redactCycle({ ...plan, items: plan.items.filter((i) => i.category !== 'cycle') });
}

export interface SyncRecordLike {
  collection: string;
  clientId: string;
  updatedAt: Date | string;
  deleted: boolean;
  payload: Record<string, unknown>;
}

export function serializeRecordsForDietitian(records: SyncRecordLike[]): SyncRecordLike[] {
  return records
    .filter((r) => (DIETITIAN_VISIBLE_COLLECTIONS as readonly string[]).includes(r.collection))
    .map((r) => ({
      collection: r.collection,
      clientId: r.clientId,
      updatedAt: r.updatedAt,
      deleted: r.deleted,
      payload: redactCycle(r.payload),
    }))
    .filter((r) => !(r.collection === 'planItems' && r.payload['category'] === 'cycle'));
}

export interface PartnerSnapshot {
  date: string;
  effortRing?: number | null;
  streak?: number | null;
  mealsLoggedToday?: boolean;
  waterMl?: number | null;
  steps?: number | null;
  weightKg?: number | null;
  togetherNudges?: string[];
}

export interface PartnerView {
  date: string;
  effortRing?: number | null;
  streak?: number | null;
  mealsLoggedToday?: boolean;
  water?: { ml: number | null };
  walk?: { steps: number | null };
  weightKg?: number | null;
  togetherNudges?: string[];
}

/** Builds exactly what the owner ticked. The snapshot type has no cycle fields; extra props are ignored. */
export function serializePartnerView(perms: PartnerPermissions, snap: PartnerSnapshot): PartnerView {
  const view: PartnerView = { date: snap.date };
  if (perms.togetherNudgesOnly) {
    view.togetherNudges = [...(snap.togetherNudges ?? [])].map(String);
    return view;
  }
  if (perms.effortRing) {
    view.effortRing = snap.effortRing ?? null;
    view.streak = snap.streak ?? null;
  }
  if (perms.mealsLogged) view.mealsLoggedToday = !!snap.mealsLoggedToday;
  if (perms.waterWalk) {
    view.water = { ml: snap.waterMl ?? null };
    view.walk = { steps: snap.steps ?? null };
  }
  if (perms.weight) view.weightKg = snap.weightKg ?? null;
  return view;
}
