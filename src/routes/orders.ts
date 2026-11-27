import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Services } from '../interfaces';
import { CallBooking } from '../models/CallBooking';
import { DietitianProfile } from '../models/DietitianProfile';
import { Message } from '../models/Message';
import { Order } from '../models/Order';
import { PackageConfig } from '../models/PackageConfig';
import { Plan } from '../models/Plan';
import { SyncRecord } from '../models/SyncRecord';
import { User } from '../models/User';
import { planContentSchema } from '../schemas/plan';
import { effectiveStatus, isPremiumActive } from '../services/entitlement';
import { getFeeConfig } from '../services/feeConfig';
import { computeSettlement } from '../services/money';
import { canRelease, canTransition, isRefundEligible, refundOpensAt } from '../services/orderState';
import { reviewPlanForPublish } from '../services/dietitianPublish';
import { livePush } from '../services/push';
import { log } from '../utils/logger';
import { nextVersion, type StoredVersion } from '../services/planVersioning';
import { chooseVariant, findPrice, type VariantConfig } from '../services/pricing';
import { serializePlanForDietitian, serializeRecordsForDietitian, type PlanLike, type SyncRecordLike } from '../services/serializers';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { asyncHandler, authOf, objectId, parse } from '../utils/http';

type OrderDoc = InstanceType<typeof Order>;

async function loadOrder(req: Request): Promise<{ order: OrderDoc; role: 'client' | 'dietitian' | 'admin' }> {
  const { userId, roles } = authOf(req);
  const order = await Order.findById(objectId(req.params['id']));
  if (!order) throw notFound('Order not found');
  if (String(order.clientId) === userId) return { order, role: 'client' };
  if (String(order.dietitianId) === userId) return { order, role: 'dietitian' };
  if (roles.includes('admin')) return { order, role: 'admin' };
  throw notFound('Order not found'); // do not reveal existence
}

/** Server-side guard for every status change, so illegal transitions are impossible from any route. */
function move(order: OrderDoc, to: OrderDoc['status']): void {
  if (!canTransition(order.status, to)) throw conflict(`Order is ${order.status}; cannot move to ${to}`, 'invalid_transition');
  order.status = to;
}

type ClientLike = { country?: string | null; subscription?: unknown };

/**
 * The price of one band for one client, in one place, so a quote and the order it turns into can never disagree.
 * The subscriber price is a thank-you for paying, so a trial pays full: `status` is passed to `chooseVariant`,
 * which refuses the discount while she is "trialing".
 */
function priceFor(client: ClientLike, pkg: { key: string; label: string; variants: unknown[] }, hasPrior: boolean, now: Date) {
  const sub = client.subscription as never;
  const status = effectiveStatus(sub, now);
  const isPremium = isPremiumActive(sub, now);
  const variant = chooseVariant({ isPremium, hasPriorOrderWithDietitian: hasPrior, status });
  const country = client.country ?? '';
  const pick = (name: string) => {
    const v = (pkg.variants as VariantConfig[]).find((x) => x.variant === name);
    const p = v && findPrice(v, country);
    return v && p ? { variant: name, productId: v.productId, currency: p.currency, amountMinor: p.amountMinor } : null;
  };
  return {
    status,
    isPremium,
    chosen: pick(variant),
    /** What she would pay without any discount, so the app can show the saving honestly. */
    list: pick('full'),
    /** She is Premium but has not been charged yet: the subscriber price starts after her first payment. */
    discountHeldForTrial: isPremium && status === 'trialing' && variant === 'full',
  };
}

/** Shared by the client refund route and the settle job. */
export async function refundOrder(s: Services, order: OrderDoc, reason: string): Promise<void> {
  move(order, 'refunded');
  if (order.purchaseToken) {
    await s.playBilling.refund({ purchaseToken: order.purchaseToken, productId: order.productId, orderId: order.playOrderId ?? undefined });
  }
  order.refundedAt = new Date();
  order.refundReason = reason;
  await order.save();
  livePush().notify(String(order.clientId), { type: 'subscription', event: 'refunded' });
}

export function orderRoutes(s: Services): Router {
  const r = Router();

  r.post('/', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const body = parse(z.object({ dietitianId: z.string(), bandId: z.string().min(1).max(64) }), req.body);
    const dietitianId = objectId(body.dietitianId);
    if (dietitianId === userId) throw badRequest('You cannot order from yourself');
    const [profile, client, pkg] = await Promise.all([
      DietitianProfile.findOne({ userId: dietitianId, status: 'approved' }).lean(),
      User.findById(userId).lean(),
      PackageConfig.findOne({ kind: 'dietitian_plan', bandId: body.bandId, active: true }).lean(),
    ]);
    if (!profile) throw notFound('Dietitian not found');
    if (!pkg) throw notFound('Package not found');
    if (!client?.country) throw badRequest('Set your country (PATCH /v1/me) before ordering', { code: 'country_required' });
    const prior = await Order.exists({ clientId: userId, dietitianId, status: { $in: ['delivered', 'released'] } });
    const q = priceFor(client, pkg as never, !!prior, new Date());
    if (!q.chosen) throw conflict(`No price configured for ${client.country}`, 'no_price');
    const order = await Order.create({
      clientId: userId, dietitianId, packageKey: pkg.key, bandId: body.bandId, variant: q.chosen.variant,
      productId: q.chosen.productId, country: client.country, currency: q.chosen.currency, pricePaid: q.chosen.amountMinor, status: 'requested',
    });
    res.status(201).json({ order });
  }));

  r.get('/', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const orders = await Order.find({ $or: [{ clientId: userId }, { dietitianId: userId }] }).select('-purchaseToken').sort({ createdAt: -1 }).limit(100).lean();
    const fees = await getFeeConfig();
    // Names for the history screens: the package label, the dietitian's name and every call booked on the order.
    const [pkgs, profiles, calls] = await Promise.all([
      PackageConfig.find({ key: { $in: [...new Set(orders.map((o) => o.packageKey))] } }).select('key label').lean(),
      DietitianProfile.find({ userId: { $in: [...new Set(orders.map((o) => String(o.dietitianId)))] } }).select('userId displayName').lean(),
      CallBooking.find({ orderId: { $in: orders.map((o) => o._id) } }).sort({ slotStart: 1 }).lean(),
    ]);
    const label = new Map(pkgs.map((p) => [p.key, p.label]));
    const names = new Map(profiles.map((p) => [String(p.userId), p.displayName]));
    res.json({
      orders: orders.map((o) => {
        const mine = String(o.clientId) === userId;
        const { settlement, ...rest } = o as typeof o & { settlement?: unknown };
        return {
          ...(mine ? rest : o), // the fee breakdown is for the dietitian side only
          packageLabel: label.get(o.packageKey) ?? o.packageKey,
          dietitianName: names.get(String(o.dietitianId)) ?? null,
          calls: calls.filter((c) => String(c.orderId) === String(o._id)),
          // When she may ask for her money back, so the app shows the wait without knowing the fee config.
          refundOpensAt: refundOpensAt(o as never, fees.refundWindowHours),
          ...(mine ? {} : { settlement }),
        };
      }),
    });
  }));

  /**
   * What a band would cost her, before anything is created. Declared above `/:id` so "quote" is not read as an id.
   * The server is the authority on the discount: the app shows what comes back and never works it out itself.
   */
  r.get('/quote', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const q = parse(z.object({ dietitianId: z.string(), bandId: z.string().min(1).max(64) }), req.query);
    const dietitianId = objectId(q.dietitianId);
    if (dietitianId === userId) throw badRequest('You cannot order from yourself');
    const [profile, client, pkg] = await Promise.all([
      DietitianProfile.findOne({ userId: dietitianId, status: 'approved' }).select('userId displayName').lean(),
      User.findById(userId).lean(),
      PackageConfig.findOne({ kind: 'dietitian_plan', bandId: q.bandId, active: true }).lean(),
    ]);
    if (!profile) throw notFound('Dietitian not found');
    if (!pkg) throw notFound('Package not found');
    if (!client?.country) throw badRequest('Set your country (PATCH /v1/me) before ordering', { code: 'country_required' });
    const [prior, fees] = await Promise.all([
      Order.exists({ clientId: userId, dietitianId, status: { $in: ['delivered', 'released'] } }),
      getFeeConfig(),
    ]);
    const priced = priceFor(client, pkg as never, !!prior, new Date());
    if (!priced.chosen) throw conflict(`No price configured for ${client.country}`, 'no_price');
    res.json({
      quote: {
        bandId: q.bandId,
        packageKey: pkg.key,
        label: pkg.label,
        variant: priced.chosen.variant,
        productId: priced.chosen.productId,
        currency: priced.chosen.currency,
        amountMinor: priced.chosen.amountMinor,
        // The full price, for an honest "you save" line; equal to amountMinor when no discount applies.
        listCurrency: priced.list?.currency ?? priced.chosen.currency,
        listAmountMinor: priced.list?.amountMinor ?? priced.chosen.amountMinor,
        subscriptionStatus: priced.status,
        discountHeldForTrial: priced.discountHeldForTrial,
        // The promises the app makes before she pays, so no screen hard-codes them. No fee percentages here.
        refundWindowHours: fees.refundWindowHours,
        payoutDelayHours: fees.payoutDelayHours,
      },
    });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    const o = order.toObject();
    delete (o as { purchaseToken?: string }).purchaseToken;
    // The client does not need the fee breakdown.
    if (role === 'client') delete (o as { settlement?: unknown }).settlement;
    const fees = await getFeeConfig();
    res.json({ order: { ...o, refundOpensAt: refundOpensAt(o as never, fees.refundWindowHours) }, role });
  }));

  /** Client reports a completed Play purchase; the server verifies it and snapshots the settlement. */
  r.post('/:id/pay', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role !== 'client') throw forbidden();
    const { purchaseToken } = parse(z.object({ purchaseToken: z.string().min(1).max(4000) }), req.body);
    if (await Order.exists({ purchaseToken, _id: { $ne: order._id } })) throw conflict('Purchase token already used', 'purchase_token_in_use');
    if (order.status !== 'requested') throw conflict(`Order is ${order.status}`, 'invalid_transition');
    const v = await s.playBilling.verify({ productId: order.productId, purchaseToken, kind: 'product' });
    if (!v.valid) throw badRequest('Purchase could not be verified');
    const fees = await getFeeConfig();
    const st = computeSettlement(order.pricePaid, fees);
    move(order, 'paid');
    order.paidAt = new Date();
    order.purchaseToken = purchaseToken;
    if (v.orderId) order.playOrderId = v.orderId;
    order.settlement = { playFee: st.playFee, net: st.net, platform: st.platform, dietitian: st.dietitian, playFeePercent: fees.playFeePercent, platformFeePercent: fees.platformFeePercent };
    await order.save();
    // Google refunds an unacknowledged purchase after three days, which is the right outcome if we never
    // managed to store the order. So this comes after the save, never before it.
    if (s.playBilling.acknowledge) {
      try {
        await s.playBilling.acknowledge({ productId: order.productId, purchaseToken, kind: 'product' });
      } catch (e) {
        log.error('Play acknowledgement failed after the order was paid', { message: e instanceof Error ? e.message : String(e) });
      }
    }
    res.json({ status: order.status });
  }));

  r.post('/:id/start', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role !== 'dietitian') throw forbidden();
    move(order, 'in_progress');
    order.startedAt = new Date();
    await order.save();
    res.json({ status: order.status });
  }));

  r.post('/:id/deliver', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role !== 'dietitian') throw forbidden();
    if (!order.planId) throw conflict('Publish the plan before marking the order delivered', 'plan_not_published');
    move(order, 'delivered');
    order.deliveredAt = new Date();
    await order.save();
    res.json({ status: order.status });
  }));

  /** Client releases early; otherwise the settle job auto-releases payoutDelayHours after delivery. */
  r.post('/:id/release', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role !== 'client') throw forbidden();
    const fees = await getFeeConfig();
    if (!canRelease(order, new Date(), fees.payoutDelayHours, true)) throw conflict('Order is not deliverable for release', 'invalid_transition');
    move(order, 'released');
    order.releasedAt = new Date();
    await order.save();
    res.json({ status: order.status });
  }));

  r.post('/:id/refund', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    const { reason } = parse(z.object({ reason: z.string().max(500).default('') }), req.body ?? {});
    const fees = await getFeeConfig();
    if (role === 'dietitian') throw forbidden();
    if (role === 'client' && !isRefundEligible(order, new Date(), fees.refundWindowHours)) {
      throw conflict(`Refund opens ${fees.refundWindowHours}h after payment if nothing has been delivered`, 'refund_not_eligible');
    }
    await refundOrder(s, order, reason || (role === 'admin' ? 'admin' : 'not delivered in window'));
    res.json({ status: order.status });
  }));

  /** Dietitian publishes a plan: creates a NEW plan version for the client with a diff, and posts a plan-update card. */
  r.post('/:id/publish-plan', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role !== 'dietitian') throw forbidden();
    if (!['paid', 'in_progress', 'delivered'].includes(order.status)) throw conflict(`Order is ${order.status}`, 'invalid_transition');
    const b = parse(planContentSchema.extend({ title: z.string().max(200).optional(), note: z.string().max(1000).optional() }), req.body);
    // Her app asks her to acknowledge the advice; the blocking problems are checked here as well.
    const review = reviewPlanForPublish(b);
    if (review.blocking.length) throw conflict(review.blocking[0]!.message, 'plan_not_publishable');
    const dietitianId = String(order.dietitianId);
    let plan = order.planId ? await Plan.findById(order.planId) : await Plan.findOne({ userId: order.clientId }).sort({ updatedAt: -1 });
    let v: StoredVersion;
    if (!plan) {
      v = nextVersion(null, b);
      plan = await Plan.create({ userId: order.clientId, title: b.title ?? 'Plan from your dietitian', dietitianId, orderId: order._id, currentVersion: 1, versions: [{ ...v, createdBy: dietitianId, source: 'dietitian', note: b.note }] });
    } else {
      v = nextVersion((plan.versions[plan.versions.length - 1] as unknown as StoredVersion) ?? null, b);
      plan.versions.push({ ...v, createdBy: dietitianId, source: 'dietitian', note: b.note } as never);
      plan.currentVersion = v.number;
      plan.dietitianId = order.dietitianId;
      plan.orderId = order._id;
      await plan.save();
    }
    if (order.status === 'paid') {
      move(order, 'in_progress');
      order.startedAt = new Date();
    }
    order.planId = plan._id;
    await order.save();
    await Message.create({ orderId: order._id, senderId: dietitianId, type: 'plan_update', text: b.note, planUpdate: { planId: plan._id, version: v.number, summary: v.diff?.summary } });
    res.status(201).json({ planId: plan._id, version: v.number, diff: v.diff });
  }));

  /** What a dietitian may see about their client. Cycle data is excluded by the serializers. */
  r.get('/:id/client-data', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role !== 'dietitian') throw forbidden();
    if (!['paid', 'in_progress', 'delivered'].includes(order.status)) throw conflict('Client data is available while the order is active');
    const [plan, records] = await Promise.all([
      order.planId ? Plan.findById(order.planId).lean() : null,
      SyncRecord.find({ userId: order.clientId, coll: { $in: ['logs', 'metrics', 'sleepLogs', 'stepDays'] }, deleted: false }).sort({ updatedAt: -1 }).limit(500).lean(),
    ]);
    const cur = plan?.versions.find((x) => x.number === plan.currentVersion);
    res.json({
      plan: cur ? serializePlanForDietitian({ planId: String(plan!._id), version: cur.number, items: cur.items as PlanLike['items'], rules: cur.rules, recipes: cur.recipes }) : null,
      records: serializeRecordsForDietitian(records.map((x) => ({ collection: x.coll, clientId: x.clientId, updatedAt: x.updatedAt, deleted: x.deleted, payload: x.payload as Record<string, unknown> })) satisfies SyncRecordLike[]),
    });
  }));

  // Chat and call booking moved to routes/threads.ts, so one implementation serves both the
  // marketplace and Premium Plus. Thread reads still pick up legacy rows by orderId, so the
  // plan_update card written by publish-plan and the bookings listed above keep working.

  return r;
}
