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

import { StockBatcher, confirmProduct, shiftFigures, shiftProduct } from '../src/seller/stockBatch.ts';
import { keepReencoded, renamed, targetSize } from '../src/lib/imagePrep.ts';
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
  it('scales to fit 1600 px, never up', () => {
    assert.deepEqual(targetSize(4000, 3000), { width: 1600, height: 1200 });
    assert.deepEqual(targetSize(3000, 4000), { width: 1200, height: 1600 });
    assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 });
    assert.deepEqual(targetSize(1600, 10), { width: 1600, height: 10 });
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

  it('a confirmed batch marks lists stale without re-reading them now', () => {
    const queries = read('src/seller/sellerQueries.ts');
    assert.match(queries, /refetchType: 'none'/);
  });

  it('product photos are resized and uploaded in parallel; attach stays one at a time in order', () => {
    const api = read('src/seller/sellerApi.ts');
    assert.match(api, /mapLimit\(files, PARALLEL_IMAGE_UPLOADS/);
    assert.match(api, /optimize: true/);
    for (const form of ['src/seller/pages/SellerProductDetail.tsx', 'src/seller/productForms.tsx', 'src/seller/foodItemForm.tsx']) {
      assert.match(read(form), /uploadSellerProductImages\(/, form);
    }
  });

  it('the upload is size-checked after the resize', () => {
    const upload = read('src/lib/upload.ts');
    const prepared = upload.indexOf('file = await prepareImageForUpload(file)');
    assert.ok(prepared > 0);
    assert.ok(upload.indexOf('file.size > MAX_IMAGE_BYTES', prepared) > prepared);
  });
});
