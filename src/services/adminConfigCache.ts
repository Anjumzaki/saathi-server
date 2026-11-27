/**
 * Every cached view of pricing, in one place, so an edit in the admin tool cannot half-land.
 *
 * There are two package caches — `getActivePackages()` (the raw documents) and `getPaidPackages()` (the
 * subscription view the app reads) — and the fee cache. Fees are not only fees: the premium and follow-up
 * discounts are what band prices are derived from, so a fee edit makes a cached price as stale as a
 * package edit does. Both edits therefore clear all three rather than guess which one mattered.
 */
import { invalidateFeeConfig, invalidatePackages } from './feeConfig';
import { invalidatePaidPackages } from './packageCatalogue';

export type Invalidator = () => void;

export const CONFIG_INVALIDATORS: Invalidator[] = [
  () => void invalidateFeeConfig(),
  () => void invalidatePackages(),
  () => void invalidatePaidPackages(),
];

export function invalidateConfigCaches(invalidators: Invalidator[] = CONFIG_INVALIDATORS): void {
  for (const f of invalidators) f();
}
