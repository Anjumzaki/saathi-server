import mongoose from 'mongoose';
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { RateHit } from '../models/RateHit';

/** The part of the RateHit model this store needs (lets tests pass a fake). */
export interface HitModel {
  findOneAndUpdate(filter: object, update: object, options: object): Promise<{ hits: number; resetAt: Date } | null>;
  updateOne(filter: object, update: object): Promise<unknown>;
  deleteOne(filter: object): Promise<unknown>;
}

/**
 * Keeps rate-limit counts in MongoDB so they survive a restart and are shared by every server process.
 * Counts live in fixed windows; when the database is not connected (tests, start-up) it counts in memory instead.
 */
export class MongoRateStore implements Store {
  private windowMs = 60 * 60_000;
  private readonly mem = new Map<string, { hits: number; resetAt: number }>();
  constructor(
    private readonly name: string,
    private readonly hitModel: HitModel = RateHit as unknown as HitModel,
    private readonly connected: () => boolean = () => mongoose.connection.readyState === 1,
    private readonly now: () => number = Date.now,
  ) {}

  init(options: Options): void { this.windowMs = options.windowMs; }

  private slot(key: string): { id: string; resetAt: Date } {
    const start = Math.floor(this.now() / this.windowMs) * this.windowMs;
    return { id: `${this.name}:${key}:${start}`, resetAt: new Date(start + this.windowMs) };
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const { id, resetAt } = this.slot(key);
    if (this.connected()) {
      try {
        const doc = await this.hitModel.findOneAndUpdate({ key: id }, { $inc: { hits: 1 }, $setOnInsert: { resetAt } }, { upsert: true, new: true });
        if (doc) return { totalHits: doc.hits, resetTime: resetAt };
      } catch { /* fall through to the in-memory count rather than failing the request */ }
    }
    const cur = this.mem.get(id) ?? { hits: 0, resetAt: resetAt.getTime() };
    cur.hits += 1;
    this.mem.set(id, cur);
    for (const [k, v] of this.mem) if (v.resetAt < this.now()) this.mem.delete(k);
    return { totalHits: cur.hits, resetTime: resetAt };
  }

  async decrement(key: string): Promise<void> {
    const { id } = this.slot(key);
    const m = this.mem.get(id);
    if (m && m.hits > 0) m.hits -= 1;
    if (this.connected()) { try { await this.hitModel.updateOne({ key: id, hits: { $gt: 0 } }, { $inc: { hits: -1 } }); } catch { /* best effort */ } }
  }

  async resetKey(key: string): Promise<void> {
    const { id } = this.slot(key);
    this.mem.delete(id);
    if (this.connected()) { try { await this.hitModel.deleteOne({ key: id }); } catch { /* best effort */ } }
  }
}
