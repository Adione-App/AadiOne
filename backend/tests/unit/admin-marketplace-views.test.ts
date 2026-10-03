/**
 * Admin marketplace views — pure helpers (admin-marketplace-views.ts) and the
 * permission boundaries the new admin routes rely on. DB-free.
 */

import { describe, expect, it } from 'vitest';
import { Permission, UserRole, isAdminRole, roleHasPermission } from '../../src/shared';
import {
  REDACTED,
  maskMobile,
  paginate,
  redactAuditValue,
  refundSummary,
  stockState,
} from '../../src/modules/admin/admin-marketplace-views';

describe('stockState', () => {
  it('uses available = stock − reserved, like the seller panel', () => {
    expect(stockState({ stockQty: 20, reservedQty: 2, lowStockThreshold: 5 })).toEqual({ availableQty: 18, state: 'IN_STOCK' });
    expect(stockState({ stockQty: 6, reservedQty: 1, lowStockThreshold: 5 })).toEqual({ availableQty: 5, state: 'LOW' });
    expect(stockState({ stockQty: 2, reservedQty: 2, lowStockThreshold: 5 })).toEqual({ availableQty: 0, state: 'OUT' });
  });

  it('never reports negative availability', () => {
    expect(stockState({ stockQty: 1, reservedQty: 3, lowStockThreshold: 0 })).toEqual({ availableQty: 0, state: 'OUT' });
  });

  it('a zero threshold means nothing is ever "low", only in or out', () => {
    expect(stockState({ stockQty: 1, reservedQty: 0, lowStockThreshold: 0 }).state).toBe('IN_STOCK');
  });
});

describe('refundSummary', () => {
  it('no refunds', () => {
    expect(refundSummary(10_000, [])).toEqual({ state: 'NONE', refundedPaise: 0 });
  });
  it('sums only completed refunds; an in-flight one shows as pending', () => {
    expect(refundSummary(10_000, [{ status: 'COMPLETED', amountPaise: 4_000 }])).toEqual({ state: 'PARTIAL', refundedPaise: 4_000 });
    expect(refundSummary(10_000, [{ status: 'COMPLETED', amountPaise: 10_000 }])).toEqual({ state: 'REFUNDED', refundedPaise: 10_000 });
    expect(refundSummary(10_000, [{ status: 'PROCESSING', amountPaise: 10_000 }])).toEqual({ state: 'PENDING', refundedPaise: 0 });
    expect(refundSummary(10_000, [{ status: 'FAILED', amountPaise: 10_000 }])).toEqual({ state: 'FAILED', refundedPaise: 0 });
  });
});

describe('maskMobile', () => {
  it('keeps only the last four digits', () => {
    expect(maskMobile('9876543210')).toBe('••••••3210');
    expect(maskMobile('+91 98765 43210')).toBe('••••••••3210');
    expect(maskMobile(null)).toBeNull();
  });
});

describe('redactAuditValue', () => {
  it('redacts identity, bank and credential fields at any depth', () => {
    const out = redactAuditValue({
      panNumber: 'ABCDE1234F',
      profile: { aadhaarNumber: '123412341234', ownerFullName: 'Ravi' },
      bank: { accountNumber: '000123456789', ifscCode: 'SBIN0001234', bankName: 'SBI' },
      passwordHash: 'x',
      refreshToken: 'y',
      rawPayload: { card: '4111' },
      reason: 'Out of date label',
    }) as Record<string, any>;
    expect(out['panNumber']).toBe(REDACTED);
    expect(out['profile'].aadhaarNumber).toBe(REDACTED);
    expect(out['profile'].ownerFullName).toBe('Ravi');
    expect(out['bank'].accountNumber).toBe(REDACTED);
    expect(out['bank'].ifscCode).toBe(REDACTED);
    expect(out['bank'].bankName).toBe('SBI');
    expect(out['passwordHash']).toBe(REDACTED);
    expect(out['refreshToken']).toBe(REDACTED);
    expect(out['rawPayload']).toBe(REDACTED);
    expect(out['reason']).toBe('Out of date label');
  });

  it('leaves ordinary values alone and trims very long strings', () => {
    expect(redactAuditValue({ status: 'ARCHIVED', pricePaise: 1200 })).toEqual({ status: 'ARCHIVED', pricePaise: 1200 });
    expect((redactAuditValue('x'.repeat(800)) as string).length).toBe(501);
    expect(redactAuditValue(null)).toBeNull();
  });
});

describe('paginate', () => {
  it('slices one page and reports the total', () => {
    expect(paginate([1, 2, 3, 4, 5], 2, 2)).toEqual({ items: [3, 4], total: 5, page: 2, pageSize: 2 });
    expect(paginate([1, 2], 3, 2)).toEqual({ items: [], total: 2, page: 3, pageSize: 2 });
  });
});

describe('permission boundaries the new admin routes rely on', () => {
  it('STAFF keeps read access to catalogue and inventory monitoring', () => {
    expect(roleHasPermission(UserRole.STAFF, Permission.CATALOG_READ)).toBe(true);
    expect(roleHasPermission(UserRole.STAFF, Permission.INVENTORY_READ)).toBe(true);
  });

  it('STAFF does NOT get payments, refunds, audit logs, moderation, commission or seller management', () => {
    for (const permission of [
      Permission.ORDER_REFUND,
      Permission.CONFIG_WRITE,
      Permission.SELLER_MANAGE,
      Permission.COMMISSION_MANAGE,
      Permission.SELLER_ONBOARDING_REVIEW,
      Permission.SETTLEMENT_MANAGE,
    ]) {
      expect(roleHasPermission(UserRole.STAFF, permission)).toBe(false);
    }
  });

  it('ADMIN and SUPER_ADMIN hold every permission the new routes use', () => {
    for (const role of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      for (const permission of [
        Permission.CATALOG_READ,
        Permission.INVENTORY_READ,
        Permission.ORDER_REFUND,
        Permission.CONFIG_WRITE,
        Permission.SELLER_MANAGE,
        Permission.COMMISSION_MANAGE,
        Permission.SELLER_ONBOARDING_REVIEW,
      ]) {
        expect(roleHasPermission(role, permission)).toBe(true);
      }
    }
  });

  it('seller roles are not admin roles (every /admin route sits behind requireAdmin) and hold no admin-only permission', () => {
    for (const role of [UserRole.SELLER_OWNER, UserRole.SELLER_MANAGER, UserRole.PHARMACIST, UserRole.RESTAURANT_MANAGER, UserRole.CUSTOMER]) {
      expect(isAdminRole(role)).toBe(false);
      // CATALOG_READ is a customer permission (public browsing) — the requireAdmin gate is what keeps /admin closed.
      for (const permission of [Permission.CATALOG_WRITE, Permission.ORDER_REFUND, Permission.CONFIG_WRITE, Permission.SELLER_MANAGE, Permission.INVENTORY_READ, Permission.COMMISSION_MANAGE]) {
        expect(roleHasPermission(role, permission)).toBe(false);
      }
    }
  });
});
