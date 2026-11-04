/**
 * The admin Orders / Dashboard / Payments rules for Cashfree — run with
 * `npm run test:unit` (Node's own test runner, type stripping). The tab rules
 * are pure (src/lib/v2Orders.ts); the pages' wiring is checked on the source.
 * The server side: backend tests/integration/admin-orders-cashfree.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { V2_ADMIN_ORDER_TABS, orderBadgeTabs, resolveAdminOrderTab, visibleAdminOrderTabs } from '../src/lib/v2Orders.ts';
import { Permission, roleHasPermission } from '../src/shared/permissions.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('order tabs per payment mode', () => {
  it('Cashfree: no Payment Pending tab and no red badge', () => {
    assert.deepEqual(
      visibleAdminOrderTabs(false).map((tab) => tab.key),
      ['PROCESSING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'],
    );
    assert.deepEqual(orderBadgeTabs(false), [
      { key: 'PROCESSING', urgent: false },
      { key: 'READY_FOR_PICKUP', urgent: false },
    ]);
  });

  it('direct UPI (manual confirmation): the tab and its urgent badge stay', () => {
    assert.deepEqual(
      visibleAdminOrderTabs(true).map((tab) => tab.key),
      V2_ADMIN_ORDER_TABS.map((tab) => tab.key),
    );
    assert.deepEqual(orderBadgeTabs(true)[0], { key: 'PAYMENT_PENDING', urgent: true });
  });

  it('a link opens the tab it names when shown, otherwise Processing', () => {
    assert.equal(resolveAdminOrderTab('READY_FOR_PICKUP', false), 'READY_FOR_PICKUP');
    assert.equal(resolveAdminOrderTab('OUT_FOR_DELIVERY', false), 'OUT_FOR_DELIVERY');
    assert.equal(resolveAdminOrderTab('PAYMENT_PENDING', false), 'PROCESSING');
    assert.equal(resolveAdminOrderTab('PAYMENT_PENDING', true), 'PAYMENT_PENDING');
    assert.equal(resolveAdminOrderTab('NOT_A_TAB', false), 'PROCESSING');
    assert.equal(resolveAdminOrderTab(null, false), 'PROCESSING');
  });
});

describe('pages', () => {
  const orders = read('src/pages/Orders.tsx');
  const dashboard = read('src/pages/Dashboard.tsx');
  const paymentsPage = read('src/pages/Payments.tsx');
  const alert = read('src/components/PaidNotPlacedAlert.tsx');

  it('Orders builds its tabs and badges from the payment mode, and honours ?tab= / ?search=', () => {
    assert.match(orders, /const tabs = visibleAdminOrderTabs\(manualPayments\);/);
    assert.match(orders, /const badgeTabs = orderBadgeTabs\(manualPayments\);/);
    assert.match(orders, /\{tabs\.map\(\(item\) => \{/);
    assert.match(orders, /params\.get\("tab"\)/);
    assert.match(orders, /params\.get\("search"\)/);
    assert.doesNotMatch(orders, /V2_ADMIN_ORDER_TABS\.map|BADGE_TABS/);
    // The manual UPI controls are still gated on the mode, unchanged.
    assert.match(orders, /const isPendingUpiPayment =\n\s*manualPayments &&/);
  });

  it('Dashboard: "Orders in Progress" links each actionable tab; the dated list is placed orders only', () => {
    assert.match(dashboard, /label="Orders in Progress"/);
    assert.doesNotMatch(dashboard, /label="Pending Orders"/);
    for (const tab of ['PROCESSING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY']) {
      assert.match(dashboard, new RegExp(`to="/orders\\?tab=${tab}"`));
    }
    assert.match(dashboard, /placedOnly=true/);
  });

  it('Payments filters on the outcome it shows, flags paid-not-placed rows, and keeps old ?status= links working', () => {
    assert.match(paymentsPage, /\{ value: 'PENDING', label: 'Pending' \}/);
    assert.match(paymentsPage, /toQuery\(\{ q, outcome, status, page, pageSize: PAGE_SIZE \}\)/);
    assert.match(paymentsPage, /Paid — order not placed yet/);
  });

  it('the paid-not-placed warning is on Orders, Dashboard and Payments, and is read-only', () => {
    for (const page of [orders, dashboard, paymentsPage]) assert.match(page, /<PaidNotPlacedAlert/);
    assert.match(alert, /api\.get<AdminPaidNotPlacedDto>\('\/admin\/payment-anomalies'\)/);
    assert.doesNotMatch(alert, /api\.(post|patch|put|delete)/);
  });

  it('the warning links to Payments only for roles that can open it (Admin / Super Admin), never for Staff', () => {
    assert.match(alert, /const canOpenPayments = role !== undefined && roleHasPermission\(role, Permission\.ORDER_REFUND\);/);
    assert.match(alert, /\{paymentsLink && canOpenPayments && \(/);
    // The same table the sidebar and the API use — unchanged.
    assert.equal(roleHasPermission('STAFF', Permission.ORDER_REFUND), false);
    assert.equal(roleHasPermission('ADMIN', Permission.ORDER_REFUND), true);
    assert.equal(roleHasPermission('SUPER_ADMIN', Permission.ORDER_REFUND), true);
    assert.equal(roleHasPermission('STAFF', Permission.ORDER_READ_ALL), true);
  });
});
