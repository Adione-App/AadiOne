/**
 * Delivery (Phase 10) — V2: AdiOne runs its OWN platform-wide fleet (#21).
 *
 * `DeliveryAgent` is no longer scoped to a single store/seller — a rider can
 * be assigned to any parent Order regardless of which seller(s) it involves.
 * `DeliveryTask` (V1: DeliveryAssignment) belongs to the PARENT Order, never
 * to an individual SellerOrder (#12) — one pickup+drop-off run per order,
 * deliberately its own model so a future multi-stop version only ever adds a
 * child table here (see schema.prisma's own doc comment).
 */

import { DeliveryTaskStatus, ErrorCode, type DeliveryAgentDto } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { ACTIVE_ORDER_STATUSES } from '../../shared';

export async function listAgents(): Promise<DeliveryAgentDto[]> {
  const agents = await prisma.deliveryAgent.findMany({
    where: { deletedAt: null },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    include: {
      _count: {
        select: {
          tasks: {
            where: {
              status: {
                in: [DeliveryTaskStatus.ASSIGNED, DeliveryTaskStatus.ACCEPTED, DeliveryTaskStatus.PICKED_UP],
              },
            },
          },
        },
      },
    },
  });

  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    mobile: agent.mobile,
    vehicleNumber: agent.vehicleNumber,
    isActive: agent.isActive,
    isAvailable: agent.isAvailable,
    activeOrderCount: agent._count.tasks,
  }));
}

export async function createAgent(
  input: { name: string; mobile: string; vehicleNumber?: string | null },
): Promise<{ id: string }> {
  const existing = await prisma.deliveryAgent.findUnique({ where: { mobile: input.mobile } });
  if (existing) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'A delivery partner with this mobile number already exists.',
    });
  }

  const agent = await prisma.deliveryAgent.create({
    data: {
      name: input.name,
      mobile: input.mobile,
      vehicleNumber: input.vehicleNumber ?? null,
    },
  });
  return { id: agent.id };
}

export async function updateAgent(
  agentId: string,
  input: {
    name?: string;
    mobile?: string;
    vehicleNumber?: string | null;
    isActive?: boolean;
    isAvailable?: boolean;
  },
): Promise<void> {
  await prisma.deliveryAgent.update({
    where: { id: agentId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      ...(input.vehicleNumber !== undefined ? { vehicleNumber: input.vehicleNumber } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
    },
  });
}

/**
 * Soft-deletes an agent, refusing while they still hold live orders — those
 * parcels are physically with that person.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const active = await prisma.deliveryTask.count({
    where: {
      agentId,
      status: {
        in: [DeliveryTaskStatus.ASSIGNED, DeliveryTaskStatus.ACCEPTED, DeliveryTaskStatus.PICKED_UP],
      },
    },
  });

  if (active > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `This partner still has ${active} order(s) in hand. Reassign them first.`,
    });
  }

  await prisma.deliveryAgent.update({
    where: { id: agentId },
    data: { deletedAt: new Date(), isActive: false, isAvailable: false },
  });
}

/**
 * Assigns a PARENT order to a rider.
 *
 * Reassignment cancels the previous task rather than editing it, so the
 * history of who held a parcel and when stays intact — which is what a cash
 * dispute is settled with. The actual pickup (#13: only once every required
 * SellerOrder is ready) is enforced by the order state machine itself at the
 * `READY_FOR_PICKUP -> PICKED_UP` transition, not here — a rider may be
 * pre-assigned earlier so they're on standby the moment it's ready.
 */
export async function assignOrder(
  orderId: string,
  agentId: string,
  assignedByUserId: string,
): Promise<{ taskId: string }> {
  const [order, agent] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId } }),
    prisma.deliveryAgent.findFirst({ where: { id: agentId, deletedAt: null } }),
  ]);

  if (!order) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });
  if (!agent) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Delivery partner not found.' });
  if (!agent.isActive) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This delivery partner is inactive.',
    });
  }
  if (!ACTIVE_ORDER_STATUSES.includes(order.status)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This order is no longer active.',
    });
  }

  const taskId = await runInTransaction(async (tx) => {
    await tx.deliveryTask.updateMany({
      where: { orderId, status: { not: DeliveryTaskStatus.CANCELLED } },
      data: { status: DeliveryTaskStatus.CANCELLED, cancelledAt: new Date() },
    });

    const task = await tx.deliveryTask.create({
      data: {
        orderId,
        agentId,
        assignedByUserId,
        status: DeliveryTaskStatus.ASSIGNED,
      },
    });
    return task.id;
  });

  return { taskId };
}

/** Task states in which a rider is still holding an order that has not left the shop. */
const RELEASABLE_TASK_STATUSES = [DeliveryTaskStatus.ASSIGNED, DeliveryTaskStatus.ACCEPTED];

/**
 * Releases the rider from an order that ended before pickup (fully
 * cancelled/refunded — nothing left to deliver), so it stops counting toward
 * their active orders. The same release a reassignment performs (see
 * `assignOrder`): the task row is kept — who, when and by whom it was
 * assigned — and marked CANCELLED with `cancelledAt`.
 *
 * Never touches an order that was picked up (`pickedUpAt` is set on the
 * PICKED_UP transition; a task's own status stays ASSIGNED until delivery, so
 * it cannot tell), nor a delivered or already-released task. Idempotent: a
 * second call finds nothing left to release. Runs inside the caller's
 * transaction, so the release commits with the cancellation itself.
 */
export async function releaseTasksForCancelledOrder(tx: Tx, orderId: string): Promise<number> {
  const released = await tx.deliveryTask.updateMany({
    where: {
      orderId,
      status: { in: RELEASABLE_TASK_STATUSES },
      order: { pickedUpAt: null, deliveredAt: null },
    },
    data: { status: DeliveryTaskStatus.CANCELLED, cancelledAt: new Date() },
  });
  return released.count;
}

/** Records cash actually handed over on a COD delivery (PRD §2.2 M2). */
export async function recordDelivery(
  orderId: string,
  input: { cashCollectedPaise?: number | null; notes?: string | null },
): Promise<void> {
  await prisma.deliveryTask.updateMany({
    where: { orderId, status: { not: DeliveryTaskStatus.CANCELLED } },
    data: {
      status: DeliveryTaskStatus.DELIVERED,
      deliveredAt: new Date(),
      cashCollectedPaise: input.cashCollectedPaise ?? null,
      notes: input.notes ?? null,
    },
  });
}

/** Day-end "cash to collect" report, per rider, across the whole platform
 * fleet (#21) — no longer scoped to a single seller/store. */
export async function cashSummary(
  from: Date,
  to: Date,
): Promise<{ agentId: string; agentName: string; orderCount: number; cashPaise: number }[]> {
  const rows = await prisma.$queryRaw<
    { agent_id: string; agent_name: string; order_count: bigint; cash_paise: bigint | null }[]
  >`
    SELECT a.id AS agent_id, a.name AS agent_name,
           COUNT(dt.id) AS order_count,
           SUM(COALESCE(dt.cash_collected_paise, 0)) AS cash_paise
    FROM delivery_tasks dt
    JOIN delivery_agents a ON a.id = dt.agent_id
    WHERE dt.status = 'DELIVERED'
      AND dt.delivered_at BETWEEN ${from} AND ${to}
    GROUP BY a.id, a.name
    ORDER BY a.name`;

  return rows.map((row) => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    orderCount: Number(row.order_count),
    cashPaise: Number(row.cash_paise ?? 0),
  }));
}
