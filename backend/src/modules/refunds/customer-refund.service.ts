/**
 * The customer's view of refunds, and customer refund requests.
 *
 * WHAT THE CUSTOMER SEES: one entry per refund GROUP (one per triggering
 * action) — its total, how much is back, a plain status. Never the seller
 * split, never a Cashfree id, never an internal reason. Refunds issued before
 * groups existed are shown one by one, as they were issued: no grouping is
 * invented for them. A request still under review (or rejected) is shown as
 * the request.
 *
 * REQUESTS: for a DELIVERED order, within REFUND_REQUEST_WINDOW_DAYS. The
 * customer picks items, quantities, a category, a description and (for
 * damaged / wrong / quality issues) photos. The amount is the server's —
 * what was paid for those items, minus what earlier approved requests
 * already gave back for them. One request under review per order (also a
 * partial unique index). Photos go to PRIVATE storage only.
 */

import { randomUUID } from 'node:crypto';
import { Prisma, RefundGroupChannel, RefundRequestStatus, type RefundRequestCategory } from '@prisma/client';
import {
  ErrorCode,
  NotificationType,
  OrderStatus,
  Permission,
  SellerOrderStatus,
  type CustomerRefundDto,
  type CustomerRefundRequestDto,
  type CustomerRefundStatus,
  type OrderRefundsDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { buildRefundEvidenceKey, privateDocuments } from '../../infra/storage/private-documents';
import * as notificationService from '../notifications/notification.service';
import { CUSTOMER_REFUND_REQUESTS_ENABLED } from './refund-requests-availability';
import { customerRefundStatus } from './refund-group-status';
import {
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_PHOTOS,
  PHOTO_REQUIRED_CATEGORIES,
  REFUND_REQUEST_WINDOW_DAYS,
  REFUND_REQUEST_WINDOW_MS,
  sniffImageType,
  valueOfQty,
  type RequestedLine,
} from './refund-request-rules';

const log = moduleLogger('refund-requests');

export const REFUND_REQUEST_CATEGORY_LABELS: Record<RefundRequestCategory, string> = {
  MISSING_ITEM: 'Missing item',
  DAMAGED_ITEM: 'Damaged item',
  WRONG_ITEM: 'Wrong item',
  QUALITY_ISSUE: 'Quality issue',
  DELIVERY_DISPUTE: 'Delivery issue',
  OTHER: 'Other issue',
};

const STATUS_LABELS: Record<CustomerRefundStatus, string> = {
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  PROCESSING: 'Refund in progress',
  SUCCESS: 'Refunded',
  // The customer is never told about internal component failures — only that
  // it is delayed and being handled.
  PARTIAL_FAILURE: 'Delayed',
  FAILED: 'Delayed',
  REJECTED: 'Not approved',
};

const LEGACY_STATUS: Record<string, CustomerRefundStatus> = {
  PENDING: 'PROCESSING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'SUCCESS',
  FAILED: 'FAILED',
};

function noteFor(status: CustomerRefundStatus, channel: RefundGroupChannel | null, decisionNote: string | null): string | null {
  switch (status) {
    case 'UNDER_REVIEW':
      return 'We are reviewing your request and will update you soon.';
    case 'REJECTED':
      return decisionNote;
    case 'APPROVED':
      return channel === RefundGroupChannel.MANUAL
        ? 'We will send this amount to you by UPI or bank transfer. Our team may contact you for the details.'
        : null;
    case 'PROCESSING':
      return channel === RefundGroupChannel.MANUAL
        ? 'We have sent the transfer and are confirming it.'
        : 'Banks usually take a few working days to show a refund in your account.';
    case 'PARTIAL_FAILURE':
    case 'FAILED':
      return 'Your refund is taking longer than usual. We are on it — no action is needed from you.';
    default:
      return null;
  }
}

async function loadOwnOrder(userId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true, userId: true, orderNumber: true, status: true, paymentMethod: true, deliveredAt: true },
  });
  if (!order) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
  return order;
}

/* -------------------------------------------------------------------------- */
/* GET /orders/:id/refunds                                                    */
/* -------------------------------------------------------------------------- */

export async function listOrderRefunds(userId: string, orderId: string): Promise<OrderRefundsDto> {
  const order = await loadOwnOrder(userId, orderId);

  const [groups, openRequests, legacy] = await Promise.all([
    prisma.refundGroup.findMany({
      where: { orderId },
      select: {
        id: true,
        status: true,
        channel: true,
        totalPaise: true,
        refundedPaise: true,
        createdAt: true,
        completedAt: true,
        request: { select: { category: true, status: true } },
        refunds: { select: { componentType: true } },
      },
    }),
    prisma.refundRequest.findMany({
      where: { orderId, groupId: null },
      select: { id: true, category: true, status: true, requestedPaise: true, decisionNote: true, createdAt: true, reviewedAt: true },
    }),
    prisma.refund.findMany({
      where: { orderId, groupId: null },
      select: { id: true, amountPaise: true, status: true, createdAt: true, completedAt: true },
    }),
  ]);

  const refunds: CustomerRefundDto[] = [
    ...groups
      .filter((g) => g.totalPaise > 0)
      .map((g): CustomerRefundDto => {
        const status = customerRefundStatus(g.request, g);
        return {
          id: g.id,
          kind: 'REFUND',
          status,
          statusLabel: STATUS_LABELS[status],
          title: g.request
            ? `${REFUND_REQUEST_CATEGORY_LABELS[g.request.category]} — refund`
            : g.refunds.some((r) => r.componentType === 'ORPHAN_PAYMENT')
              ? 'Refund of an extra payment'
              : 'Refund for cancelled items',
          amountPaise: g.totalPaise,
          refundedPaise: g.refundedPaise,
          destination: g.channel === RefundGroupChannel.MANUAL ? 'BANK_TRANSFER' : 'ORIGINAL_PAYMENT',
          note: noteFor(status, g.channel, null),
          createdAt: g.createdAt.toISOString(),
          completedAt: g.completedAt?.toISOString() ?? null,
        };
      }),
    ...openRequests.map((r): CustomerRefundDto => {
      const status = customerRefundStatus(r, null);
      return {
        id: r.id,
        kind: 'REQUEST',
        status,
        statusLabel: STATUS_LABELS[status],
        title: `${REFUND_REQUEST_CATEGORY_LABELS[r.category]} — refund request`,
        amountPaise: r.requestedPaise,
        refundedPaise: 0,
        destination: order.paymentMethod === 'COD' ? 'BANK_TRANSFER' : 'ORIGINAL_PAYMENT',
        note: noteFor(status, null, r.decisionNote),
        createdAt: r.createdAt.toISOString(),
        completedAt: null,
      };
    }),
    // Issued before refund groups: one entry per refund, exactly as issued.
    ...legacy.map((r): CustomerRefundDto => {
      const status = LEGACY_STATUS[r.status] ?? 'PROCESSING';
      return {
        id: r.id,
        kind: 'LEGACY',
        status,
        statusLabel: STATUS_LABELS[status],
        title: 'Refund',
        amountPaise: r.amountPaise,
        refundedPaise: r.status === 'COMPLETED' ? r.amountPaise : 0,
        destination: 'ORIGINAL_PAYMENT',
        note: noteFor(status, null, null),
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
      };
    }),
  ].sort((x, y) => y.createdAt.localeCompare(x.createdAt));

  return { refunds, request: await requestEligibility(order) };
}

/* -------------------------------------------------------------------------- */
/* Eligibility and valuation                                                   */
/* -------------------------------------------------------------------------- */

interface OrderForRequest {
  id: string;
  status: string;
  deliveredAt: Date | null;
}

/** Per order item: what the customer paid, and what approved requests already gave back. */
async function refundableItems(db: Tx | typeof prisma, orderId: string) {
  const items = await db.orderItem.findMany({
    where: { sellerOrder: { orderId } },
    select: {
      id: true,
      qty: true,
      lineTotalPaise: true,
      couponDiscountPaise: true,
      productName: true,
      variantName: true,
      sellerOrder: { select: { id: true, sellerId: true, status: true } },
    },
  });
  const approved = await approvedPerItem(db, orderId);
  return items.map((item) => {
    const paid = valueOfQty(item, item.qty);
    const already = approved.get(item.id) ?? 0;
    const deliveredPortion =
      item.sellerOrder.status !== SellerOrderStatus.CANCELLED && item.sellerOrder.status !== SellerOrderStatus.REJECTED;
    return { ...item, paidPaise: paid, remainingPaise: deliveredPortion ? Math.max(0, paid - already) : 0 };
  });
}

/**
 * What approved requests already allocated per item — from their groups'
 * allocation lines. Counted whether or not that refund has completed yet:
 * an approval is a commitment (a failed part is retried, never re-requested).
 */
async function approvedPerItem(db: Tx | typeof prisma, orderId: string): Promise<Map<string, number>> {
  const groups = await db.refundGroup.findMany({
    where: { orderId, origin: 'CUSTOMER_REQUEST' },
    select: { allocation: true },
  });
  const out = new Map<string, number>();
  for (const group of groups) {
    for (const line of allocationLines(group.allocation)) {
      out.set(line.orderItemId, (out.get(line.orderItemId) ?? 0) + line.amountPaise);
    }
  }
  return out;
}

export interface AllocationLine {
  orderItemId: string;
  sellerOrderId: string;
  sellerId: string;
  amountPaise: number;
}

export function allocationLines(allocation: Prisma.JsonValue | null): AllocationLine[] {
  if (!Array.isArray(allocation)) return [];
  return allocation.filter(
    (l): l is Prisma.JsonObject & AllocationLine =>
      !!l && typeof l === 'object' && !Array.isArray(l) && typeof l['orderItemId'] === 'string' && typeof l['amountPaise'] === 'number',
  );
}

export { refundableItems };

async function requestEligibility(order: OrderForRequest): Promise<OrderRefundsDto['request']> {
  const base = { windowEndsAt: null as string | null, refundableItemIds: [] as string[], photoRequiredCategories: [...PHOTO_REQUIRED_CATEGORIES] as RefundRequestCategory[] };
  // Customer requests are switched off for now: never offered.
  if (!CUSTOMER_REFUND_REQUESTS_ENABLED) return { eligible: false, reason: null, ...base };
  if (order.status !== OrderStatus.DELIVERED) return { eligible: false, reason: null, ...base };
  const deliveredAt = order.deliveredAt ?? null;
  const windowEnds = deliveredAt ? new Date(deliveredAt.getTime() + REFUND_REQUEST_WINDOW_MS) : null;
  const withWindow = { ...base, windowEndsAt: windowEnds?.toISOString() ?? null };
  if (!windowEnds || windowEnds.getTime() < Date.now()) {
    return { eligible: false, reason: `Refund requests can be made within ${REFUND_REQUEST_WINDOW_DAYS} days of delivery.`, ...withWindow };
  }
  const open = await prisma.refundRequest.count({ where: { orderId: order.id, status: RefundRequestStatus.UNDER_REVIEW } });
  if (open > 0) return { eligible: false, reason: 'Your refund request for this order is being reviewed.', ...withWindow };
  const items = (await refundableItems(prisma, order.id)).filter((i) => i.remainingPaise > 0);
  if (items.length === 0) return { eligible: false, reason: 'Everything on this order has already been refunded.', ...withWindow };
  return { eligible: true, reason: null, ...withWindow, refundableItemIds: items.map((i) => i.id) };
}

/* -------------------------------------------------------------------------- */
/* POST /orders/:id/refund-requests                                           */
/* -------------------------------------------------------------------------- */

export interface CreateRefundRequestInput {
  category: RefundRequestCategory;
  description: string;
  items: { orderItemId: string; qty: number }[];
}

export interface EvidencePhoto {
  buffer: Buffer;
  size: number;
}

export async function createRefundRequest(
  userId: string,
  orderId: string,
  input: CreateRefundRequestInput,
  photos: readonly EvidencePhoto[],
): Promise<CustomerRefundRequestDto> {
  const order = await loadOwnOrder(userId, orderId);

  // Photos: count, size and the ACTUAL bytes (never the client's claimed type).
  if (photos.length > MAX_EVIDENCE_PHOTOS) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `Attach at most ${MAX_EVIDENCE_PHOTOS} photos.` });
  }
  if ((PHOTO_REQUIRED_CATEGORIES as readonly string[]).includes(input.category) && photos.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Please add at least one photo of the item.' });
  }
  const typed = photos.map((photo) => {
    if (photo.size > MAX_EVIDENCE_BYTES) throw new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'Each photo must be 5 MB or smaller.' });
    const contentType = sniffImageType(photo.buffer);
    if (!contentType) throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, { message: 'Photos must be JPEG, PNG or WebP images.' });
    return { ...photo, contentType };
  });

  // Switched off for now (also refused by the route, before any upload).
  if (!CUSTOMER_REFUND_REQUESTS_ENABLED) throw new AppError(ErrorCode.REFUND_REQUESTS_DISABLED);

  // Cheap eligibility first, so nothing is written to storage for a request
  // that is refused anyway (re-checked under the order lock below).
  const eligibility = await requestEligibility(order);
  if (!eligibility.eligible) {
    if (eligibility.reason?.includes('being reviewed')) throw duplicateRequest();
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: eligibility.reason ?? 'A refund can be requested once the order is delivered.',
    });
  }

  const seen = new Set<string>();
  for (const line of input.items) {
    if (seen.has(line.orderItemId)) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Each item can be listed once.' });
    seen.add(line.orderItemId);
  }

  // Photos are written first under server-made keys, then the rows; if the
  // rows fail, the files are removed again (best effort — they are private).
  const requestId = randomUUID();
  const stored: { key: string; contentType: string; sizeBytes: number }[] = [];
  try {
    for (const photo of typed) {
      const key = buildRefundEvidenceKey(requestId, photo.contentType);
      await privateDocuments.put(key, photo.buffer, photo.contentType);
      stored.push({ key, contentType: photo.contentType, sizeBytes: photo.size });
    }

    const created = await runInTransaction(async (tx) => {
      // Serialises requests for one order (and the eligibility read below).
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, deliveredAt: true } });
      if (current.status !== OrderStatus.DELIVERED) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'A refund can be requested once the order is delivered.' });
      }
      if (!current.deliveredAt || current.deliveredAt.getTime() + REFUND_REQUEST_WINDOW_MS < Date.now()) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message: `Refund requests can be made within ${REFUND_REQUEST_WINDOW_DAYS} days of delivery.`,
        });
      }
      const open = await tx.refundRequest.count({ where: { orderId: order.id, status: RefundRequestStatus.UNDER_REVIEW } });
      if (open > 0) throw duplicateRequest();

      const items = new Map((await refundableItems(tx, order.id)).map((i) => [i.id, i]));
      const lines: (RequestedLine & { sellerId: string; productName: string; variantName: string })[] = input.items.map((line) => {
        const item = items.get(line.orderItemId);
        if (!item) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'One of the items is not part of this order.' });
        if (line.qty < 1 || line.qty > item.qty) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `Choose between 1 and ${item.qty} of "${item.productName}".` });
        }
        const amountPaise = Math.min(valueOfQty(item, line.qty), item.remainingPaise);
        if (amountPaise <= 0) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `"${item.productName}" has already been refunded.` });
        }
        return {
          orderItemId: item.id,
          sellerOrderId: item.sellerOrder.id,
          sellerId: item.sellerOrder.sellerId,
          productName: item.productName,
          variantName: item.variantName,
          qty: line.qty,
          amountPaise,
        };
      });
      const requestedPaise = lines.reduce((sum, l) => sum + l.amountPaise, 0);

      const request = await tx.refundRequest.create({
        data: {
          id: requestId,
          orderId: order.id,
          userId,
          category: input.category,
          description: input.description,
          items: lines as unknown as Prisma.InputJsonValue,
          requestedPaise,
          evidence: { create: stored.map((s) => ({ storageKey: s.key, contentType: s.contentType, sizeBytes: s.sizeBytes })) },
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'refund_request.create',
          entityType: 'Order',
          entityId: order.id,
          after: { requestId, category: input.category, requestedPaise, lines: lines.length, photos: stored.length },
        },
      });
      return request;
    });

    await notificationService.notify({
      userId,
      type: NotificationType.REFUND_UPDATE,
      dedupeKey: `refund-request:${created.id}:RECEIVED`,
      orderId: order.id,
      context: { orderNumber: order.orderNumber, refundStage: 'REQUEST_RECEIVED' },
    });
    await notificationService.notifyAdmins(Permission.ORDER_REFUND, {
      type: NotificationType.ADMIN_REFUND_REQUEST,
      dedupeKey: `refund-request:${created.id}:admin`,
      orderId: order.id,
      context: { orderNumber: order.orderNumber, amountPaise: created.requestedPaise },
    });
    log.info({ requestId: created.id, orderId: order.id, requestedPaise: created.requestedPaise }, 'refund request created');
    return getRefundRequest(userId, created.id);
  } catch (error) {
    for (const s of stored) await privateDocuments.remove(s.key);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw duplicateRequest();
    throw error;
  }
}

function duplicateRequest(): AppError {
  return new AppError(ErrorCode.INVALID_STATUS_TRANSITION, { message: 'Your refund request for this order is already being reviewed.' });
}

/* -------------------------------------------------------------------------- */
/* GET /refund-requests/:id                                                   */
/* -------------------------------------------------------------------------- */

export async function getRefundRequest(userId: string, requestId: string): Promise<CustomerRefundRequestDto> {
  const request = await prisma.refundRequest.findFirst({
    where: { id: requestId, userId },
    include: {
      order: { select: { orderNumber: true } },
      group: { select: { status: true, channel: true, totalPaise: true, refundedPaise: true } },
      _count: { select: { evidence: true } },
    },
  });
  if (!request) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Refund request not found.' });
  const status = customerRefundStatus(request, request.group);
  const lines = Array.isArray(request.items) ? (request.items as unknown as { orderItemId: string; productName: string; variantName: string; qty: number; amountPaise: number }[]) : [];
  return {
    id: request.id,
    orderId: request.orderId,
    orderNumber: request.order.orderNumber,
    category: request.category,
    categoryLabel: REFUND_REQUEST_CATEGORY_LABELS[request.category],
    description: request.description,
    items: lines.map((l) => ({ orderItemId: l.orderItemId, productName: l.productName, variantName: l.variantName, qty: l.qty, amountPaise: l.amountPaise })),
    requestedPaise: request.requestedPaise,
    approvedPaise: request.approvedPaise,
    photoCount: request._count.evidence,
    status,
    statusLabel: STATUS_LABELS[status],
    note: noteFor(status, request.group?.channel ?? null, request.decisionNote),
    refundedPaise: request.group?.refundedPaise ?? 0,
    createdAt: request.createdAt.toISOString(),
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
  };
}
