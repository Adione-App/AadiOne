/**
 * Admin NEW ORDER popups — the pure rules (src/lib/orderAlertState.ts) and the
 * wiring, checked on the source. Run with `npm run test:unit`.
 * The server side: backend tests/integration/admin-order-alerts.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { announce, dismissedKey, popupsOf, prune, seenKey } from '../src/lib/orderAlertState.ts';
import { adminOrderTabOf } from '../src/lib/v2Orders.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('sound: only for a genuinely new order', () => {
  it('the first load of a browser announces nothing (orders already waiting are not "new")', () => {
    const { fresh, seen } = announce(['a', 'b'], null);
    assert.deepEqual(fresh, []);
    assert.deepEqual(seen, ['a', 'b']);
  });

  it('a new alert id is announced once; a re-fetch, reload or reconnect with the same ids is silent', () => {
    let state = announce(['a'], null).seen;
    const first = announce(['b', 'a'], state);
    assert.deepEqual(first.fresh, ['b']);
    state = first.seen;
    // Reload / reconnect / 30 s poll: same list → nothing.
    assert.deepEqual(announce(['b', 'a'], state).fresh, []);
    assert.deepEqual(announce(['b', 'a'], state).fresh, []);
  });

  it('several rapid orders in one fetch are each fresh (one sound per fetch is the caller’s choice)', () => {
    const { fresh } = announce(['c', 'b', 'a'], ['a']);
    assert.deepEqual(fresh, ['c', 'b']);
  });

  it('the seen list keeps only unread ids, so it never grows without bound', () => {
    const { seen } = announce(['b'], ['a', 'b', 'x']);
    assert.deepEqual(seen, ['b']);
    assert.deepEqual(prune(['a', 'b', 'b'], ['b']), ['b']);
  });

  it('an order read on another tab and later re-alerted is not possible: an alert id is per order per admin', () => {
    // Reading removes the id from the unread list; the seen list forgets it with it.
    const afterRead = announce([], ['a']).seen;
    assert.deepEqual(afterRead, []);
  });
});

describe('popups: closing hides, never reads', () => {
  const alerts = [{ alertId: 'a' }, { alertId: 'b' }, { alertId: 'c' }];

  it('dismissed popups are hidden and counted, the rest stay in order', () => {
    const { shown, hidden } = popupsOf(alerts, ['b']);
    assert.deepEqual(shown.map((a) => a.alertId), ['a', 'c']);
    assert.equal(hidden, 1);
  });

  it('reopening (clearing the dismissed list) shows every unread popup again', () => {
    const { shown, hidden } = popupsOf(alerts, []);
    assert.equal(shown.length, 3);
    assert.equal(hidden, 0);
  });

  it('state is per admin: different keys for different users', () => {
    assert.notEqual(seenKey('u1'), seenKey('u2'));
    assert.notEqual(dismissedKey('u1'), dismissedKey('u2'));
    assert.notEqual(seenKey('u1'), dismissedKey('u1'));
  });
});

describe('View order opens the order on its tab', () => {
  it('maps every status to the tab that lists it', () => {
    assert.equal(adminOrderTabOf('PAYMENT_CONFIRMED'), 'PROCESSING');
    assert.equal(adminOrderTabOf('PROCESSING'), 'PROCESSING');
    assert.equal(adminOrderTabOf('PARTIALLY_CANCELLED'), 'PROCESSING');
    assert.equal(adminOrderTabOf('READY_FOR_PICKUP'), 'READY_FOR_PICKUP');
    assert.equal(adminOrderTabOf('PICKED_UP'), 'OUT_FOR_DELIVERY');
    assert.equal(adminOrderTabOf('OUT_FOR_DELIVERY'), 'OUT_FOR_DELIVERY');
    assert.equal(adminOrderTabOf('DELIVERED'), 'COMPLETED');
    assert.equal(adminOrderTabOf('CANCELLED'), 'CANCELLED');
    assert.equal(adminOrderTabOf('REFUNDED'), 'CANCELLED');
  });
});

describe('wiring (source checks)', () => {
  const popups = read('src/components/OrderAlerts.tsx');
  const app = read('src/App.tsx');
  const orders = read('src/pages/Orders.tsx');
  const socket = read('src/lib/socket.ts');

  it('payment method labels: COD is never shown as online', () => {
    assert.match(popups, /paymentMethod === 'COD' \? 'COD \(Cash on Delivery\)' : 'Online Payment'/);
  });

  it('item subtotal and total payable are separate rows; discount shown as a minus', () => {
    assert.match(popups, /label="Item subtotal"/);
    assert.match(popups, /label="Total payable"/);
    assert.match(popups, /label="Discount" value=\{`− /);
  });

  it('× only dismisses (no read call); View order reads and navigates', () => {
    const close = popups.slice(popups.indexOf('const close = '), popups.indexOf('const reopen = '));
    assert.doesNotMatch(close, /markRead/);
    const view = popups.slice(popups.indexOf('const view = '), popups.indexOf('return (', popups.indexOf('const view = ')));
    assert.match(view, /markRead\.mutate\(alert\.orderId\)/);
    assert.match(view, /navigate\(/);
  });

  it('the sound plays only for fresh ids, via announce()', () => {
    assert.match(popups, /announce\(ids, seen\.current\)/);
    assert.match(popups, /if \(fresh\.length > 0\) playChime\(\)/);
  });

  it('a socket event and every (re)connect re-read the alerts', () => {
    assert.match(popups, /onNewOrder: \(\) => void queryClient\.invalidateQueries\(\{ queryKey: orderAlertsKey \}\)/);
    assert.match(popups, /onConnect: \(\) => void queryClient\.invalidateQueries\(\{ queryKey: orderAlertsKey \}\)/);
    assert.match(socket, /instance\.off\('connect', handleConnect\)/);
  });

  it('mounted for admins who can read orders, keyed per admin; red badge on Orders', () => {
    assert.match(app, /roleHasPermission\(user\.role, Permission\.ORDER_READ_ALL\)/);
    assert.match(app, /<OrderAlerts key=\{user\.id\} userId=\{user\.id\} \/>/);
    assert.match(app, /badge: 'newOrders'/);
    assert.match(app, /item\.badge === 'newOrders' && <NewOrdersBadge \/>/);
  });

  it('the Orders page no longer repeats a beep every 10 s; opening an order reads it', () => {
    assert.doesNotMatch(orders, /setInterval\(beep/);
    assert.doesNotMatch(orders, /useNewOrderChime/);
    assert.match(orders, /if \(!expanded\.has\(orderId\)\) markOrderRead\.mutate\(orderId\)/);
  });
});
