/**
 * Panel lists: no sideways scrolling, and Back returns to the same place
 * (lib/scrollMemoryCore.ts, lib/scrollMemory.ts, components/BackLink.tsx and
 * the product / inventory / seller lists) — run with `npm run test:unit`.
 *
 * Before: product tables had fixed minimum widths (up to 1212 px drawn in a
 * 718–1134 px page) inside `overflow-x-auto`, so columns and actions sat off
 * screen; and Back re-opened every list at the top, because nothing restored
 * the scroll position and a detail page's "← Products" opened the list afresh.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIRST_ENTRY_KEY,
  arrivalScroll,
  canReach,
  historyBackTarget,
  isFreshLoad,
  storedMap,
  trimEntries,
} from "../src/lib/scrollMemoryCore.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("where the page is when an entry is shown", () => {
  it("Back / Forward restores the remembered position", () => {
    assert.deepEqual(arrivalScroll("POP", 2008), { kind: "restore", y: 2008 });
    assert.deepEqual(arrivalScroll("POP", undefined), { kind: "top" });
    assert.deepEqual(arrivalScroll("POP", 0), { kind: "top" });
  });

  it("a new page starts at the top — never the previous page's offset", () => {
    assert.deepEqual(arrivalScroll("PUSH", 2008), { kind: "top" });
  });

  it("a replaced URL (a filter, a tab) stays where it is — never jumps to an old position", () => {
    assert.deepEqual(arrivalScroll("REPLACE", 2008), { kind: "keep" });
  });

  it("the first page of a tab is restored on a reload or Back into the app, not on a fresh open", () => {
    assert.deepEqual(arrivalScroll("POP", 900, { firstPage: true, loadType: "reload" }), { kind: "restore", y: 900 });
    assert.deepEqual(arrivalScroll("POP", 900, { firstPage: true, loadType: "back_forward" }), { kind: "restore", y: 900 });
    assert.deepEqual(arrivalScroll("POP", 900, { firstPage: true, loadType: "navigate" }), { kind: "top" });
    assert.equal(isFreshLoad("navigate"), true);
    assert.equal(isFreshLoad(undefined), true);
    assert.equal(isFreshLoad("reload"), false);
    assert.equal(FIRST_ENTRY_KEY, "default");
  });

  it("waits until a list is tall enough before calling a position reached", () => {
    assert.equal(canReach(2000, 1500, 900), false);
    assert.equal(canReach(2000, 2900, 900), true);
  });
});

describe("the detail page's Back link", () => {
  const targets = [
    { path: "/seller/products", label: "Products" },
    { path: "/seller/inventory", label: "Inventory" },
  ];
  const from = (pathname: string, search = "") => ({ key: "k1", pathname, search });

  it("goes back in history to the list it was opened from (filters and all)", () => {
    assert.deepEqual(historyBackTarget(from("/seller/products", "?approval=APPROVED"), "/seller/products/1", targets), targets[0]);
    assert.deepEqual(historyBackTarget(from("/seller/inventory"), "/seller/products/1", targets), targets[1]);
  });

  it("opens the list afresh when the page was not opened from one", () => {
    assert.equal(historyBackTarget(undefined, "/seller/products/1", targets), null); // bookmark / new tab
    assert.equal(historyBackTarget(from("/seller/earnings"), "/seller/products/1", targets), null);
    assert.equal(historyBackTarget(from("/seller/products/1"), "/seller/products/1", targets), null); // same page (a #section)
  });
});

describe("remembered entries", () => {
  it("keep only the newest entries", () => {
    assert.deepEqual(trimEntries({ a: 1, b: 2, c: 3 }, 2), { b: 2, c: 3 });
    assert.deepEqual(trimEntries({ a: 1 }, 2), { a: 1 });
  });

  it("work without sessionStorage (private mode, tests) — the page just forgets", () => {
    const map = storedMap<number>("test.v1");
    map.set("k", 5);
    map.forget(() => true);
    assert.equal(map.get("k"), undefined);
  });
});

describe("wiring", () => {
  it("one ScrollMemory for both panels; the browser's own restoration is off", () => {
    assert.match(read("src/App.tsx"), /<ScrollMemory \/>\n\s+\{pathname === '\/seller'/);
    const memory = read("src/lib/scrollMemory.ts");
    assert.match(memory, /window\.history\.scrollRestoration = 'manual'/);
    assert.match(memory, /if \(currentKey\.current === key\) scrolls\.set\(key, window\.scrollY\)/);
  });

  it("detail pages use BackLink (history Back), never a plain link to the list", () => {
    for (const file of ["src/seller/pages/SellerProductDetail.tsx", "src/seller/pages/SellerListingDetail.tsx"]) {
      const source = read(file);
      assert.match(source, /<BackLink to="\/seller\/products" label="Products" from=\{SELLER_PRODUCT_BACK_FROM\} \/>/, file);
      assert.doesNotMatch(source, /<Link to="\/seller\/products" className="inline-flex items-center gap-1/, file);
    }
    assert.match(read("src/pages/SellerDetail.tsx"), /<BackLink to=\{`\/sellers\$\{listSearch\}`\} label="Sellers" from=\{SELLER_DETAIL_BACK_FROM\} \/>/);
    assert.match(read("src/components/BackLink.tsx"), /navigate\(-1\)/);
  });

  it("list state outside the URL is kept per history entry", () => {
    assert.match(read("src/seller/pages/SellerProducts.tsx"), /const \[shown, setShown\] = useEntryState\('shown', PAGE\);/);
    assert.match(read("src/pages/Products.tsx"), /useEntryState<string\[\]>\('open-variants', \[\]\)/);
    const orders = read("src/pages/Orders.tsx");
    assert.match(orders, /useEntryState<string>\("tab"/);
    assert.match(orders, /useEntryState\("search"/);
    assert.match(orders, /useEntryState<string\[\]>\("expanded", \[\]\)/);
  });
});

describe("no sideways scrolling in the product lists", () => {
  const lists = {
    "src/pages/Products.tsx": "Marketplace products",
    "src/pages/Inventory.tsx": "Marketplace inventory",
    "src/seller/pages/SellerProducts.tsx": "Your products",
  };

  it("no fixed minimum table widths, and no sideways scroller around the lists", () => {
    for (const file of ["src/pages/Products.tsx", "src/pages/Inventory.tsx", "src/pages/Sellers.tsx", "src/seller/pages/SellerProducts.tsx", "src/seller/pages/SellerInventory.tsx"]) {
      const source = read(file);
      const main = file.endsWith("Inventory.tsx") ? source.slice(0, source.indexOf("function HistoryModal")) : source;
      assert.doesNotMatch(main, /<table className="[^"]*min-w-\[/, file);
      assert.doesNotMatch(main, /min-w-\[1[23]rem\]/, file);
    }
  });

  it("cards below xl and a compact table from xl, with the same facts and actions", () => {
    for (const [file, label] of Object.entries(lists)) {
      const source = read(file);
      assert.match(source, new RegExp(`<ul (?:aria-label="${label}" className="grid gap-3 md:grid-cols-2 xl:hidden"|className="grid gap-3 md:grid-cols-2 xl:hidden" aria-label="${label}")`), file);
      assert.match(source, /<Surface className="hidden overflow-hidden xl:block">/, file);
    }
    const admin = read("src/pages/Products.tsx");
    for (const piece of ["ProductName", "ProductPrice", "ProductStock", "ProductBadges", "ProductActions"]) {
      assert.equal((admin.match(new RegExp(`<${piece} `, "g")) ?? []).length, 2, `${piece} in both the cards and the table`);
    }
    assert.match(admin, /<VariantBreakdown row=\{row\} stacked \/>/);
  });

  it("product names wrap in full (English or Hindi) instead of being cut off", () => {
    for (const file of ["src/pages/Products.tsx", "src/pages/Inventory.tsx", "src/seller/pages/SellerProducts.tsx", "src/seller/pages/SellerInventory.tsx"]) {
      const source = read(file);
      assert.match(source, /break-words font-semibold leading-snug text-gray-900/, file);
    }
    const seller = read("src/seller/pages/SellerProducts.tsx");
    const table = seller.slice(seller.indexOf("xl+: table sized to the page"));
    assert.doesNotMatch(table.slice(0, table.indexOf("</table>")), /line-clamp-2/);
  });
});
