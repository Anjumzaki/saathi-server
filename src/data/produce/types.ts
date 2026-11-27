/** Shapes for the seasonal produce packs the app's "In season near you" grid is built from. */

export type ProduceKind = 'fruit' | 'veg' | 'herb';

/** One thing to buy. `months` are calendar months, 1 = January. `use` is the short note under the name. */
export interface ProduceItem {
  name: string;
  kind: ProduceKind;
  use: string;
  months: number[];
}

/** A province, emirate or state. Its list stands on its own: it replaces the country list, it is not added to it. */
export interface ProduceRegion {
  /** Key the app asks for, and what is shown as the region's name. */
  region: string;
  /** Cities and towns that belong to this region, so the app can send only the city it knows. */
  cities: string[];
  items: ProduceItem[];
}

export interface ProducePack {
  /** ISO country code; ZZ is the neutral list used where we have nothing better. */
  country: string;
  name: string;
  /** Bump by one after any edit below, so phones fetch the list again. */
  version: number;
  /** Date of the last edit, YYYY-MM-DD. */
  updatedAt: string;
  /** Used when the city is not in any region below. */
  items: ProduceItem[];
  regions: ProduceRegion[];
}

/** One tile in the grid: in season now, or flagged with `soon` when it starts next month. */
export interface ProduceTile {
  name: string;
  kind: ProduceKind;
  use: string;
  soon?: string;
}

export type ProduceSource = 'region' | 'country' | 'default';

/** What the endpoint answers for one place and one month. */
export interface ProduceAnswer {
  country: string;
  region: string;
  month: number;
  source: ProduceSource;
  version: number;
  updatedAt: string;
  items: ProduceTile[];
}
