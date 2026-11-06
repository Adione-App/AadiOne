/**
 * Seller stock −/+ batching (src/seller/stockBatch.ts), cache patching, and
 * the image upload helpers (src/lib/imagePrep.ts, src/lib/mapLimit.ts).
 * Run with `npm run test:unit`. The server side:
 * backend tests/integration/seller-stock-fast.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StockBatcher, confirmProduct, figuresIn, holdFigures, shiftFigures, shiftProduct } from '../src/seller/stockBatch.ts';
import { MAX_EDGE, keepReencoded, renamed, targetSize } from '../src/lib/imagePrep.ts';
import { isRetryableError, isRetryableStatus, withRetry } from '../src/lib/retry.ts';
import { mapLimit } from '../src/lib/mapLimit.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** A hand-driven clock and a fake server for the batcher. */
function harness(opts: { fail?: (delta: number) => boolean } = {}) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const sent: number[] = [];
  const confirmed: { result: number; unsent: number }[] = [];
  const failed: number[] = [];
  let resolveSend: ((value: number) => void) | null = null;
  let rejectSend: ((error: Error) => void) | null = null;
  const batcher = new StockBatcher<number>({
    delayMs: 400,
    send: (_id, delta) => {
      sent.push(delta);
      return new Promise<number>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
    },
    onConfirmed: (_id, result, unsent) => confirmed.push({ result, unsent }),
    onFailed: (_id, _error, undo) => failed.push(undo),
    setTimer: (run) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  const tick = () => {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, run] of pending) run();
  };
  const settle = async (value: number) => {
    const send = resolveSend!;
    resolveSend = null;
    if (opts.fail?.(sent.at(-1)!)) rejectSend!(new Error('refused'));
    else send(value);
    await new Promise((r) => setImmediate(r));
  };
  const refuse = async () => {
    rejectSend!(new Error('refused'));
    resolveSend = null;
    await new Promise((r) => setImmediate(r));
  };
  return { batcher, sent, confirmed, failed, tick, settle, refuse, timers };
}

describe('stock taps are batched', () => {
  it('five fast +1 taps are ONE request of +5', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) h.batcher.add('L', 1);
    assert.deepEqual(h.sent, []);
    assert.equal(h.batcher.isBusy('L'), true);
    h.tick();
    assert.deepEqual(h.sent, [5]);
    await h.settle(15);
    assert.deepEqual(h.confirmed, [{ result: 15, unsent: 0 }]);
    assert.equal(h.batcher.isBusy('L'), false);
  });

  it('taps that cancel out send nothing', () => {
    const h = harness();
    h.batcher.add('L', 1);
    h.batcher.add('L', -1);
    h.tick();
    assert.deepEqual(h.sent, []);
    assert.equal(h.batcher.isBusy('L'), false);
  });

  it('one request per listing at a time: taps during a request are the next batch', async () => {
    const h = harness();
    h.batcher.add('L', 2);
    h.tick();
    assert.deepEqual(h.sent, [2]);
    h.batcher.add('L', 1);
    h.batcher.add('L', 1);
    h.tick(); // no timer armed while in flight
    assert.deepEqual(h.sent, [2]);
    assert.equal(h.batcher.unconfirmed('L'), 4);
    await h.settle(12);
    // Confirmed with the 2 unsent taps still to come (the screen keeps them on top).
    assert.deepEqual(h.confirmed, [{ result: 12, unsent: 2 }]);
    h.tick();
    assert.deepEqual(h.sent, [2, 2]);
  });

  it('a refused batch takes back everything not confirmed (the batch and taps since)', async () => {
    const h = harness();
    h.batcher.add('L', -3);
    h.tick();
    h.batcher.add('L', -1);
    await h.refuse();
    assert.deepEqual(h.failed, [-4]);
    assert.equal(h.batcher.isBusy('L'), false);
    // Nothing more is sent for the taken-back taps.
    h.tick();
    assert.deepEqual(h.sent, [-3]);
  });

  it('separate listings batch separately', () => {
    const h = harness();
    h.batcher.add('A', 1);
    h.batcher.add('B', -1);
    h.batcher.add('A', 1);
    h.tick();
    assert.deepEqual(h.sent.sort(), [-1, 2].sort());
  });

  it('flushAll sends waiting taps at once (leaving the page never drops them)', () => {
    const h = harness();
    h.batcher.add('L', 3);
    h.batcher.flushAll();
    assert.deepEqual(h.sent, [3]);
    assert.equal(h.timers.size, 0);
  });

  it('non-integer or zero deltas are ignored', () => {
    const h = harness();
    h.batcher.add('L', 0);
    h.batcher.add('L', 1.5);
    assert.equal(h.batcher.isBusy('L'), false);
  });
});

/**
 * A fake server (one listing, a stock floor and a reserved floor, answers
 * one request at a time when told) behind a real batcher, and "the screen" =
 * the last confirmed figures + what is not confirmed yet — exactly what
 * useStockBatcher shows.
 */
function simulated(start: { stock: number; reserved?: number }) {
  let stock = start.stock;
  const reserved = start.reserved ?? 0;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const requests: { delta: number; note?: string }[] = [];
  const answers: (() => void)[] = [];
  let screen = stock;
  const errors: string[] = [];
  const batcher = new StockBatcher<number>({
    send: (_id, delta, note) => {
      requests.push(note === undefined ? { delta } : { delta, note });
      return new Promise<number>((resolve, reject) => {
        answers.push(() => {
          const next = stock + delta;
          if (next < 0 || next < reserved) reject(new Error(next < 0 ? 'below zero' : 'below reserved'));
          else resolve((stock = next));
        });
      });
    },
    onConfirmed: (_id, result, unsent) => {
      screen = result + unsent;
    },
    onFailed: (_id, error, undo) => {
      screen -= undo;
      errors.push((error as Error).message);
    },
    setTimer: (run) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  const flush = async () => new Promise((r) => setImmediate(r));
  const sim = {
    batcher,
    requests,
    errors,
    tap: (delta: number, note?: string) => {
      screen += delta;
      batcher.add('L', delta, note);
    },
    tick: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    },
    /** The server answers the request on its way. */
    answer: async () => {
      answers.shift()?.();
      await flush();
    },
    get server() {
      return stock;
    },
    get screen() {
      return screen;
    },
    /** Let everything finish: pauses pass, every request is answered. */
    drain: async () => {
      for (let i = 0; i < 100 && (batcher.isBusy('L') || answers.length > 0); i += 1) {
        sim.tick();
        await sim.answer();
      }
    },
  };
  return sim;
}

describe('rapid and mixed stock changes (fake server behind the real batcher)', () => {
  it('one +1 and one −1, each after the pause: two requests, figures confirmed', async () => {
    const s = simulated({ stock: 10 });
    s.tap(1);
    s.tick();
    await s.answer();
    s.tap(-1);
    s.tick();
    await s.answer();
    assert.deepEqual(s.requests, [{ delta: 1 }, { delta: -1 }]);
    assert.equal(s.server, 10);
    assert.equal(s.screen, 10);
  });

  it('10 rapid +1: one request of +10; 10 rapid −1: one request of −10', async () => {
    const s = simulated({ stock: 5 });
    for (let i = 0; i < 10; i += 1) s.tap(1);
    assert.equal(s.screen, 15); // on screen at once
    await s.drain();
    for (let i = 0; i < 10; i += 1) s.tap(-1);
    await s.drain();
    assert.deepEqual(s.requests, [{ delta: 10 }, { delta: -10 }]);
    assert.equal(s.server, 5);
    assert.equal(s.screen, 5);
  });

  it('+, +, −, + with the first already on its way: nothing is lost, answers never undo newer taps', async () => {
    const s = simulated({ stock: 3 });
    s.tap(1);
    s.tick(); // +1 leaves
    s.tap(1);
    s.tap(-1);
    s.tap(1);
    assert.equal(s.screen, 5);
    await s.answer(); // the +1 is confirmed: server 4, the screen keeps the 1 not sent yet
    assert.equal(s.server, 4);
    assert.equal(s.screen, 5);
    await s.drain();
    assert.deepEqual(s.requests, [{ delta: 1 }, { delta: 1 }]);
    assert.equal(s.server, 5);
    assert.equal(s.screen, 5);
  });

  it('long random sequences of taps, typed amounts, pauses and answers: server = screen = start + every change', async () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 50; round += 1) {
      const s = simulated({ stock: 500 });
      let expected = 500;
      for (let step = 0; step < 60; step += 1) {
        const r = random();
        if (r < 0.55) {
          const delta = random() < 0.6 ? 1 : -1;
          s.tap(delta);
          expected += delta;
        } else if (r < 0.62) {
          const delta = Math.ceil(random() * 20) * (random() < 0.5 ? -1 : 1);
          s.tap(delta, 'typed amount');
          expected += delta;
        } else if (r < 0.8) s.tick();
        else await s.answer();
        assert.equal(s.screen, expected, `round ${round} step ${step}: the screen shows every change`);
      }
      await s.drain();
      assert.equal(s.server, expected, `round ${round}: server`);
      assert.equal(s.screen, expected, `round ${round}: screen`);
      assert.deepEqual(s.errors, []);
    }
  });

  it('a typed amount with a note is its own change, sent at once, after taps made before it', async () => {
    const s = simulated({ stock: 2 });
    s.tap(1);
    s.tap(1);
    s.tap(25, 'new delivery');
    // The taps go first (no waiting for the pause), the noted amount right after.
    assert.deepEqual(s.requests, [{ delta: 2 }]);
    await s.answer();
    assert.deepEqual(s.requests, [{ delta: 2 }, { delta: 25, note: 'new delivery' }]);
    s.tap(1);
    await s.drain();
    assert.deepEqual(s.requests, [{ delta: 2 }, { delta: 25, note: 'new delivery' }, { delta: 1 }]);
    assert.equal(s.server, 30);
  });

  it('a failed change takes back everything not confirmed; confirmed taps stay; later taps work again', async () => {
    const s = simulated({ stock: 4 });
    s.tap(1);
    s.tick();
    await s.answer(); // +1 confirmed: 5
    s.tap(-6); // would go below zero
    s.tick();
    s.tap(-1); // made while the refused one is on its way
    await s.answer();
    assert.deepEqual(s.errors, ['below zero']);
    assert.equal(s.server, 5);
    assert.equal(s.screen, 5);
    s.tap(-1);
    await s.drain();
    assert.equal(s.server, 4);
    assert.equal(s.screen, 4);
  });

  it('reserved stock: a change below what is reserved is refused and taken back', async () => {
    const s = simulated({ stock: 6, reserved: 4 });
    for (let i = 0; i < 3; i += 1) s.tap(-1);
    await s.drain();
    assert.deepEqual(s.errors, ['below reserved']);
    assert.equal(s.server, 6);
    assert.equal(s.screen, 6);
    s.tap(-2);
    await s.drain();
    assert.equal(s.server, 4);
  });

  it('busyListings lists only listings with unconfirmed changes', async () => {
    const s = simulated({ stock: 1 });
    assert.deepEqual(s.batcher.busyListings(), []);
    s.tap(1);
    assert.deepEqual(s.batcher.busyListings(), ['L']);
    await s.drain();
    assert.deepEqual(s.batcher.busyListings(), []);
  });
});

describe('stale fetched figures never undo unconfirmed taps', () => {
  const listingRow = (id: string, stockQty: number, reservedQty = 0) => ({
    id,
    productName: 'Rice',
    stockQty,
    reservedQty,
    availableQty: stockQty - reservedQty,
    isAvailable: true,
    visibility: { sellable: true, reason: 'SELLABLE', availableQty: stockQty - reservedQty, lowStock: false },
  });

  it('a fetched list keeps the held figures for that listing only', () => {
    const fetched = [listingRow('L1', 10), listingRow('L2', 7)];
    const held = holdFigures(fetched, 'L1', { stockQty: 15, reservedQty: 0, availableQty: 15 }) as ReturnType<typeof listingRow>[];
    assert.equal(held[0]!.stockQty, 15);
    assert.equal(held[0]!.availableQty, 15);
    assert.equal(held[0]!.visibility.availableQty, 15);
    assert.equal(held[0]!.productName, 'Rice'); // everything else is the fetched data
    assert.equal(held[1], fetched[1]);
  });

  it('a fetched product page keeps the held figures for a size listing', () => {
    const product = { id: 'P', listing: listingRow('L1', 5), variants: [{ id: 'V1', listing: listingRow('L1', 5) }, { id: 'V2', listing: listingRow('L2', 3) }] };
    const held = holdFigures(product, 'L2', { stockQty: 9, reservedQty: 1, availableQty: 8 }) as typeof product;
    assert.equal(held.variants[1]!.listing.stockQty, 9);
    assert.equal(held.variants[1]!.listing.availableQty, 8);
    assert.equal(held.listing.stockQty, 5);
    assert.deepEqual(figuresIn(held, 'L2'), { stockQty: 9, reservedQty: 1, availableQty: 8 });
    assert.deepEqual(figuresIn([held], 'L1'), { stockQty: 5, reservedQty: 0, availableQty: 5 });
  });

  it('stock history rows and other shapes are left alone', () => {
    const movements = [{ id: 'm1', delta: 1, reason: 'MANUAL_ADJUST', balanceAfter: 3 }];
    assert.deepEqual(holdFigures(movements, 'm1', { stockQty: 1, reservedQty: 0, availableQty: 1 }), movements);
    assert.equal(figuresIn(movements, 'm1'), null);
    assert.equal(holdFigures(null, 'L1', { stockQty: 1, reservedQty: 0, availableQty: 1 }), null);
  });
});

describe('cache patching', () => {
  const figures = { id: 'L1', stockQty: 10, reservedQty: 2, availableQty: 8, visibility: { sellable: true, reason: 'SELLABLE', availableQty: 8, lowStock: false } };

  it('a tap moves stock and available, never reserved', () => {
    const next = shiftFigures(figures, -3);
    assert.equal(next.stockQty, 7);
    assert.equal(next.availableQty, 5);
    assert.equal(next.reservedQty, 2);
    assert.equal(next.visibility.availableQty, 5);
    assert.equal(shiftFigures(figures, 0), figures);
  });

  const listing = (id: string, stockQty: number) => ({ id, stockQty, reservedQty: 0, availableQty: stockQty, isAvailable: true, pricePaise: 100, mrpPaise: 100, updatedAt: 't', lowStockThreshold: 5, maxQtyPerOrder: 10 });
  const product = {
    id: 'P',
    listing: listing('L1', 5),
    visibility: { sellable: true, reason: 'SELLABLE', availableQty: 5, lowStock: false },
    variants: [
      { id: 'V1', listing: listing('L1', 5) },
      { id: 'V2', listing: listing('L2', 3) },
    ],
  } as never;

  it('a size listing is patched inside variants[] (and the default one in both places)', () => {
    const sized = shiftProduct(product, 'L2', 2) as unknown as typeof product & { variants: { listing: { stockQty: number } }[]; listing: { stockQty: number } };
    assert.equal(sized.variants[1]!.listing.stockQty, 5);
    assert.equal(sized.listing.stockQty, 5);
    const main = shiftProduct(product, 'L1', 1) as unknown as typeof sized;
    assert.equal(main.listing.stockQty, 6);
    assert.equal(main.variants[0]!.listing.stockQty, 6);
    assert.equal(shiftProduct(product, 'OTHER', 1), product);
  });

  it('the server answer replaces the figures and the visibility', () => {
    const server = { ...listing('L1', 0), visibility: { sellable: false, reason: 'OUT_OF_STOCK', availableQty: 0, lowStock: false } } as never;
    const next = confirmProduct(product, server) as unknown as { listing: { stockQty: number }; visibility: { reason: string } };
    assert.equal(next.listing.stockQty, 0);
    assert.equal(next.visibility.reason, 'OUT_OF_STOCK');
  });
});

describe('image preparation', () => {
  it('scales to fit 1200 px — the size the server stores — never up', () => {
    assert.equal(MAX_EDGE, 1200);
    assert.deepEqual(targetSize(4000, 3000), { width: 1200, height: 900 });
    assert.deepEqual(targetSize(3000, 4000), { width: 900, height: 1200 });
    assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 });
    assert.deepEqual(targetSize(1200, 10), { width: 1200, height: 10 });
    // The server's product profile is the same size (no second resize there).
    assert.match(read('../backend/src/infra/storage/image-optimizer.ts'), /product: \{ maxWidth: 1200, maxHeight: 1200/);
  });

  it('keeps the original unless the re-encode is smaller (a resize always counts)', () => {
    assert.equal(keepReencoded({ size: 100 }, { size: 120 }, false), false);
    assert.equal(keepReencoded({ size: 100 }, { size: 80 }, false), true);
    assert.equal(keepReencoded({ size: 100 }, { size: 120 }, true), true);
  });

  it('renames the extension to the new type', () => {
    assert.equal(renamed('IMG_0001.HEIC.jpg', 'image/webp'), 'IMG_0001.HEIC.webp');
    assert.equal(renamed('photo', 'image/jpeg'), 'photo.jpg');
  });
});

describe('retrying a dropped request', () => {
  const noSleep = { sleep: async () => undefined };

  it('a network failure (no answer) or 408 / 429 / 5xx is retried; a refusal is not', () => {
    assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
    for (const status of [0, 408, 429, 500, 502, 503]) assert.equal(isRetryableError({ status }), true, String(status));
    for (const status of [400, 401, 403, 404, 409, 413, 415, 422]) assert.equal(isRetryableError({ status }), false, String(status));
    assert.equal(isRetryableError(new Error('This product is under review.')), false);
    assert.equal(isRetryableStatus(200), false);
  });

  it('tries again after each pause, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('offline');
        return 'stored';
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    assert.equal(value, 'stored');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [700, 2000]);
  });

  it('gives up after the last pause with the last failure; a refusal fails at once', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw Object.assign(new Error('storage down'), { status: 503 });
      }, noSleep),
      /storage down/,
    );
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw Object.assign(new Error('gallery full'), { status: 400 });
      }, noSleep),
      /gallery full/,
    );
    assert.equal(calls, 1);
  });
});

describe('parallel uploads', () => {
  it('runs at most `limit` at once and keeps the input order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10], 3, async (ms, index) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running -= 1;
      return index;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
    assert.equal(peak, 3);
  });
});

describe('wiring (source checks)', () => {
  it('Products and Inventory use the batcher; +/− are not disabled while saving', () => {
    for (const page of ['src/seller/pages/SellerProducts.tsx', 'src/seller/pages/SellerInventory.tsx']) {
      const source = read(page);
      assert.match(source, /useStockBatcher\(\)/, page);
      assert.doesNotMatch(source, /stock-adjust`/, page);
    }
  });

  it('every stock control shares one queue and is never disabled while saving', () => {
    const queries = read('src/seller/sellerQueries.ts');
    assert.match(queries, /const sharedStock = new WeakMap<QueryClient, SharedStock>\(\)/);
    assert.match(queries, /cancelQueries\(\{ queryKey: sellerKeys\.listings \}\)/);
    assert.match(queries, /holdFigures\(data, listingId, figures\)/);
    const sections = read('src/seller/productSections.tsx');
    const panel = sections.slice(sections.indexOf('function StockPanel('), sections.indexOf('Recent stock changes'));
    assert.match(panel, /useStockBatcher\(/);
    assert.doesNotMatch(panel, /stock-adjust`/);
    assert.doesNotMatch(panel, /disabled=\{busy/);
    assert.doesNotMatch(panel, /onChanged\(\)/); // no full list re-read per change
    for (const page of ['src/seller/pages/SellerProducts.tsx', 'src/seller/pages/SellerInventory.tsx']) {
      assert.match(read(page), /busy=\{false\}/, page);
    }
    assert.match(read('src/seller/productUi.tsx'), /saving \? 'saving…'/);
  });

  it('a confirmed batch marks lists stale without re-reading them now', () => {
    const queries = read('src/seller/sellerQueries.ts');
    assert.match(queries, /refetchType: 'none'/);
  });

  it('product photos are resized and uploaded in parallel, then attached together in one request, in order', () => {
    const api = read('src/seller/sellerApi.ts');
    assert.match(api, /mapLimit\(files, PARALLEL_IMAGE_UPLOADS/);
    assert.match(api, /optimize: true/);
    assert.match(api, /images\/batch`/);
    assert.match(api, /withRetry\(\(\) =>/);
    for (const form of ['src/seller/pages/SellerProductDetail.tsx', 'src/seller/productForms.tsx', 'src/seller/foodItemForm.tsx']) {
      const source = read(form);
      assert.match(source, /addSellerProductImages\(/, form);
      // No photo-by-photo attach loop any more.
      assert.doesNotMatch(source, /for \(const result of results\)/, form);
    }
  });

  it('the storage PUT is tried again after a dropped connection or a storage 5xx', () => {
    const upload = read('src/lib/upload.ts');
    assert.match(upload, /await withRetry\(async \(\) =>/);
    assert.match(upload, /request\.onerror = \(\) => reject\(new TypeError\(/);
  });

  it('the upload is size-checked after the resize', () => {
    const upload = read('src/lib/upload.ts');
    const prepared = upload.indexOf('file = await prepareImageForUpload(file)');
    assert.ok(prepared > 0);
    assert.ok(upload.indexOf('file.size > MAX_IMAGE_BYTES', prepared) > prepared);
  });
});
