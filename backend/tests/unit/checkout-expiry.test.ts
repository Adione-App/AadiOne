/**
 * Checkout expiry vs the AdiOne payment hold (`planCheckoutExpiry`).
 *
 * Cashfree only accepts an order expiry MORE than 15 minutes away, while the
 * general AdiOne hold is 10 minutes. A Cashfree checkout therefore asks
 * Cashfree for ~16 minutes and stretches only that order's hold to ~17 — and
 * the gateway order ALWAYS ends before the hold does, so a payment can never
 * arrive after the stock was released.
 */

import { describe, expect, it } from 'vitest';
import { planCheckoutExpiry } from '../../src/modules/payments/payment.service';
import { CASHFREE_MIN_EXPIRY_MS } from '../../src/infra/payment/cashfree.provider';

const MIN = 60_000;
const HOLD_MINUTES = 10; // PAYMENT_HOLD_MINUTES — unchanged
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

const freshOrder = { orderCreatedAt: NOW, holdEndsAt: NOW + HOLD_MINUTES * MIN };

describe('planCheckoutExpiry', () => {
  it('a new Cashfree checkout: Cashfree gets ~16 min, this order’s hold is stretched to ~17 min', () => {
    const plan = planCheckoutExpiry({ now: NOW, ...freshOrder, holdMinutes: HOLD_MINUTES, gatewayMinWindowMs: CASHFREE_MIN_EXPIRY_MS });
    expect(plan).toEqual({ gatewayExpiresAt: NOW + 16 * MIN, extendedHoldTo: NOW + 17 * MIN });
    // Comfortably above Cashfree's "more than 15 minutes".
    expect(plan!.gatewayExpiresAt - NOW).toBeGreaterThan(15 * MIN);
    // The hold outlives the Cashfree order by a minute.
    expect(plan!.extendedHoldTo! - plan!.gatewayExpiresAt).toBe(MIN);
  });

  it('a gateway without a minimum keeps the 10-minute hold untouched', () => {
    const plan = planCheckoutExpiry({ now: NOW, ...freshOrder, holdMinutes: HOLD_MINUTES, gatewayMinWindowMs: 0 });
    expect(plan).toEqual({ gatewayExpiresAt: NOW + 9 * MIN, extendedHoldTo: null });
  });

  it('checkout opened late in the hold is still stretched once, to cover the full Cashfree window', () => {
    const now = NOW + 9.5 * MIN;
    const plan = planCheckoutExpiry({ now, ...freshOrder, holdMinutes: HOLD_MINUTES, gatewayMinWindowMs: CASHFREE_MIN_EXPIRY_MS });
    expect(plan).toEqual({ gatewayExpiresAt: now + 16 * MIN, extendedHoldTo: now + 17 * MIN });
  });

  it('never stretches a second time: once the Cashfree window ran out, the time to pay is over', () => {
    // First checkout at creation stretched the hold to +17; the Cashfree order
    // expired at +16. Reopening then would need another 17 minutes.
    const now = NOW + 16.2 * MIN;
    const plan = planCheckoutExpiry({
      now,
      orderCreatedAt: NOW,
      holdEndsAt: NOW + 17 * MIN,
      holdMinutes: HOLD_MINUTES,
      gatewayMinWindowMs: CASHFREE_MIN_EXPIRY_MS,
    });
    expect(plan).toBeNull();
  });

  it('INVARIANT: the Cashfree order always stops taking money at least a minute before AdiOne releases the stock', () => {
    for (let offset = 0; offset < HOLD_MINUTES * MIN; offset += 15_000) {
      const now = NOW + offset;
      const plan = planCheckoutExpiry({ now, ...freshOrder, holdMinutes: HOLD_MINUTES, gatewayMinWindowMs: CASHFREE_MIN_EXPIRY_MS });
      expect(plan).not.toBeNull();
      const holdAfter = plan!.extendedHoldTo ?? freshOrder.holdEndsAt;
      expect(plan!.gatewayExpiresAt).toBeLessThanOrEqual(holdAfter - MIN);
      expect(plan!.gatewayExpiresAt - now).toBeGreaterThan(15 * MIN);
      // Stretching only ever lengthens a hold, never shortens it.
      expect(holdAfter).toBeGreaterThanOrEqual(freshOrder.holdEndsAt);
    }
  });
});
