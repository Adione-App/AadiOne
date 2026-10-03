/**
 * Unit tests for the shared contract — the pure functions all three projects
 * depend on. No database, no HTTP.
 *
 * These matter disproportionately: every rupee, every serviceability decision
 * and every COD outcome flows through this handful of functions, and they are
 * copied verbatim into the web and mobile projects.
 */

import { describe, expect, it } from 'vitest';
import {
  CodPolicy,
  OrderStatus,
  SellerOrderStatus,
  ActorType,
  canTransition,
  canActorTransition,
  canTransitionSellerOrder,
  canActorTransitionSellerOrder,
  toCustomerTimelineStep,
  toOrderBucket,
  CustomerTimelineStep,
  ALLOWED_TRANSITIONS,
  ALLOWED_SELLER_ORDER_TRANSITIONS,
} from '../../src/shared';
import {
  calculateDistance,
  checkServiceability,
  estimateDeliveryTime,
  resolveDeliveryFeePaise,
  toRoadDistanceKm,
} from '../../src/shared/distance';
import {
  discountPercent,
  extractInclusiveTaxPaise,
  formatPaise,
  percentOfPaise,
  rupeesToPaise,
} from '../../src/shared/money';
import { resolveItemCodPolicy, resolveOrderCodEligibility } from '../../src/shared/cod';
import { normalizeIndianMobile, maskMobile } from '../../src/shared/phone';
import { isWithinWindow, parseTimeToMinutes } from '../../src/shared/datetime';

describe('money', () => {
  it('converts rupees to paise without floating-point drift', () => {
    // 0.1 + 0.2 style errors are exactly why money is stored as integers.
    expect(rupeesToPaise(290)).toBe(29000);
    expect(rupeesToPaise(249.99)).toBe(24999);
    expect(rupeesToPaise(0.1)).toBe(10);
  });

  it('formats whole rupees without decimals and part-rupees with them', () => {
    expect(formatPaise(29000)).toBe('₹290');
    expect(formatPaise(24999)).toBe('₹249.99');
  });

  it('floors the discount percentage so we never overstate a saving', () => {
    expect(discountPercent(28500, 24900)).toBe(12); // 12.63% -> 12
    expect(discountPercent(2400, 2000)).toBe(16); // 16.67% -> 16
    expect(discountPercent(1000, 1000)).toBe(0);
    expect(discountPercent(0, 0)).toBe(0);
  });

  it('extracts tax from a tax-inclusive price rather than adding it', () => {
    // ₹105 inclusive of 5% GST contains ₹5 of tax, not ₹5.25.
    expect(extractInclusiveTaxPaise(10500, 500)).toBe(500);
    expect(extractInclusiveTaxPaise(11800, 1800)).toBe(1800);
    expect(extractInclusiveTaxPaise(10000, 0)).toBe(0);
  });

  it('rounds percentages half-up at the single point they are applied', () => {
    expect(percentOfPaise(1000, 15)).toBe(150);
    expect(percentOfPaise(333, 15)).toBe(50); // 49.95 -> 50
  });
});

describe('distance and serviceability', () => {
  const STORE = { lat: 27.6094, lng: 75.1399 }; // Sikar

  it('computes a known distance correctly', () => {
    // Sikar -> Jaipur is roughly 100 km in a straight line.
    const km = calculateDistance(STORE.lat, STORE.lng, 26.9124, 75.7873);
    expect(km).toBeGreaterThan(90);
    expect(km).toBeLessThan(110);
  });

  it('returns zero for the same point', () => {
    expect(calculateDistance(STORE.lat, STORE.lng, STORE.lat, STORE.lng)).toBe(0);
  });

  it('treats the radius as inclusive at the boundary', () => {
    const result = checkServiceability(STORE.lat, STORE.lng, STORE.lat, STORE.lng, 10);
    expect(result.serviceable).toBe(true);
    expect(result.distanceKm).toBe(0);
  });

  it('rejects a point beyond the configured radius', () => {
    const { serviceable, distanceKm } = checkServiceability(
      26.9124,
      75.7873,
      STORE.lat,
      STORE.lng,
      10,
    );
    expect(serviceable).toBe(false);
    expect(distanceKm).toBeGreaterThan(10);
  });

  it('never bakes in a default radius — the caller must supply it', () => {
    // The same coordinates flip decision purely on the configured value, which
    // is what proves MAX_SERVICE_RADIUS_KM is honoured rather than a constant.
    const point = { lat: 27.6364, lng: 75.1399 }; // ~3 km due north of the store
    const distance = calculateDistance(point.lat, point.lng, STORE.lat, STORE.lng);
    expect(distance).toBeGreaterThan(2.5);
    expect(distance).toBeLessThan(3.5);

    expect(checkServiceability(point.lat, point.lng, STORE.lat, STORE.lng, 5).serviceable)
      .toBe(true);
    expect(checkServiceability(point.lat, point.lng, STORE.lat, STORE.lng, 1).serviceable)
      .toBe(false);
  });

  it('applies the road factor to travel distance but not to serviceability', () => {
    expect(toRoadDistanceKm(10, 1.3)).toBe(13);
    // A point 9.8 km straight-line is inside a 10 km promise...
    expect(checkServiceability(0, 0, 0, 0.088, 10).serviceable).toBe(true);
    // ...while being priced and promised as a ~12.7 km ride.
    expect(toRoadDistanceKm(9.79, 1.3)).toBeGreaterThan(12);
  });

  it('picks the delivery fee slab covering the distance', () => {
    const slabs = [
      { maxKm: 3, feePaise: 2000 },
      { maxKm: 6, feePaise: 3000 },
      { maxKm: 10, feePaise: 4000 },
    ];
    expect(resolveDeliveryFeePaise(1.2, slabs)).toBe(2000);
    expect(resolveDeliveryFeePaise(3, slabs)).toBe(2000); // boundary is inclusive
    expect(resolveDeliveryFeePaise(4.2, slabs)).toBe(3000);
    expect(resolveDeliveryFeePaise(9.9, slabs)).toBe(4000);
    // Beyond the last slab falls back rather than returning undefined.
    expect(resolveDeliveryFeePaise(50, slabs)).toBe(4000);
  });
});

describe('ETA', () => {
  const base = {
    itemCount: 2,
    activeOrderCount: 0,
    roadDistanceFactor: 1.3,
    basePreparationMinutes: 10,
    perItemPickSeconds: 20,
    avgDeliverySpeedKmph: 25,
    ordersPerRiderBatch: 3,
    batchDelayMinutes: 8,
    etaBufferMinutes: 3,
  };

  it('matches the worked example in the PRD', () => {
    // 3.2 km, 2 items, quiet store -> ~23 min, displayed as 20-25.
    const eta = estimateDeliveryTime({ ...base, distanceKm: 3.2 });
    expect(eta.etaMinutes).toBe(25);
    expect(eta.etaMinMinutes).toBe(20);
    expect(eta.etaMaxMinutes).toBe(30);
    expect(eta.breakdown.roadDistanceKm).toBeCloseTo(4.16, 1);
  });

  it('grows with distance', () => {
    const near = estimateDeliveryTime({ ...base, distanceKm: 1 });
    const far = estimateDeliveryTime({ ...base, distanceKm: 9 });
    expect(far.etaMinutes).toBeGreaterThan(near.etaMinutes);
  });

  it('extends when the store is busy', () => {
    const quiet = estimateDeliveryTime({ ...base, distanceKm: 3 });
    const busy = estimateDeliveryTime({ ...base, distanceKm: 3, activeOrderCount: 9 });
    expect(busy.etaMinutes).toBeGreaterThan(quiet.etaMinutes);
  });

  it('never promises less than five minutes', () => {
    const instant = estimateDeliveryTime({
      ...base,
      distanceKm: 0,
      itemCount: 0,
      basePreparationMinutes: 0,
      etaBufferMinutes: 0,
    });
    expect(instant.etaMinutes).toBeGreaterThanOrEqual(5);
  });
});

describe('COD resolution', () => {
  it('takes the first non-INHERIT value walking outward', () => {
    expect(
      resolveItemCodPolicy(
        {
          sellerListing: CodPolicy.INHERIT,
          productVariant: CodPolicy.INHERIT,
          product: CodPolicy.DENY,
          categoryChain: [CodPolicy.ALLOW],
          seller: CodPolicy.ALLOW,
        },
        CodPolicy.ALLOW,
      ),
    ).toBe(CodPolicy.DENY);
  });

  it('lets a specific level override a broader DENY', () => {
    expect(
      resolveItemCodPolicy(
        {
          sellerListing: CodPolicy.ALLOW,
          categoryChain: [CodPolicy.DENY],
          seller: CodPolicy.ALLOW,
        },
        CodPolicy.ALLOW,
      ),
    ).toBe(CodPolicy.ALLOW);
  });

  it('falls back to the configured default when every level inherits', () => {
    expect(resolveItemCodPolicy({}, CodPolicy.DENY)).toBe(CodPolicy.DENY);
    expect(resolveItemCodPolicy({}, CodPolicy.ALLOW)).toBe(CodPolicy.ALLOW);
  });

  it('walks up the category chain to the root', () => {
    // Leaf inherits, its parent denies — e.g. Vegetables set to DENY.
    expect(
      resolveItemCodPolicy(
        { categoryChain: [CodPolicy.INHERIT, CodPolicy.DENY], seller: CodPolicy.ALLOW },
        CodPolicy.ALLOW,
      ),
    ).toBe(CodPolicy.DENY);
  });

  const order = {
    sellerPolicy: CodPolicy.ALLOW,
    defaultPolicy: CodPolicy.ALLOW,
    orderTotalPaise: 50000,
    codMaxOrderValuePaise: 300000,
    isFirstOrder: false,
    codFirstOrderMaxPaise: 100000,
  };

  it('allows COD when every item allows it', () => {
    const result = resolveOrderCodEligibility({
      ...order,
      items: [
        { productName: 'Atta', resolvedPolicy: CodPolicy.ALLOW },
        { productName: 'Rice', resolvedPolicy: CodPolicy.ALLOW },
      ],
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('blocks the whole order for one denied item, and names it', () => {
    // Most restrictive wins — and the UI must be able to explain WHY rather
    // than silently hiding the option.
    const result = resolveOrderCodEligibility({
      ...order,
      items: [
        { productName: 'Atta', resolvedPolicy: CodPolicy.ALLOW },
        { productName: 'Fresh Tomatoes', resolvedPolicy: CodPolicy.DENY },
      ],
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('ITEM_DENIED');
    expect(result.reason).toContain('Fresh Tomatoes');
  });

  it('enforces the order-value cap', () => {
    const result = resolveOrderCodEligibility({
      ...order,
      orderTotalPaise: 400000,
      items: [{ productName: 'Atta', resolvedPolicy: CodPolicy.ALLOW }],
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('OVER_MAX_VALUE');
  });

  it('applies a tighter cap to a first order', () => {
    const items = [{ productName: 'Atta', resolvedPolicy: CodPolicy.ALLOW }];
    expect(
      resolveOrderCodEligibility({ ...order, items, orderTotalPaise: 150000 }).allowed,
    ).toBe(true);
    const first = resolveOrderCodEligibility({
      ...order,
      items,
      orderTotalPaise: 150000,
      isFirstOrder: true,
    });
    expect(first.allowed).toBe(false);
    expect(first.reasonCode).toBe('OVER_FIRST_ORDER_LIMIT');
  });

  it('honours a customer-level COD block above everything else', () => {
    const result = resolveOrderCodEligibility({
      ...order,
      items: [{ productName: 'Atta', resolvedPolicy: CodPolicy.ALLOW }],
      customerCodBlocked: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('CUSTOMER_BLOCKED');
  });
});

describe('seller order state machine (per-seller)', () => {
  it('permits the happy path end to end', () => {
    const path = [
      SellerOrderStatus.NEW,
      SellerOrderStatus.ACCEPTED,
      SellerOrderStatus.PREPARING,
      SellerOrderStatus.READY_FOR_PICKUP,
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(
        canTransitionSellerOrder(path[i]!, path[i + 1]!),
        `${path[i]} -> ${path[i + 1]}`,
      ).toBe(true);
    }
  });

  it('rejects skipping ahead', () => {
    expect(canTransitionSellerOrder(SellerOrderStatus.NEW, SellerOrderStatus.READY_FOR_PICKUP)).toBe(
      false,
    );
  });

  it('rejects moving backwards', () => {
    expect(
      canTransitionSellerOrder(SellerOrderStatus.PREPARING, SellerOrderStatus.ACCEPTED),
    ).toBe(false);
  });

  it('treats REJECTED and CANCELLED as final', () => {
    expect(ALLOWED_SELLER_ORDER_TRANSITIONS[SellerOrderStatus.REJECTED]).toHaveLength(0);
    expect(ALLOWED_SELLER_ORDER_TRANSITIONS[SellerOrderStatus.CANCELLED]).toHaveLength(0);
  });

  it('restricts who may perform each transition', () => {
    // A customer cannot accept a seller's own order...
    expect(
      canActorTransitionSellerOrder(SellerOrderStatus.NEW, SellerOrderStatus.ACCEPTED, ActorType.CUSTOMER),
    ).toBe(false);
    // ...but may cancel it before the seller has started preparing.
    expect(
      canActorTransitionSellerOrder(SellerOrderStatus.NEW, SellerOrderStatus.CANCELLED, ActorType.CUSTOMER),
    ).toBe(true);
    // Once preparing, only the seller/admin can cancel — not the customer.
    expect(
      canActorTransitionSellerOrder(
        SellerOrderStatus.PREPARING,
        SellerOrderStatus.CANCELLED,
        ActorType.CUSTOMER,
      ),
    ).toBe(false);
    expect(
      canActorTransitionSellerOrder(
        SellerOrderStatus.PREPARING,
        SellerOrderStatus.CANCELLED,
        ActorType.SELLER,
      ),
    ).toBe(true);
  });
});

describe('parent order state machine (aggregate)', () => {
  it('permits the payment and delivery legs', () => {
    const path = [
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.PROCESSING,
      OrderStatus.READY_FOR_PICKUP,
      OrderStatus.PICKED_UP,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED,
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('rejects skipping ahead', () => {
    expect(canTransition(OrderStatus.PROCESSING, OrderStatus.DELIVERED)).toBe(false);
    expect(canTransition(OrderStatus.PROCESSING, OrderStatus.OUT_FOR_DELIVERY)).toBe(false);
  });

  it('rejects moving backwards', () => {
    expect(canTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.PROCESSING)).toBe(false);
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.OUT_FOR_DELIVERY)).toBe(false);
  });

  it('treats DELIVERED as final', () => {
    expect(ALLOWED_TRANSITIONS[OrderStatus.DELIVERED]).toHaveLength(0);
  });

  it('restricts who may perform each transition', () => {
    // A customer cannot dispatch their own order...
    expect(
      canActorTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.PICKED_UP, ActorType.CUSTOMER),
    ).toBe(false);
    // ...but may cancel it before any seller has engaged.
    expect(
      canActorTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, ActorType.CUSTOMER),
    ).toBe(true);
    // The PROCESSING -> CANCELLED edge is derived (system-only) — see
    // order-state.service.ts's recomputeParentOrderStatus — never a direct
    // actor choice, admin included.
    expect(canActorTransition(OrderStatus.PROCESSING, OrderStatus.CANCELLED, ActorType.ADMIN)).toBe(
      false,
    );
    expect(canActorTransition(OrderStatus.PROCESSING, OrderStatus.CANCELLED, ActorType.SYSTEM)).toBe(
      true,
    );
  });

  it('maps unambiguous internal statuses onto the five-step customer timeline', () => {
    expect(toCustomerTimelineStep(OrderStatus.PAYMENT_CONFIRMED)).toBe(CustomerTimelineStep.PLACED);
    expect(toCustomerTimelineStep(OrderStatus.READY_FOR_PICKUP)).toBe(CustomerTimelineStep.PACKED);
    expect(toCustomerTimelineStep(OrderStatus.OUT_FOR_DELIVERY)).toBe(
      CustomerTimelineStep.OUT_FOR_DELIVERY,
    );
    // PROCESSING is ambiguous at this function's level alone — see its own
    // doc comment; disambiguating by the SellerOrders' own progress is
    // order.service.ts's `resolveProcessingSubStep`, not tested here.
    expect(toCustomerTimelineStep(OrderStatus.PROCESSING)).toBe('PROCESSING');
    // Exception states have no place on a progress timeline.
    expect(toCustomerTimelineStep(OrderStatus.CANCELLED)).toBeNull();
    expect(toCustomerTimelineStep(OrderStatus.PENDING_PAYMENT)).toBeNull();
  });

  it('buckets statuses for the My Orders badges', () => {
    expect(toOrderBucket(OrderStatus.DELIVERED)).toBe('DELIVERED');
    expect(toOrderBucket(OrderStatus.CANCELLED)).toBe('CANCELLED');
    expect(toOrderBucket(OrderStatus.PROCESSING)).toBe('ONGOING');
    expect(toOrderBucket(OrderStatus.PARTIALLY_CANCELLED)).toBe('ONGOING');
  });
});

describe('phone', () => {
  it('normalises every format users actually type', () => {
    for (const input of [
      '9876543210',
      '+91 98765 43210',
      '+919876543210',
      '09876543210',
      '91-9876-543210',
      '(+91) 98765-43210',
    ]) {
      expect(normalizeIndianMobile(input), input).toBe('9876543210');
    }
  });

  it('rejects numbers that cannot be Indian mobiles', () => {
    // Indian mobiles start 6-9 and are 10 digits.
    for (const input of ['1234567890', '5876543210', '98765', '', 'abcdefghij']) {
      expect(normalizeIndianMobile(input), input).toBeNull();
    }
  });

  it('masks numbers for logs', () => {
    expect(maskMobile('9876543210')).toBe('98765****10');
  });
});

describe('seller hours', () => {
  it('handles a normal daytime window', () => {
    const open = parseTimeToMinutes('08:00');
    const close = parseTimeToMinutes('22:00');
    expect(isWithinWindow(parseTimeToMinutes('12:30'), open, close)).toBe(true);
    expect(isWithinWindow(parseTimeToMinutes('07:59'), open, close)).toBe(false);
    expect(isWithinWindow(parseTimeToMinutes('22:00'), open, close)).toBe(false);
  });

  it('handles a window crossing midnight', () => {
    // 08:00-01:00 must not be treated as "closed all day" by a naive compare.
    const open = parseTimeToMinutes('08:00');
    const close = parseTimeToMinutes('01:00');
    expect(isWithinWindow(parseTimeToMinutes('23:30'), open, close)).toBe(true);
    expect(isWithinWindow(parseTimeToMinutes('00:30'), open, close)).toBe(true);
    expect(isWithinWindow(parseTimeToMinutes('03:00'), open, close)).toBe(false);
  });
});
