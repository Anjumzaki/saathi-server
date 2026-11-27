import { Schema, model } from 'mongoose';

/** One thing to buy, as written in `data/produce`. `months` are calendar months, 1 = January. */
const produceItemSchema = new Schema(
  {
    name: { type: String, required: true },
    kind: { type: String, enum: ['fruit', 'veg', 'herb'], default: 'veg' },
    use: { type: String, default: '' },
    months: { type: [Number], default: [] },
  },
  { _id: false },
);

/** A province, emirate or state. Its list replaces the country list for the cities named here. */
const produceRegionSchema = new Schema(
  {
    region: { type: String, required: true },
    cities: { type: [String], default: [] },
    items: { type: [produceItemSchema], default: [] },
  },
  { _id: false },
);

const regionSchema = new Schema({
  country: { type: String, required: true, unique: true, uppercase: true },
  name: { type: String },
  quietHourProvider: { type: Boolean, default: false },
  /** Produce keywords for the plan checker: not the seasonal grid, which is `produceItems` below. */
  produce: { type: [String], default: [] },
  powerCutMode: { type: Boolean, default: false },
  proteinKeywords: { type: [String], default: [] },
  /** Seasonal produce for the Guide's "In season near you", so it can be corrected without an app release. */
  produceItems: { type: [produceItemSchema], default: [] },
  produceRegions: { type: [produceRegionSchema], default: [] },
  /** Bumped on every edit; the app caches by it and refetches when it moves. */
  produceVersion: { type: Number, default: 1 },
  produceUpdatedAt: { type: Date, default: null },
});
export const RegionPack = model('RegionPack', regionSchema);

/** Fields the old `GET /region/:country` answers with: the seasonal lists are served separately. */
export const REGION_SUMMARY_FIELDS = '-_id -__v -produceItems -produceRegions -produceVersion -produceUpdatedAt';
