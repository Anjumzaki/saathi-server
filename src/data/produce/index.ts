import { DEFAULT_COUNTRY, PRODUCE_PACKS } from './packs';
import type { ProduceAnswer, ProduceItem, ProducePack, ProduceSource, ProduceTile } from './types';

export type { ProduceAnswer, ProduceItem, ProduceKind, ProducePack, ProduceRegion, ProduceSource, ProduceTile } from './types';
export { DEFAULT_COUNTRY } from './packs';

/** The packs as written in `packs.ts`. The seed copies these into the database, where they can be corrected. */
export function producePacks(): ProducePack[] {
  return PRODUCE_PACKS;
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Names are compared loosely: she may have "Ras al Khaimah" saved where the pack says "Ras Al Khaimah". */
const key = (s: string): string => s.toLowerCase().replace(/[^a-z]+/g, '');

/** Up to `max` tiles for one month (1 to 12): what is in season now, then what starts next month. */
export function tilesFor(items: ProduceItem[], month: number, max = 8): ProduceTile[] {
  const next = (month % 12) + 1;
  const tile = (p: ProduceItem): ProduceTile => ({ name: p.name, kind: p.kind, use: p.use });
  const now = items.filter((p) => p.months.includes(month)).map(tile);
  const soon = items
    .filter((p) => !p.months.includes(month) && p.months.includes(next))
    .map((p) => ({ ...tile(p), soon: `from ${SHORT[next - 1]}` }));
  // Keep one slot for what is coming next month, so the grid always looks a little ahead.
  const ahead = soon.slice(0, Math.max(max - now.length, soon.length ? 1 : 0));
  return [...now.slice(0, max - ahead.length), ...ahead];
}

interface Resolved { pack: ProducePack; region: string; items: ProduceItem[]; source: ProduceSource }

/**
 * Which list to use for a place: the region she is in, else the country, else the neutral list.
 * `place` can be a region name or just a city, because the app only knows the city she picked.
 */
export function resolveProduce(packs: ProducePack[], country: string, place?: string): Resolved | null {
  const wanted = key(country ?? '');
  const pack = packs.find((p) => key(p.country) === wanted);
  const fallback = packs.find((p) => key(p.country) === key(DEFAULT_COUNTRY));
  if (pack) {
    const p = place ? key(place) : '';
    const region = p ? pack.regions.find((r) => key(r.region) === p || r.cities.some((c) => key(c) === p)) : undefined;
    if (region && region.items.length) return { pack, region: region.region, items: region.items, source: 'region' };
    if (pack.items.length) return { pack, region: '', items: pack.items, source: 'country' };
  }
  if (!fallback) return null;
  return { pack: fallback, region: '', items: fallback.items, source: 'default' };
}

/** The whole answer for one place and one month, ready to serve. */
export function selectProduce(packs: ProducePack[], q: { country: string; place?: string; month: number }, max = 8): ProduceAnswer | null {
  const r = resolveProduce(packs, q.country, q.place);
  if (!r) return null;
  return {
    country: r.pack.country,
    region: r.region,
    month: q.month,
    source: r.source,
    version: r.pack.version,
    updatedAt: r.pack.updatedAt,
    items: tilesFor(r.items, q.month, max),
  };
}
