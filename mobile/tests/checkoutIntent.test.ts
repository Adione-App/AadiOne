/**
 * One idempotency key per checkout intent (src/lib/checkoutIntent.ts) — run
 * with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INTENT_MAX_AGE_MS,
  checkoutSignature,
  createCheckoutIntents,
  intentFor,
  restoredIntent,
} from "../src/lib/checkoutIntent.ts";

const body = (overrides: Record<string, unknown> = {}) => ({
  addressId: "addr-1",
  paymentMethod: "ONLINE",
  openPayment: true,
  expectedTotalPaise: 33900,
  expectedItems: [{ sellerListingId: "l-1", qty: 2, unitPricePaise: 15000 }],
  ...overrides,
});

function memoryStore() {
  let value: string | null = null;
  return { get: async () => value, set: async (v: string | null) => void (value = v), peek: () => value };
}

let counter = 0;
const newKey = () => `key-${(counter += 1).toString().padStart(4, "0")}-xxxx`;

describe("checkout intent keys", () => {
  it("same checkout retry (timeout, double tap): the SAME key — the server replays the same order", async () => {
    const intents = createCheckoutIntents(memoryStore(), newKey);
    const a = await intents.keyFor(body());
    const b = await intents.keyFor(body());
    assert.equal(a, b);
  });

  it("a new checkout after the previous one created an order: a NEW key, even for the very same items", async () => {
    const intents = createCheckoutIntents(memoryStore(), newKey);
    const first = await intents.keyFor(body());
    await intents.completed();
    const second = await intents.keyFor(body());
    assert.notEqual(first, second);
  });

  it("a different payload (other items, total, method or destination) never reuses a key", async () => {
    const intents = createCheckoutIntents(memoryStore(), newKey);
    const base = await intents.keyFor(body());
    for (const changed of [
      body({ expectedTotalPaise: 40000 }),
      body({ paymentMethod: "COD", openPayment: undefined }),
      body({ addressId: "addr-2" }),
      body({ expectedItems: [{ sellerListingId: "l-1", qty: 3, unitPricePaise: 15000 }] }),
    ]) {
      assert.notEqual(await intents.keyFor(changed), base);
    }
  });

  it("app restart and retry: the unfinished intent is restored from disk — same key; a finished one is not", async () => {
    const store = memoryStore();
    const before = createCheckoutIntents(store, newKey);
    const key = await before.keyFor(body());
    // The app is killed before the answer arrives; a new process starts.
    const after = createCheckoutIntents(store, newKey);
    assert.equal(await after.keyFor(body()), key);
    // After success nothing is left to resume.
    await after.completed();
    assert.equal(store.peek(), null);
    const third = createCheckoutIntents(store, newKey);
    assert.notEqual(await third.keyFor(body()), key);
  });

  it("concurrent taps for the same request get the same key (the server lets only one through)", async () => {
    const intents = createCheckoutIntents(memoryStore(), newKey);
    const [a, b] = await Promise.all([intents.keyFor(body()), intents.keyFor(body())]);
    assert.equal(a, b);
  });

  it("a refused attempt that must start over (abandon) gets a new key next time", async () => {
    const intents = createCheckoutIntents(memoryStore(), newKey);
    const a = await intents.keyFor(body());
    await intents.abandon();
    assert.notEqual(await intents.keyFor(body()), a);
  });

  it("the signature ignores key order and undefined fields; an old or malformed stored intent is not resumed", () => {
    assert.equal(checkoutSignature({ b: 1, a: { d: 2, c: undefined } }), checkoutSignature({ a: { d: 2 }, b: 1 }));
    const now = 1_000_000_000;
    const intent = intentFor(null, body(), newKey, now);
    assert.equal(intentFor(intent, body(), newKey, now + 1000), intent);
    assert.notEqual(intentFor(intent, body(), newKey, now + INTENT_MAX_AGE_MS).key, intent.key);
    assert.deepEqual(restoredIntent(JSON.stringify(intent), now + 5), intent);
    assert.equal(restoredIntent(JSON.stringify(intent), now + INTENT_MAX_AGE_MS), null);
    assert.equal(restoredIntent("{not json", now), null);
    assert.equal(restoredIntent(JSON.stringify({ key: "short", signature: "x", createdAt: now }), now), null);
  });
});
