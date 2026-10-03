/**
 * Releasing a rider when an order ends before pickup
 * (`releaseTasksForCancelledOrder`), checked against a recording fake
 * transaction: exactly which tasks are released and how. The real
 * cancellation flows (PROCESSING / READY_FOR_PICKUP / delivery-leg orders,
 * rider counts, idempotency) are covered in
 * tests/integration/seller-settlement.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { ActorType, DeliveryTaskStatus, OrderStatus, canActorTransition, canTransition } from '../../src/shared';
import type { Tx } from '../../src/infra/db/prisma';
import { releaseTasksForCancelledOrder } from '../../src/modules/delivery/delivery.service';

const ORDER_ID = '6f1c2b1e-8a4d-4c3b-9d2e-1a2b3c4d5e6f';

function fakeTx(count: number) {
  const calls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const tx = {
    deliveryTask: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.push(args);
        return { count };
      },
    },
  } as unknown as Tx;
  return { tx, calls };
}

describe('releaseTasksForCancelledOrder', () => {
  it('releases only tasks a rider still holds for an order never picked up, keeping the row as CANCELLED', async () => {
    const { tx, calls } = fakeTx(1);
    const before = Date.now();
    expect(await releaseTasksForCancelledOrder(tx, ORDER_ID)).toBe(1);

    expect(calls).toHaveLength(1);
    const [{ where, data }] = calls as [(typeof calls)[number]];
    expect(where).toEqual({
      orderId: ORDER_ID,
      status: { in: [DeliveryTaskStatus.ASSIGNED, DeliveryTaskStatus.ACCEPTED] },
      // A task stays ASSIGNED through pickup, so the ORDER decides: never
      // once it was picked up or delivered.
      order: { pickedUpAt: null, deliveredAt: null },
    });
    // Release = the same as a reassignment: status + cancelledAt only; the
    // assignment history (agent, assignedAt, assignedBy, notes) is untouched.
    expect(Object.keys(data).sort()).toEqual(['cancelledAt', 'status']);
    expect(data['status']).toBe(DeliveryTaskStatus.CANCELLED);
    expect((data['cancelledAt'] as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('never selects PICKED_UP, DELIVERED or already CANCELLED tasks', async () => {
    const { tx, calls } = fakeTx(0);
    await releaseTasksForCancelledOrder(tx, ORDER_ID);
    const statuses = (calls[0]!.where['status'] as { in: string[] }).in;
    for (const kept of [DeliveryTaskStatus.PICKED_UP, DeliveryTaskStatus.DELIVERED, DeliveryTaskStatus.CANCELLED]) {
      expect(statuses).not.toContain(kept);
    }
  });

  it('is a no-op when nothing is left to release (idempotent repeat, or no rider assigned)', async () => {
    const { tx } = fakeTx(0);
    expect(await releaseTasksForCancelledOrder(tx, ORDER_ID)).toBe(0);
  });

  it('the state machine still only allows full cancellation BEFORE pickup, and never by a rider', () => {
    // So the release (tied to CANCELLED/REFUNDED) cannot run for an order in flight.
    for (const inFlight of [OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED]) {
      expect(canTransition(inFlight, OrderStatus.CANCELLED)).toBe(false);
      expect(canTransition(inFlight, OrderStatus.REFUNDED)).toBe(false);
    }
    expect(canActorTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.PICKED_UP, ActorType.DELIVERY_AGENT)).toBe(true);
    expect(canActorTransition(OrderStatus.PROCESSING, OrderStatus.CANCELLED, ActorType.DELIVERY_AGENT)).toBe(false);
    expect(canActorTransition(OrderStatus.PROCESSING, OrderStatus.CANCELLED, ActorType.ADMIN)).toBe(false);
    expect(canActorTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, ActorType.CUSTOMER)).toBe(true);
  });
});
