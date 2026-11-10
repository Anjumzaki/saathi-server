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
import { isPremiumActive } from '../services/entitlement';
import { getFeeConfig } from '../services/feeConfig';
import { computeSettlement } from '../services/money';
import { canRelease, canTransition, isRefundEligible } from '../services/orderState';
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

/** Shared by the client refund route and the settle job. */
export async function refundOrder(s: Services, order: OrderDoc, reason: string): Promise<void> {
  move(order, 'refunded');
  if (order.purchaseToken) await s.playBilling.refund({ purchaseToken: order.purchaseToken });
  order.refundedAt = new Date();
  order.refundReason = reason;
  await order.save();
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
    const variantName = chooseVariant({ isPremium: isPremiumActive(client.subscription as never, new Date()), hasPriorOrderWithDietitian: !!prior });
    const variant = pkg.variants.find((v) => v.variant === variantName) as VariantConfig | undefined;
    const price = variant && findPrice(variant, client.country);
    if (!variant || !price) throw conflict(`No ${variantName} price configured for ${client.country}`, 'no_price');
    const order = await Order.create({
      clientId: userId, dietitianId, packageKey: pkg.key, bandId: body.bandId, variant: variantName,
      productId: variant.productId, country: client.country, currency: price.currency, pricePaid: price.amountMinor, status: 'requested',
    });
    res.status(201).json({ order });
  }));

  r.get('/', asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const orders = await Order.find({ $or: [{ clientId: userId }, { dietitianId: userId }] }).select('-purchaseToken').sort({ createdAt: -1 }).limit(100).lean();
    res.json({ orders });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    const o = order.toObject();
    delete (o as { purchaseToken?: string }).purchaseToken;
    // The client does not need the fee breakdown.
    if (role === 'client') delete (o as { settlement?: unknown }).settlement;
    res.json({ order: o, role });
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

  // ----- chat -----
  const messageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4000) }),
    z.object({ type: z.literal('photo'), photoRef: z.string().min(1).max(500), text: z.string().max(1000).optional() }),
  ]);

  r.post('/:id/messages', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role === 'admin') throw forbidden('Admins cannot post in order chats');
    if (order.status === 'requested' || order.status === 'refunded') throw conflict('Chat is not open for this order');
    const b = parse(messageSchema, req.body); // plan_update cards are created only by publish-plan
    const m = await Message.create({ orderId: order._id, senderId: authOf(req).userId, ...b });
    res.status(201).json({ message: m });
  }));

  r.get('/:id/messages', asyncHandler(async (req, res) => {
    const { order } = await loadOrder(req);
    const q = parse(z.object({ since: z.coerce.date().optional() }), req.query);
    const filter: Record<string, unknown> = { orderId: order._id };
    if (q.since) filter['createdAt'] = { $gt: q.since };
    res.json({ messages: await Message.find(filter).sort({ createdAt: 1 }).limit(500).lean() });
  }));

  // ----- call bookings -----
  r.post('/:id/calls', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    if (role !== 'client') throw forbidden();
    if (!['paid', 'in_progress', 'delivered'].includes(order.status)) throw conflict('Calls open once the order is paid');
    const b = parse(z.object({ slotStart: z.coerce.date(), slotEnd: z.coerce.date() }).refine((v) => v.slotEnd > v.slotStart && v.slotStart > new Date(), { message: 'slot must be in the future and end after it starts' }), req.body);
    const call = await CallBooking.create({ orderId: order._id, clientId: order.clientId, dietitianId: order.dietitianId, ...b });
    res.status(201).json({ call });
  }));

  r.get('/:id/calls', asyncHandler(async (req, res) => {
    const { order } = await loadOrder(req);
    res.json({ calls: await CallBooking.find({ orderId: order._id }).sort({ slotStart: 1 }).lean() });
  }));

  /** Dietitian confirms and provides a link OR a phone number; either party may cancel. */
  r.patch('/:id/calls/:callId', asyncHandler(async (req, res) => {
    const { order, role } = await loadOrder(req);
    const call = await CallBooking.findOne({ _id: objectId(req.params['callId']), orderId: order._id });
    if (!call) throw notFound();
    const b = parse(z.union([
      z.object({ status: z.literal('confirmed'), joinLink: z.string().url().max(500).startsWith('https://'), phone: z.undefined() }),
      z.object({ status: z.literal('confirmed'), phone: z.string().regex(/^\+[1-9]\d{7,14}$/), joinLink: z.undefined() }),
      z.object({ status: z.literal('cancelled') }),
      z.object({ status: z.literal('completed') }),
    ]), req.body);
    if (b.status === 'cancelled') {
      if (role === 'admin') throw forbidden();
    } else if (role !== 'dietitian') throw forbidden();
    call.status = b.status;
    if (b.status === 'confirmed') {
      if ('joinLink' in b && b.joinLink) call.joinLink = b.joinLink;
      if ('phone' in b && b.phone) call.phone = b.phone;
    }
    await call.save();
    res.json({ call });
  }));

  return r;
}
