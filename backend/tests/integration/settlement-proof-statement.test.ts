/**
 * Seller settlement — payment reference, payment proof and statement PDF.
 *
 *   - the transaction / UPI reference recorded when marking PAID is stored and
 *     returned to admin and seller;
 *   - a payment proof (image or PDF, checked by its bytes) can be attached by
 *     an admin while PROCESSING or PAID, is kept in PRIVATE storage, and is
 *     readable by admins and by the OWN seller once PAID — nobody else;
 *   - the statement PDF is built from the real settlement: every total drawn
 *     equals the stored settlement; admin and the own seller can download it;
 *   - long statements run over several pages with the table header repeated;
 *   - none of this changes a settlement's amounts, status rules or orders.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infra/payment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infra/payment')>();
  const fake = await import('../helpers/fake-cashfree');
  return {
    ...actual,
    payments: new actual.CashfreeProvider({
      appId: 'cf_test_app_id',
      secretKey: fake.FAKE_CASHFREE_SECRET,
      environment: 'SANDBOX',
      apiVersion: '2026-01-01',
      fetch: fake.sharedFakeCashfree.fetch,
    }),
    requiresManualPaymentConfirmation: () => false,
    allowsManualPaymentConfirmation: () => false,
  };
});

import sharp from 'sharp';
import { ConfigKey, UserRole } from '../../src/shared';
import { formatPaise } from '../../src/shared/money';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import { privateDocuments } from '../../src/infra/storage/private-documents';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { sharedFakeCashfree as cashfree } from '../helpers/fake-cashfree';
import { configureTestMerchantUpi, seedStore } from '../helpers/fixtures';
import { COD, deliver, listing, panelToken, placeOrder, seedSeller } from '../helpers/refund-fixtures';
import { SETTLEMENT_CLOSE_LAG_MS } from '../../src/modules/sellers/seller-settlement.service';
import { buildStatementData, type StatementData } from '../../src/modules/sellers/seller-statement.service';
import { date, formatMoney, renderStatementPdf } from '../../src/modules/sellers/seller-statement-pdf';

interface SettlementBody {
  id: string;
  sellerId: string;
  status: string;
  grossSalesPaise: number;
  commissionPaise: number;
  deductionsPaise: number;
  netPayablePaise: number;
  payoutReference: string | null;
  hasPayoutProof: boolean;
  paidAt: string | null;
}

let admin = '';
let storeId = '';

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
  cashfree.reset();
  await configService.set({ key: ConfigKey.MIN_ORDER_VALUE_PAISE, value: 0 as never });
  await configService.set({ key: ConfigKey.COD_FIRST_ORDER_MAX_PAISE, value: 1_000_000 as never });
  await configureTestMerchantUpi();
  storeId = await seedStore();
  admin = (await panelToken(UserRole.ADMIN)).token;
});

const asAdmin = (req: ReturnType<ReturnType<typeof api>['get']>) => req.set('Authorization', bearer(admin));

async function sellerToken(mobile: string): Promise<string> {
  await otpService.clearOtpState(mobile);
  return (await loginAs(mobile)).accessToken;
}

/**
 * A real settlement: `orders` COD orders for one seller (10% commission),
 * delivered, moved into a closed period, then settled by the admin endpoint.
 */
async function realSettlement(orders: number, sellerMobile = '9400000701', customerMobile = '9400000711') {
  const sellerId = await seedSeller(`Kirana ${sellerMobile.slice(-3)}`, sellerMobile, 1000);
  const listingId = await listing(storeId, sellerId, 23_450);
  for (let i = 0; i < orders; i++) {
    // A new customer per order: each order signs in again, and OTP requests are limited per number (3 an hour).
    const placed = await placeOrder(`${customerMobile.slice(0, 8)}${String(10 + i).slice(-2)}`, [{ listingId, qty: 1 + (i % 2) }], COD);
    await deliver(admin, placed);
  }
  // Inside a closed period (the settlement rule needs it to end in the past).
  await prisma.order.updateMany({ where: { sellerOrders: { some: { sellerId } } }, data: { deliveredAt: new Date(Date.now() - 10 * 60_000) } });
  const res = await asAdmin(api().post(`/api/v1/admin/sellers/${sellerId}/settlements`))
    .send({ periodStart: '2020-01-01T00:00:00.000Z', periodEnd: new Date(Date.now() - SETTLEMENT_CLOSE_LAG_MS - 5_000).toISOString() })
    .expect(201);
  return { sellerId, sellerMobile, settlement: expectSuccess<SettlementBody>(res.body).data };
}

const setStatus = (id: string, status: string, reference?: string) =>
  asAdmin(api().patch(`/api/v1/admin/settlements/${id}/status`)).send({ status, ...(reference ? { reference } : {}) });

const png = () => sharp({ create: { width: 40, height: 40, channels: 3, background: '#1E8E3E' } }).png().toBuffer();
const uploadProof = (id: string, bytes: Buffer, name = 'proof.png', type = 'image/png', token = admin) =>
  api().post(`/api/v1/admin/settlements/${id}/payout-proof`).set('Authorization', bearer(token)).attach('file', bytes, { filename: name, contentType: type });

/** Raw response bytes (supertest buffers binary bodies with this parser). */
const binary = (res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c?: Buffer) => c && chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('payment reference', () => {
  it('is stored when the admin marks the settlement PAID and shown to admin and seller; amounts never change', async () => {
    const { settlement, sellerMobile } = await realSettlement(2);
    const before = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } });

    await setStatus(settlement.id, 'PROCESSING').expect(200);
    await setStatus(settlement.id, 'PAID', 'UTR 4123 5566 7788').expect(200);

    const adminView = expectSuccess<SettlementBody>((await asAdmin(api().get(`/api/v1/admin/settlements/${settlement.id}`)).expect(200)).body).data;
    expect(adminView).toMatchObject({ status: 'PAID', payoutReference: 'UTR 4123 5566 7788', hasPayoutProof: false });

    const seller = await sellerToken(sellerMobile);
    const own = expectSuccess<SettlementBody>((await api().get(`/api/v1/seller/settlements/${settlement.id}`).set('Authorization', bearer(seller)).expect(200)).body).data;
    expect(own.payoutReference).toBe('UTR 4123 5566 7788');

    const after = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    for (const field of ['grossSalesPaise', 'commissionPaise', 'deductionsPaise', 'netPayablePaise', 'periodStart', 'periodEnd'] as const) {
      expect(after[field]).toEqual(before[field]);
    }
  });
});

describe('payment proof', () => {
  it('can be attached while PROCESSING or PAID (not PENDING); stored privately and read back byte for byte', async () => {
    const { settlement } = await realSettlement(1);
    const image = await png();

    const early = await uploadProof(settlement.id, image);
    expect(early.status).toBe(409);
    expect(expectError(early.body).code).toBe('INVALID_STATUS_TRANSITION');

    await setStatus(settlement.id, 'PROCESSING').expect(200);
    const attached = expectSuccess<{ hasPayoutProof: boolean; payoutProofContentType: string }>((await uploadProof(settlement.id, image).expect(200)).body).data;
    expect(attached).toMatchObject({ hasPayoutProof: true, payoutProofContentType: 'image/png' });

    const row = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(row.payoutProofKey).toMatch(new RegExp(`^settlement-proofs/${settlement.id}/[0-9a-f-]{36}\\.png$`));
    expect(await prisma.auditLog.count({ where: { action: 'settlement.payout_proof', entityId: settlement.id } })).toBe(1);

    const read = await asAdmin(api().get(`/api/v1/admin/settlements/${settlement.id}/payout-proof`)).buffer(true).parse(binary).expect(200);
    expect(read.headers['content-type']).toBe('image/png');
    expect(read.headers['cache-control']).toContain('no-store');
    expect(Buffer.compare(read.body as Buffer, image)).toBe(0);

    // Marking PAID afterwards keeps the proof and the reference together.
    await setStatus(settlement.id, 'PAID', 'UPI 612345678901').expect(200);
    const paid = expectSuccess<SettlementBody>((await asAdmin(api().get(`/api/v1/admin/settlements/${settlement.id}`)).expect(200)).body).data;
    expect(paid).toMatchObject({ status: 'PAID', payoutReference: 'UPI 612345678901', hasPayoutProof: true });
  });

  it('accepts a receipt PDF; replacing the proof removes the old file; a fake image or an oversize file is refused', async () => {
    const { settlement } = await realSettlement(1);
    await setStatus(settlement.id, 'PROCESSING').expect(200);
    await setStatus(settlement.id, 'PAID', 'UTR 1').expect(200);

    await uploadProof(settlement.id, await png()).expect(200);
    const firstKey = (await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).payoutProofKey!;

    const receipt = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');
    const replaced = await uploadProof(settlement.id, receipt, 'receipt.pdf', 'application/pdf').expect(200);
    expect(expectSuccess<{ payoutProofContentType: string }>(replaced.body).data.payoutProofContentType).toBe('application/pdf');
    await expect(privateDocuments.get(firstKey)).rejects.toBeTruthy();

    const fake = await uploadProof(settlement.id, Buffer.from('this is not an image at all'), 'x.png', 'image/png');
    expect(fake.status).toBe(415);
    expect(expectError(fake.body).code).toBe('UNSUPPORTED_FILE_TYPE');

    const huge = Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024)]);
    expect(expectError((await uploadProof(settlement.id, huge)).body).code).toBe('FILE_TOO_LARGE');

    const exe = await uploadProof(settlement.id, Buffer.from('MZ'), 'run.exe', 'application/octet-stream');
    expect(expectError(exe.body).code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('the own seller sees it only once PAID; another seller and a seller upload are refused', async () => {
    const { settlement, sellerMobile } = await realSettlement(1);
    await seedSeller('Other Store', '9400000702');
    const own = await sellerToken(sellerMobile);
    const other = await sellerToken('9400000702');
    const sellerProof = (token: string) => api().get(`/api/v1/seller/settlements/${settlement.id}/payout-proof`).set('Authorization', bearer(token));

    await setStatus(settlement.id, 'PROCESSING').expect(200);
    await uploadProof(settlement.id, await png()).expect(200);
    expect((await sellerProof(own)).status).toBe(404); // not paid yet

    await setStatus(settlement.id, 'PAID', 'UTR 2').expect(200);
    const seen = await sellerProof(own).buffer(true).parse(binary).expect(200);
    expect(seen.headers['content-type']).toBe('image/png');
    expect((await sellerProof(other)).status).toBe(404);

    // A seller can never attach or replace a proof (admin endpoint, no seller route).
    expect((await uploadProof(settlement.id, await png(), 'p.png', 'image/png', own)).status).toBe(403);
    expect((await api().get(`/api/v1/admin/settlements/${settlement.id}/payout-proof`)).status).toBe(401);
  });
});

describe('statement PDF', () => {
  it('admin and the own seller download a real PDF; others cannot', async () => {
    const { settlement, sellerMobile, sellerId } = await realSettlement(3);
    await seedSeller('Other Store', '9400000703');
    const seller = await sellerToken(sellerMobile);
    const other = await sellerToken('9400000703');
    const code = (await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).code;

    const adminPdf = await asAdmin(api().get(`/api/v1/admin/settlements/${settlement.id}/statement.pdf`)).buffer(true).parse(binary).expect(200);
    expect(adminPdf.headers['content-type']).toBe('application/pdf');
    expect(adminPdf.headers['content-disposition']).toContain(`attachment; filename="Aadione-Statement-${code}-`);
    expect((adminPdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const sellerPdf = await api().get(`/api/v1/seller/settlements/${settlement.id}/statement.pdf`).set('Authorization', bearer(seller)).buffer(true).parse(binary).expect(200);
    expect((sellerPdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    expect((await api().get(`/api/v1/seller/settlements/${settlement.id}/statement.pdf`).set('Authorization', bearer(other))).status).toBe(404);
    expect((await api().get(`/api/v1/admin/settlements/${settlement.id}/statement.pdf`)).status).toBe(401);
    expect((await api().get(`/api/v1/admin/settlements/${settlement.id}/statement.pdf`).set('Authorization', bearer(seller))).status).toBe(403);

    // Generating a statement changes nothing.
    const after = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(after.status).toBe('PENDING');
    expect(after.netPayablePaise).toBe(settlement.netPayablePaise);
  });

  it('every figure in the statement equals the stored settlement, and the PDF draws exactly those figures', async () => {
    const { settlement } = await realSettlement(3);
    await setStatus(settlement.id, 'PROCESSING').expect(200);
    await setStatus(settlement.id, 'PAID', 'UTR 9988776655').expect(200);
    const stored = await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } });

    const data = await buildStatementData(settlement.id);
    expect(data.earnings).toMatchObject({
      grossSalesPaise: stored.grossSalesPaise,
      commissionPaise: stored.commissionPaise,
      deductionsPaise: stored.deductionsPaise,
      netPayablePaise: stored.netPayablePaise,
      sellerEarningsPaise: stored.grossSalesPaise - stored.commissionPaise,
      commissionRatePercent: '10.00%',
    });
    expect(data.orders).toHaveLength(3);
    expect(data.orders.reduce((a, o) => a + o.amountPaise, 0)).toBe(stored.grossSalesPaise);
    expect(data.orders.reduce((a, o) => a + o.commissionPaise, 0)).toBe(stored.commissionPaise);
    expect(data.orders.reduce((a, o) => a + o.earningPaise, 0)).toBe(stored.grossSalesPaise - stored.commissionPaise);
    expect(data.summary).toEqual({ totalPayablePaise: stored.netPayablePaise, amountPaidPaise: stored.netPayablePaise, remainingPaise: 0, status: 'PAID' });
    expect(data.payments[0]).toMatchObject({ isThisStatement: true, reference: 'UTR 9988776655', paidPaise: stored.netPayablePaise });

    const drawn: string[] = [];
    await renderStatementPdf(data, { trace: (text) => drawn.push(text) });
    for (const figure of [stored.grossSalesPaise, stored.netPayablePaise, stored.grossSalesPaise - stored.commissionPaise]) {
      expect(drawn).toContain(formatMoney(figure));
    }
    expect(drawn).toContain(formatMoney(-stored.commissionPaise));
    expect(drawn).toContain('UTR 9988776655');
    expect(drawn).toContain('Paid');
    // Order IDs, dates and amounts are never shortened with an ellipsis.
    for (const order of data.orders) {
      expect(drawn).toContain(order.orderNumber);
      expect(drawn).toContain(date(order.placedAt));
      expect(drawn).toContain(date(order.deliveredAt));
      expect(drawn).toContain(formatMoney(order.amountPaise));
    }
    expect(drawn.filter((t) => /^[₹\-−\d#A-Z]/.test(t) && t.endsWith('…'))).toEqual([]);
  });

  it('a long statement runs over several pages: the order table header repeats and every order appears once', async () => {
    const { settlement } = await realSettlement(2);
    const real = await buildStatementData(settlement.id);
    // The real statement, with its order list repeated to 150 lines (layout test only).
    const long: StatementData = {
      ...real,
      orders: Array.from({ length: 150 }, (_, i) => ({ ...real.orders[i % real.orders.length]!, orderNumber: `AD-TEST-${String(i + 1).padStart(4, '0')}` })),
    };
    const pages = new Map<number, string[]>();
    const pdf = await renderStatementPdf(long, { compress: false, trace: (text, page) => pages.set(page, [...(pages.get(page) ?? []), text]) });

    const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(4);
    const all = [...pages.values()].flat();
    for (let i = 1; i <= 150; i++) expect(all.filter((t) => t === `AD-TEST-${String(i).padStart(4, '0')}`)).toHaveLength(1);
    // Each page that lists orders starts that table with its header.
    for (const [page, texts] of pages) {
      if (texts.some((t) => t.startsWith('AD-TEST-'))) expect(texts, `page ${page}`).toContain('Order ID');
      expect(texts, `page ${page}`).toContain(`Page ${page} of ${pageCount}`);
    }
  });
});

describe('final review checks', () => {
  it('the proof is never exposed: no storage key in any response, nothing under /static (even by path traversal)', async () => {
    const { settlement, sellerMobile } = await realSettlement(1);
    await setStatus(settlement.id, 'PROCESSING').expect(200);
    await uploadProof(settlement.id, await png()).expect(200);
    await setStatus(settlement.id, 'PAID', 'UTR 5').expect(200);
    const key = (await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).payoutProofKey!;
    const seller = await sellerToken(sellerMobile);

    const bodies = [
      (await asAdmin(api().get(`/api/v1/admin/settlements/${settlement.id}`)).expect(200)).text,
      (await asAdmin(api().get('/api/v1/admin/settlements')).expect(200)).text,
      (await api().get(`/api/v1/seller/settlements/${settlement.id}`).set('Authorization', bearer(seller)).expect(200)).text,
      (await api().get('/api/v1/seller/settlements').set('Authorization', bearer(seller)).expect(200)).text,
    ];
    for (const body of bodies) {
      expect(body).not.toContain(key);
      expect(body).not.toContain('settlement-proofs');
      expect(body).not.toMatch(/payoutProofKey|storage-private/);
    }
    for (const path of [`/static/${key}`, `/static/../storage-private/${key}`, `/static/%2e%2e/storage-private/${key}`, `/storage-private/${key}`]) {
      expect((await api().get(path)).status, path).toBe(404);
    }
  });

  it('payment history always includes THIS settlement with its own reference and proof, even after 12+ later periods', async () => {
    const { settlement, sellerId } = await realSettlement(1);
    await setStatus(settlement.id, 'PROCESSING').expect(200);
    await uploadProof(settlement.id, await png()).expect(200);
    await setStatus(settlement.id, 'PAID', 'UTR CURRENT-1').expect(200);
    // 14 settlements for LATER periods that were created BEFORE this one.
    const before = new Date((await prisma.sellerSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).createdAt.getTime() - 60_000);
    for (let i = 0; i < 14; i++) {
      await prisma.sellerSettlement.create({
        data: {
          sellerId,
          periodStart: new Date(Date.UTC(2031, i, 1)),
          periodEnd: new Date(Date.UTC(2031, i, 28)),
          grossSalesPaise: 1000,
          commissionPaise: 100,
          netPayablePaise: 900,
          status: 'PAID',
          paidAt: before,
          payoutReference: `UTR LATER-${i}`,
          createdAt: before,
        },
      });
    }
    const data = await buildStatementData(settlement.id);
    expect(data.payments).toHaveLength(12);
    const own = data.payments.filter((p) => p.isThisStatement);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ settlementId: settlement.id, reference: 'UTR CURRENT-1', hasProof: true, status: 'PAID', method: 'Manual transfer' });
    // Latest period first.
    const ends = data.payments.map((p) => p.periodEnd);
    expect([...ends].sort().reverse()).toEqual(ends);
    // Settlements created AFTER this one never appear in it.
    const later = await prisma.sellerSettlement.create({
      data: { sellerId, periodStart: new Date(Date.UTC(2035, 0, 1)), periodEnd: new Date(Date.UTC(2035, 0, 2)), grossSalesPaise: 1, commissionPaise: 0, netPayablePaise: 1 },
    });
    expect((await buildStatementData(settlement.id)).payments.map((p) => p.settlementId)).not.toContain(later.id);
  });

  it('the payment method is never shown as UPI or a bank transfer — only the generic "Manual transfer (method not recorded)"', async () => {
    const { settlement } = await realSettlement(1);
    await setStatus(settlement.id, 'PROCESSING').expect(200);
    await setStatus(settlement.id, 'PAID', 'UPI 612345678901').expect(200);
    const data = await buildStatementData(settlement.id);
    for (const p of data.payments) expect(['Manual transfer', '—']).toContain(p.method);
    const drawn: string[] = [];
    await renderStatementPdf(data, { trace: (text) => drawn.push(text) });
    expect(drawn).toContain('Manual transfer (method not recorded)');
    // "UPI" appears only inside the reference the admin typed and in the generic note — never as a method value.
    expect(drawn.filter((t) => /^(UPI|Bank transfer|NEFT|IMPS)$/i.test(t))).toEqual([]);
    expect(drawn.some((t) => t.includes('the specific method (bank transfer, UPI, …) is not recorded'))).toBe(true);
  });

  it('the order history lists EVERY order the settlement pays for (same rows as its totals)', async () => {
    const { settlement } = await realSettlement(4);
    const detail = expectSuccess<{ sellerOrders: { orderNumber: string }[] }>((await asAdmin(api().get(`/api/v1/admin/settlements/${settlement.id}`)).expect(200)).body).data;
    const data = await buildStatementData(settlement.id);
    expect(data.orders.map((o) => o.orderNumber).sort()).toEqual(detail.sellerOrders.map((o) => o.orderNumber).sort());
    expect(data.orders).toHaveLength(4);
    expect(data.orders.reduce((a, o) => a + o.amountPaise, 0)).toBe(settlement.grossSalesPaise);
  });

  it('seller notifications say Aadione RECORDED a manual payment — never "sent", "bank account" or "will retry"', async () => {
    const paid = await realSettlement(1);
    await setStatus(paid.settlement.id, 'PROCESSING').expect(200);
    await setStatus(paid.settlement.id, 'PAID', 'UTR 7').expect(200);
    const failed = await realSettlement(1, '9400000702', '9400000721');
    await setStatus(failed.settlement.id, 'FAILED').expect(200);

    const notices = await prisma.notification.findMany({
      where: { type: { in: ['SELLER_SETTLEMENT_PAID', 'SELLER_SETTLEMENT_FAILED'] } },
      select: { type: true, title: true, body: true },
    });
    const paidNotice = notices.find((n) => n.type === 'SELLER_SETTLEMENT_PAID')!;
    const failedNotice = notices.find((n) => n.type === 'SELLER_SETTLEMENT_FAILED')!;
    expect(paidNotice).toEqual({
      type: 'SELLER_SETTLEMENT_PAID',
      title: 'Payment recorded',
      body: `Aadione has recorded a manual payment of ${formatPaise(paid.settlement.netPayablePaise)} for your settlement.`,
    });
    expect(failedNotice).toEqual({
      type: 'SELLER_SETTLEMENT_FAILED',
      title: 'Payment not completed',
      body: `Aadione has recorded that the manual payment of ${formatPaise(failed.settlement.netPayablePaise)} for your settlement was not completed. Contact Aadione if you have questions.`,
    });
    for (const n of notices) expect(`${n.title} ${n.body}`).not.toMatch(/payout sent|bank account|retry/i);
  });
});
