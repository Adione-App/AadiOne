/**
 * Demo seed — development and staging ONLY. Never runs in production.
 *
 * Sample coupons and delivery agents, so checkout and delivery screens have
 * something to work with. No seller and no catalogue: every seller (Aadione
 * included) is created by admin and builds its own categories and products
 * in the Seller Panel — a seeded catalogue would be a hidden, owner-less
 * store, which V2 deliberately does not have.
 */

import { PrismaClient } from '@prisma/client';
import { CouponType } from '../../src/shared';

const COUPONS = [
  {
    code: 'ADIFIRST',
    description: '15% off your first order, up to ₹75',
    type: CouponType.PERCENT,
    discountValue: 15,
    maxDiscountPaise: 7500,
    minOrderPaise: 19900,
    usageLimitPerUser: 1,
  },
  {
    code: 'SAVE50',
    description: '₹50 off orders above ₹499',
    type: CouponType.FLAT,
    discountValue: 5000,
    maxDiscountPaise: null,
    minOrderPaise: 49900,
    usageLimitPerUser: 3,
  },
  {
    code: 'FREESHIP',
    description: 'Free delivery on orders above ₹199',
    type: CouponType.FREE_DELIVERY,
    discountValue: 0,
    maxDiscountPaise: null,
    minOrderPaise: 19900,
    usageLimitPerUser: 5,
  },
];

export async function seedDemoData(prisma: PrismaClient): Promise<void> {
  // --- coupons -------------------------------------------------------------
  for (const coupon of COUPONS) {
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: {},
      create: {
        code: coupon.code,
        description: coupon.description,
        type: coupon.type,
        discountValue: coupon.discountValue,
        maxDiscountPaise: coupon.maxDiscountPaise,
        minOrderPaise: coupon.minOrderPaise,
        usageLimitPerUser: coupon.usageLimitPerUser,
        isActive: true,
      },
    });
  }
  console.log(`  ✓ coupons: ${COUPONS.length}`);

  // --- delivery agents -----------------------------------------------------
  const agents = [
    { name: 'Ramesh Kumar', mobile: '9876500001', vehicleNumber: 'RJ23 AB 1234' },
    { name: 'Suresh Meena', mobile: '9876500002', vehicleNumber: 'RJ23 CD 5678' },
  ];
  for (const agent of agents) {
    // Platform-wide fleet (V1: scoped to one store) — DeliveryAgent has no
    // seller/store field at all now, see DeliveryAgent's own doc comment.
    await prisma.deliveryAgent.upsert({
      where: { mobile: agent.mobile },
      update: {},
      create: { ...agent, isActive: true, isAvailable: true },
    });
  }
  console.log(`  ✓ delivery agents: ${agents.length}`);
}
