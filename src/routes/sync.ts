import { Router } from 'express';
import { z } from 'zod';
import { SyncRecord } from '../models/SyncRecord';
import { SYNC_COLLECTIONS, clampUpdatedAt, dedupeBatch, payloadFor, type PushRecord } from '../services/syncLogic';
import { asyncHandler, authOf, parse } from '../utils/http';

const pushSchema = z.object({
  records: z
    .array(
      z.object({
        collection: z.enum(SYNC_COLLECTIONS),
        clientId: z.string().min(1).max(64),
        updatedAt: z.coerce.date(),
        deleted: z.boolean().default(false),
        payload: z.record(z.unknown()).optional(),
      }),
    )
    .max(500),
});
const PULL_LIMIT = 500;

export function syncRoutes(): Router {
  const r = Router();

  r.post('/push', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const now = new Date();
    const records = dedupeBatch(parse(pushSchema, req.body).records as PushRecord[]);
    const stale: { collection: string; clientId: string }[] = [];
    let accepted = 0;
    for (let i = 0; i < records.length; i += 50) {
      await Promise.all(
        records.slice(i, i + 50).map(async (rec) => {
          const updatedAt = clampUpdatedAt(rec.updatedAt, now);
          try {
            // Last-write-wins: the filter only matches when the stored copy is OLDER. When a newer copy exists the
            // upsert tries to insert and hits the unique index (E11000) -> reported as stale.
            await SyncRecord.updateOne(
              { userId, coll: rec.collection, clientId: rec.clientId, updatedAt: { $lt: updatedAt } },
              { $set: { updatedAt, serverUpdatedAt: now, deleted: rec.deleted, payload: payloadFor(rec) } },
              { upsert: true },
            );
            accepted++;
          } catch (e) {
            if ((e as { code?: number }).code === 11000) stale.push({ collection: rec.collection, clientId: rec.clientId });
            else throw e;
          }
        }),
      );
    }
    res.json({ accepted, stale, serverTime: now.toISOString() });
  }));

  r.get('/pull', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const q = parse(z.object({ since: z.coerce.date().optional(), collections: z.string().optional() }), req.query);
    const serverTime = new Date();
    const filter: Record<string, unknown> = { userId, serverUpdatedAt: { $gt: q.since ?? new Date(0) } };
    if (q.collections) {
      const wanted = z.array(z.enum(SYNC_COLLECTIONS)).parse(q.collections.split(','));
      filter['coll'] = { $in: wanted };
    }
    const rows = await SyncRecord.find(filter).sort({ serverUpdatedAt: 1, _id: 1 }).limit(PULL_LIMIT + 1).lean();
    const hasMore = rows.length > PULL_LIMIT;
    const page = rows.slice(0, PULL_LIMIT);
    const last = page[page.length - 1];
    res.json({
      records: page.map((x) => ({ collection: x.coll, clientId: x.clientId, updatedAt: x.updatedAt, deleted: x.deleted, payload: x.payload, serverUpdatedAt: x.serverUpdatedAt })),
      // Use nextSince as the next `since`. If hasMore is false and nothing came back, keep using serverTime.
      nextSince: (last ? last.serverUpdatedAt : serverTime).toISOString(),
      hasMore,
      serverTime: serverTime.toISOString(),
    });
  }));

  return r;
}
