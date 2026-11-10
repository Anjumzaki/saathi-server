import { Schema, model } from 'mongoose';

const regionSchema = new Schema({
  country: { type: String, required: true, unique: true, uppercase: true },
  name: { type: String },
  quietHourProvider: { type: Boolean, default: false },
  produce: { type: [String], default: [] },
  powerCutMode: { type: Boolean, default: false },
  proteinKeywords: { type: [String], default: [] },
});
export const RegionPack = model('RegionPack', regionSchema);
