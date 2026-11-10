import type { PlanContent } from '../schemas/plan';
import { diffPlans, type PlanDiff } from './planDiff';

export interface StoredVersion extends PlanContent {
  number: number;
  diff: PlanDiff | null;
}

/** Pure: builds the next version (number + diff vs the previous version). */
export function nextVersion(prev: StoredVersion | null, content: PlanContent): StoredVersion {
  return { number: (prev?.number ?? 0) + 1, items: content.items, rules: content.rules, recipes: content.recipes, diff: diffPlans(prev, content) };
}
