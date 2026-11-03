/**
 * The customer's own held stock on product cards (src/lib/ownHolds.ts) —
 * run with `npm run test:unit`. The rules are pure; the wiring (every card,
 * the product page, the size sheet, account changes, cache isolation) is
 * checked on the source, since the screens need a device. The server side:
 * backend tests/integration/last-unit-inventory.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NO_OWN_HOLDS, ownAvailableQty, ownHoldsFromCart, withOwnHold } from "../src/lib/ownHolds.ts";

const line = (sellerListingId: string, availableQty: number, heldForYouQty?: number, inStock = availableQty > 0) => ({
  sellerListingId,
  availableQty,
  inStock,
  ...(heldForYouQty === undefined ? {} : { heldForYouQty }),
});
const variant = (sellerListingId: string, availableQty: number) => ({ id: `v-${sellerListingId}`, sellerListingId, availableQty, inStock: availableQty > 0 });

describe("own holds from the customer's cart", () => {
  it("stock 1, A holds it: A's card shows it available; the catalogue said sold out", () => {
    const holds = ownHoldsFromCart([line("L1", 1, 1)]);
    assert.equal(ownAvailableQty(holds, "L1"), 1);
    assert.deepEqual(withOwnHold(variant("L1", 0), holds), { id: "v-L1", sellerListingId: "L1", availableQty: 1, inStock: true });
  });

  it("stock 5, A holds 2: A may have 5 in all (the catalogue's 3 + their 2)", () => {
    const holds = ownHoldsFromCart([line("L1", 5, 2)]);
    assert.equal(withOwnHold(variant("L1", 3), holds).availableQty, 5);
  });

  it("B (holding nothing), a guest (no cart) and older servers (no field) see the catalogue unchanged", () => {
    for (const cart of [[line("L1", 0, 0, false)], [], null, undefined, [line("L1", 3)]]) {
      const holds = ownHoldsFromCart(cart);
      assert.equal(holds, NO_OWN_HOLDS);
      const catalogue = variant("L1", 0);
      assert.equal(withOwnHold(catalogue, holds), catalogue); // the same object: nothing re-renders
      assert.equal(ownAvailableQty(holds, "L1"), null);
    }
  });

  it("a held listing switched off by the seller is never shown available", () => {
    const holds = ownHoldsFromCart([line("L1", 1, 1, false)]);
    assert.deepEqual(withOwnHold(variant("L1", 0), holds), { id: "v-L1", sellerListingId: "L1", availableQty: 0, inStock: false });
  });

  it("only the listings that are held change; others in the cart or catalogue do not", () => {
    const holds = ownHoldsFromCart([line("L1", 1, 1), line("L2", 4, 0)]);
    assert.equal(ownAvailableQty(holds, "L2"), null);
    assert.equal(ownAvailableQty(holds, "L3"), null);
    assert.equal(ownAvailableQty(holds, null), null);
  });

  it("account A's holds come only from A's cart: B's cart never inherits them", () => {
    const aCart = [line("L1", 1, 1)];
    const bCart = [line("L1", 0, 0, false)];
    assert.equal(ownAvailableQty(ownHoldsFromCart(aCart), "L1"), 1);
    assert.equal(ownAvailableQty(ownHoldsFromCart(bCart), "L1"), null);
  });
});

describe("wiring", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  const sources = (dir: string): string[] =>
    readdirSync(path.join(ROOT, dir)).flatMap((name) => {
      const rel = path.join(dir, name);
      if (statSync(path.join(ROOT, rel)).isDirectory()) return sources(rel);
      return /\.tsx?$/.test(name) ? [rel] : [];
    });

  it("every ProductCard on every screen is given the customer's own availability", () => {
    let cards = 0;
    for (const rel of sources("src")) {
      const text = read(rel);
      const uses = text.match(/<ProductCard\b(?!Skeleton)/g)?.length ?? 0;
      if (uses === 0) continue;
      cards += uses;
      assert.equal(text.match(/ownAvailableQty=\{cart\.ownAvailableQtyFor\(item\)\}/g)?.length ?? 0, uses, rel);
    }
    assert.ok(cards >= 8, `expected the 8 known card screens, found ${cards}`);
  });

  it("the card applies it to its variant (badge, + limit and cart snapshot alike)", () => {
    const card = read("src/components/ProductCard.tsx");
    assert.match(card, /ownAvailableQty = null,/);
    assert.match(card, /catalogueVariant && ownAvailableQty !== null\n\s*\? \{ \.\.\.catalogueVariant, availableQty: ownAvailableQty, inStock: ownAvailableQty > 0 \}/);
  });

  it("the product page and the size sheet show every size the same way", () => {
    assert.match(read("src/screens/catalog/ProductDetailScreen.tsx"), /\(product\.data\?\.variants \?\? \[\]\)\.map\(\(item\) => cart\.withOwnHold\(item\)\)/);
    assert.match(read("src/components/VariantSheet.tsx"), /\(data\?\.variants \?\? \[\]\)\.map\(\(item\) => cart\.withOwnHold\(item\)\)/);
  });

  it("holds come from the server-confirmed cart — never the disk-restored or optimistic one", () => {
    const actions = read("src/lib/useCartActions.ts");
    assert.match(actions, /const ownHolds = useMemo\(\(\) => ownHoldsFromCart\(cart\?\.items\), \[cart\]\);/);
    assert.doesNotMatch(actions, /ownHoldsFromCart\(optimisticCart/);
  });

  it("cache isolation: the cart is a private query; the shared catalogue never carries holds", () => {
    assert.match(read("src/lib/guestAccess.ts"), /PRIVATE_QUERY_ROOTS: readonly string\[\] = \[\n\s*"cart",/);
    const queries = read("src/lib/queries.ts");
    assert.doesNotMatch(queries, /ownHolds|heldForYou/);
    // Catalogue keys stay shared (no account in them) — the overlay is applied at render time only.
    assert.match(queries, /categoryListing: \(categoryId: string, pageSize: number\) =>\n\s*\["category-listing", CATALOG_CACHE_VERSION, categoryId, pageSize\] as const/);
  });

  it("signing out, or one account replacing another, drops the previous account's cart (and holds)", () => {
    const app = read("App.tsx");
    assert.match(app, /state\.status === "authenticated" &&\n\s*previous\.status === "authenticated" &&\n\s*state\.user\?\.id !== previous\.user\?\.id;/);
    assert.match(app, /if \(\(state\.status === "anonymous" && previous\.status !== "anonymous"\) \|\| accountReplaced\) \{\n\s*forgetPrivateQueries\(queryClient\);/);
  });

  it("a payment's end refreshes the catalogue lists showing that stock", () => {
    const pending = read("src/lib/pendingPayment.ts");
    for (const key of ['["home"]', "homeShelvesQueryKey", '["category-listing"]', '["rail"]', '["search"]', '["store-products"]', '["product"]']) {
      assert.ok(pending.includes(`  ${key},`), key);
    }
    assert.match(pending, /for \(const key of CATALOGUE_STOCK_QUERIES\) \{\n\s*void queryClient\.invalidateQueries/);
  });
});
