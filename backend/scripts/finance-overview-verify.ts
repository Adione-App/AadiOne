/**
 * READ-ONLY check of the admin Financial Overview against a database's real
 * records: every lifetime figure (all sellers, then each seller) recomputed
 * here from the raw rows with plain Prisma reads — independently of the
 * overview's SQL — and compared. Database: SELECTs only. (Reading the
 * reporting timezone may fill the configuration cache, as any API request does.)
 *
 *   node scripts/with-env.mjs --no-payments --transaction-pooler .env.v2 npx tsx scripts/finance-overview-verify.ts
 *
 * Prints counts and amounts only (paise), never a customer's details.
 */

import { prisma } from '../src/infra/db/prisma';
import { getFinancialOverview, listFinanceOrders, resolveFilter } from '../src/modules/finance/finance-overview.service';

async function expected(sellerId: string | null) {
  const orders = await prisma.order.findMany({
    where: { status: 'DELIVERED', paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, deliveredAt: { not: null } },
    include: { sellerOrders: true, refunds: { include: { group: true } } },
  });
  const manual = await prisma.refundGroup.findMany({ where: { channel: 'MANUAL', postDelivery: true, manualPayout: { is: { status: 'CONFIRMED' } } } });
  const deductions = await prisma.sellerDeduction.findMany();
  const e = { orders: 0, collected: 0, cod: 0, online: 0, sellerPrice: 0, coupon: 0, commission: 0, delivery: 0, platform: 0, refunded: 0, deducted: 0, commissionReversed: 0, payableGapOrders: 0 };
  for (const o of orders) {
    const active = o.sellerOrders.filter((so) => so.status !== 'CANCELLED' && so.status !== 'REJECTED');
    const mine = sellerId ? active.filter((so) => so.sellerId === sellerId) : active;
    if (sellerId && mine.length === 0) continue;
    const ownsFees = !sellerId || active.length === 1;
    const products = mine.reduce((s, so) => s + so.subtotalPaise, 0);
    const coupon = mine.reduce((s, so) => s + so.couponDiscountPaise, 0);
    const collected = sellerId ? products - coupon + (ownsFees ? o.deliveryFeePaise + o.platformFeePaise : 0) : o.currentPayablePaise;
    if (!sellerId && o.currentPayablePaise !== active.reduce((s, so) => s + so.subtotalPaise - so.couponDiscountPaise, 0) + o.deliveryFeePaise + o.platformFeePaise) e.payableGapOrders += 1;
    e.orders += 1; e.collected += collected;
    if (o.paymentMethod === 'COD') e.cod += collected; else e.online += collected;
    e.sellerPrice += products; e.coupon += coupon; e.commission += mine.reduce((s, so) => s + so.commissionPaise, 0);
    if (ownsFees) { e.delivery += o.deliveryFeePaise; e.platform += o.platformFeePaise; }
    const ids = new Set(mine.map((so) => so.id));
    e.refunded += o.refunds.filter((r) => r.status === 'COMPLETED' && r.group?.postDelivery && r.sellerOrderId && ids.has(r.sellerOrderId)).reduce((s, r) => s + r.amountPaise, 0);
    for (const g of manual.filter((g) => g.orderId === o.id)) for (const l of (g.allocation as { sellerOrderId: string; amountPaise: number }[]) ?? []) if (ids.has(l.sellerOrderId)) e.refunded += l.amountPaise;
    for (const d of deductions.filter((d) => ids.has(d.sellerOrderId))) { e.deducted += d.amountPaise; e.commissionReversed += d.commissionReversedPaise; }
  }
  return e;
}

let mismatches = 0;

(async () => {
  const dbName = (await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db'))[0]!.db;
  // Read-only from here on: SELECTs only.
  const counts = await prisma.$queryRawUnsafe<{ status: string; n: bigint }[]>(`SELECT status::text, count(*) n FROM orders GROUP BY 1 ORDER BY 1`);
  console.log('database', dbName, 'orders by status', Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])));
  const sellers = await prisma.$queryRawUnsafe<{ seller_id: string }[]>(`SELECT DISTINCT seller_id::text FROM seller_orders so JOIN orders o ON o.id = so.order_id WHERE o.status = 'DELIVERED'`);
  for (const sellerId of [null, ...sellers.map((s) => s.seller_id)]) {
    const filter = await resolveFilter({ period: 'LIFETIME', ...(sellerId ? { sellerId } : {}) });
    const v = await getFinancialOverview(filter);
    const e = await expected(sellerId);
    const list = await listFinanceOrders(filter, 1, 100);
    const f = v.figures;
    const checks: [string, number, number][] = [
      ['orders', v.measures.orders, e.orders], ['revenue', f.grossRevenuePaise, e.collected], ['COD', v.byMethod.COD.grossRevenuePaise, e.cod],
      ['online', v.byMethod.ONLINE.grossRevenuePaise, e.online], ['seller price', f.sellerPricePaise, e.sellerPrice], ['coupon', f.couponPaise, e.coupon],
      ['commission', f.commissionPaise, e.commission], ['delivery', f.deliveryPaise, e.delivery], ['platform', f.platformPaise, e.platform],
      ['refunds', f.refundsPaise - f.unclassifiedRefundsPaise, e.refunded], ['deductions', f.sellerDeductionsPaise, e.deducted],
      ['commission reversed', f.commissionReversedPaise, e.commissionReversed],
      ['order list total', list.items.reduce((s, r) => s + r.grossRevenuePaise, 0), list.total <= 100 ? f.grossRevenuePaise : NaN],
    ];
    if (!sellerId) checks.push(['payable mismatches', v.dataQuality.payableMismatch.orders, e.payableGapOrders]);
    const bad = checks.filter(([, a, b]) => !Number.isNaN(b) && a !== b);
    mismatches += bad.length;
    console.log(`${sellerId ? `seller ${v.seller?.code}` : 'ALL SELLERS'}: ${checks.length - bad.length}/${checks.length} match`, bad.length ? JSON.stringify(bad) : '',
      `| revenue ${f.grossRevenuePaise} seller net ${f.sellerNetPaise} aadione ${f.aadioneGrossPaise}→${f.aadioneNetPaise} coupons ${f.couponPaise} gap ${f.reconciliationGapPaise} unclassified ${f.unclassifiedRefundsPaise} notes ${JSON.stringify(v.dataQuality.notes)}`);
  }
  console.log(mismatches === 0 ? 'RESULT: every figure matches the records.' : `RESULT: ${mismatches} figure(s) differ — see above.`);
  await prisma.$disconnect();
  process.exit(mismatches === 0 ? 0 : 2);
})().catch(async (e) => { console.error('FAILED', e.message); await prisma.$disconnect(); process.exit(1); });
