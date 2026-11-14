/**
 * App-wide closure vs one seller's closure, as the customer app shows them
 * (src/lib/closureDisplay.ts) — run with `npm run test:unit`. The server side
 * (both layers enforced, the cart's sentences, payment-start precedence):
 * backend tests/integration/store-checkout-eligibility.test.ts. The screens
 * need a device, so their wiring is checked on the source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cartLineAccessibilityLabel,
  cartLineDisplay,
  deliveryNoticeCoveredByGlobal,
  notAddableLabel,
  resolveGlobalOrdering,
  sellerClosedRefusalMessage,
  sellerStatusShown,
  shownStoreClosedHint,
} from "../src/lib/closureDisplay.ts";
import { DEFAULT_CLOSED_MESSAGE, globalClosedNotice } from "../src/lib/platformAvailability.ts";
import { orderedLines, partialOrderNotice } from "../src/lib/cartAvailability.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const PAUSED = "Aadione is closed right now. Opens tomorrow at 8:00 AM.";
const SELLER = "Ram Dev Clothing";
const SELLER_SENTENCE = `${SELLER} is closed right now. Opens today at 10:00 AM.`;
/** Every sentence the server can send for a closed seller's line (seller.service.ts sellerClosedMessage). */
const SELLER_SENTENCES = [
  SELLER_SENTENCE,
  `${SELLER} is closed today. Opens tomorrow at 9:00 AM.`,
  `${SELLER} is not taking orders right now.`,
  "This store is not available right now.",
];
/** None of this may appear on a closed seller's cart line. */
const FORBIDDEN = [/Ram Dev/i, /Seller:/i, /Opens/i, /not taking orders/i, /closed right now/i, /closed today/i, /not available right now/i];

type Reason = "STORE_CLOSED" | "PRODUCT_UNAVAILABLE" | "OUT_OF_STOCK" | null;
const line = (id: string, available: boolean, unavailableReason: Reason = null, unavailableMessage: string | null = null) => ({
  sellerListingId: id,
  unitPricePaise: 10000,
  sellerName: SELLER,
  available,
  unavailableReason,
  unavailableMessage,
});
const openLine = (id: string) => line(id, true);
const closedStoreLine = (id: string, sentence = SELLER_SENTENCE) => line(id, false, "STORE_CLOSED", sentence);

/**
 * Everything the Cart row renders from its line (CartScreen renderItem:
 * `{line.label}`, `{line.detail}` and the row's accessibilityLabel) — the
 * product name, size and price are the row's own fields.
 */
const rowTexts = (item: ReturnType<typeof line>, globalClosed: boolean) => {
  const display = cartLineDisplay(item, globalClosed);
  return [display.label, display.detail, cartLineAccessibilityLabel("Cotton Kurta", display)].filter((t): t is string => Boolean(t));
};
const lineText = (display: ReturnType<typeof cartLineDisplay>) => [display.label, display.detail].filter(Boolean).join(" ");

describe("which state is in force", () => {
  it("closed when /availability or the cart says so; the cart's message first", () => {
    assert.deepEqual(resolveGlobalOrdering(null, { orderingEnabled: true, orderingPausedMessage: null }), { closed: false, message: null });
    assert.deepEqual(resolveGlobalOrdering(PAUSED, null), { closed: true, message: PAUSED });
    // The cart's read is newer than /availability's: closed either way.
    assert.deepEqual(resolveGlobalOrdering(null, { orderingEnabled: false, orderingPausedMessage: "Back at 7 AM." }), {
      closed: true,
      message: "Back at 7 AM.",
    });
    assert.deepEqual(resolveGlobalOrdering(PAUSED, { orderingEnabled: true, orderingPausedMessage: null }), { closed: true, message: PAUSED });
    assert.deepEqual(resolveGlobalOrdering(null, { orderingEnabled: false, orderingPausedMessage: "  " }), {
      closed: true,
      message: DEFAULT_CLOSED_MESSAGE,
    });
  });

  it("the master switch OFF and a server pause both come through as closed", () => {
    const off = globalClosedNotice(null, { ORDERING_ENABLED: false, ORDERING_PAUSED_MESSAGE: "" });
    assert.equal(resolveGlobalOrdering(off).closed, true);
    const paused = globalClosedNotice({ acceptingOrders: false, message: PAUSED }, null);
    assert.equal(resolveGlobalOrdering(paused).message, PAUSED);
  });
});

describe("1 + 2. app closed (all stores open, or some closed)", () => {
  it("a closed seller's cart line: no SELLER CLOSED, no name, no opening time, no sentence; Qty and Remove only", () => {
    const display = cartLineDisplay(closedStoreLine("c"), true);
    assert.deepEqual(display, { stepper: false, increase: false, faded: false, greyed: false, label: null, labelTone: "muted", detail: null });
    for (const sentence of SELLER_SENTENCES) assert.deepEqual(rowTexts(closedStoreLine("c", sentence), true), [], sentence);
  });

  it("an open store's line is unchanged", () => {
    assert.deepEqual(cartLineDisplay(openLine("a"), true), cartLineDisplay(openLine("a"), false));
    assert.equal(cartLineDisplay(openLine("a"), true).stepper, true);
  });

  it("product reasons (sold out, off sale) name no seller and still show", () => {
    const sold = cartLineDisplay(line("s", false, "OUT_OF_STOCK", "Milk 1 L is out of stock right now."), true);
    assert.equal(sold.label, "OUT OF STOCK — UNAVAILABLE RIGHT NOW");
    assert.equal(sold.stepper, false);
  });

  it("products of a closed store read a neutral Unavailable — no 'Store closed', no store sentence", () => {
    const label = notAddableLabel(true, true, SELLER_SENTENCE);
    assert.deepEqual(label, { text: "Unavailable", accessibilityLabel: "Unavailable right now", tone: "muted" });
    assert.equal(shownStoreClosedHint("Opens today at 10:00 AM.", true), "");
    assert.equal(shownStoreClosedHint(null, true), null);
  });

  it("no restaurant / store status, no 'stores near you are closed' notice, and a refused add shows the app-wide notice", () => {
    assert.equal(sellerStatusShown(true), false);
    for (const state of ["ORDERING_DISABLED", "STORE_CLOSED", "STORE_NOT_ACCEPTING"] as const) {
      assert.equal(deliveryNoticeCoveredByGlobal(state, true), true, state);
    }
    // Outside the area is not about stores being closed: still shown.
    assert.equal(deliveryNoticeCoveredByGlobal("OUTSIDE_RADIUS", true), false);
    assert.equal(sellerClosedRefusalMessage(SELLER_SENTENCE, PAUSED), PAUSED);
  });
});

describe("3. app paused with items already in the cart", () => {
  it("every line is kept (nothing filtered out); no partial-order notice is computed; nothing to order", () => {
    const items = [openLine("a"), closedStoreLine("c"), line("s", false, "OUT_OF_STOCK", "Out of stock.")];
    const displays = items.map((item) => cartLineDisplay(item, true));
    assert.equal(displays.length, 3);
    for (const display of displays) for (const pattern of FORBIDDEN) assert.doesNotMatch(lineText(display), pattern);
    // The Cart shows no partial notice while closed (CartScreen), and the
    // server refuses any order; the lines an order WOULD take are unchanged.
    assert.deepEqual(orderedLines(items).map((entry) => entry.sellerListingId), ["a"]);
  });
});

describe("4 + 5 + 6. app open: each store on its own", () => {
  it("a seller closed after its product was added: ONLY 'SELLER CLOSED — UNAVAILABLE RIGHT NOW'; − and Remove, + disabled", () => {
    const display = cartLineDisplay(closedStoreLine("c"), false);
    assert.deepEqual(display, {
      stepper: true,
      increase: false,
      faded: true,
      greyed: true,
      label: "SELLER CLOSED — UNAVAILABLE RIGHT NOW",
      labelTone: "danger",
      detail: null,
    });
  });

  it("whatever the server's sentence: no seller name, opening time or explanation, and the label exactly once", () => {
    for (const sentence of SELLER_SENTENCES) {
      const texts = rowTexts(closedStoreLine("c", sentence), false);
      assert.deepEqual(texts, ["SELLER CLOSED — UNAVAILABLE RIGHT NOW", "Cotton Kurta, seller closed — unavailable right now."], sentence);
      for (const text of texts) for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${sentence} → ${text}`);
      assert.equal(texts.filter((text) => text === "SELLER CLOSED — UNAVAILABLE RIGHT NOW").length, 1);
    }
  });

  it("product reasons are unchanged: their own sentence, Qty and Remove only", () => {
    const sold = cartLineDisplay(line("s", false, "OUT_OF_STOCK", "Milk 1 L is out of stock right now."), false);
    assert.deepEqual([sold.stepper, sold.increase, sold.label, sold.detail], [false, false, "OUT OF STOCK — UNAVAILABLE RIGHT NOW", "Milk 1 L is out of stock right now."]);
  });

  it("mixed availability: open stores' lines work normally beside it, and the mixed-cart notice counts them", () => {
    const items = [openLine("a"), openLine("b"), closedStoreLine("c")];
    assert.deepEqual(items.map((item) => cartLineDisplay(item, false).increase), [true, true, false]);
    assert.match(partialOrderNotice(items) ?? "", /^1 item can't be ordered right now/);
    assert.deepEqual(orderedLines(items).map((entry) => entry.sellerListingId), ["a", "b"]);
  });

  it("all open: nothing marked", () => {
    const items = [openLine("a"), openLine("b")];
    assert.ok(items.every((item) => lineText(cartLineDisplay(item, false)) === ""));
    assert.equal(partialOrderNotice(items), null);
  });

  it("products of a closed store: 'Store closed' with the server's sentence; its status and refusals are shown", () => {
    assert.deepEqual(notAddableLabel(true, false, SELLER_SENTENCE), { text: "Store closed", accessibilityLabel: SELLER_SENTENCE, tone: "danger" });
    assert.equal(notAddableLabel(false, false, null).text, "Out of Stock");
    assert.equal(shownStoreClosedHint("Opens today at 10:00 AM.", false), "Opens today at 10:00 AM.");
    assert.equal(sellerStatusShown(false), true);
    assert.equal(deliveryNoticeCoveredByGlobal("STORE_CLOSED", false), false);
    assert.equal(sellerClosedRefusalMessage(SELLER_SENTENCE, null), SELLER_SENTENCE);
  });
});

describe("7. items added before the app's state changes", () => {
  it("the same line: nothing while the app is closed; only the SELLER CLOSED label once it reopens", () => {
    const item = closedStoreLine("c");
    assert.equal(lineText(cartLineDisplay(item, true)), "");
    assert.equal(lineText(cartLineDisplay(item, false)), "SELLER CLOSED — UNAVAILABLE RIGHT NOW");
  });

  it("a change of the app's state asks the cart again", () => {
    const provider = read("src/lib/globalOrdering.tsx");
    assert.match(provider, /if \(previous\.current === closed\) return;[\s\S]*?invalidateQueries\(\{ queryKey: keys\.cart \}\)/);
  });
});

describe("screens read the one answer", () => {
  const app = read("App.tsx");
  const home = read("src/screens/home/HomeScreen.tsx");
  const cart = read("src/screens/cart/CartScreen.tsx");
  const ui = read("src/components/ui.tsx");

  it("one provider for the whole app; Home and Cart use it", () => {
    assert.match(app, /<GlobalOrderingProvider>\n\s*<RootNavigator/);
    assert.match(home, /const globalClosed = useGlobalClosedNotice\(\);/);
    assert.doesNotMatch(home, /usePlatformAvailability|globalClosedNotice\(/);
    assert.match(cart, /const globalClosedNotice = useGlobalClosedNotice\(\);/);
    assert.match(cart, /const globalOrdering = resolveGlobalOrdering\(globalClosedNotice, cart\);/);
  });

  it("the closed banner is light red (#FDECEC / #B42318 / #F2B8B5) on Home and Cart", () => {
    assert.match(ui, /CLOSED_NOTICE_COLORS = \{ background: "#FDECEC", text: "#B42318", border: "#F2B8B5" \}/);
    assert.match(home, /<NoticeStrip message=\{globalClosed\} tone="closed" \/>/);
    assert.match(cart, /<NoticeStrip message=\{globalOrdering\.message \?\? ""\} tone="closed" \/>/);
  });

  it("Cart: checkout off while closed, no partial notice, lines through cartLineDisplay", () => {
    assert.match(cart, /const canCheckout = checkoutEnabled && !outOfArea && !globalOrdering\.closed;/);
    assert.match(cart, /const partialNotice = globalOrdering\.closed \? null : partialOrderNotice\(cart\.items\);/);
    assert.match(cart, /const line = cartLineDisplay\(item, globalOrdering\.closed\);/);
  });

  it("the rendered Cart row shows no seller name, opening time or sentence of a closed seller", () => {
    const row = cart.slice(cart.indexOf("const renderItem = ({ item }"), cart.indexOf("/* ==============================================================\n   * MAIN"));
    assert.ok(row.length > 500, "renderItem found");
    // The row's text: product name, size, prices, the line's label / detail, its quantity.
    const texts = [...row.matchAll(/>\s*\n?\s*(\{[^}]+\}|[^<{\s][^<]*)\s*<\/AppText>/g)].map((m) => m[1]!.trim());
    assert.deepEqual(texts, [
      "{item.productName}",
      "{item.variantName}",
      "{formatPaise(item.unitPricePaise)}",
      "{formatPaise(item.mrpPaise)}",
      "{line.label}",
      "{line.detail}",
      "Qty {qty}",
    ]);
    // Nothing of the seller reaches the row except through cartLineDisplay (no seller fields, no popup).
    assert.doesNotMatch(row, /sellerName|storeNextOpenText|nextOpenText|unavailableMessage|storeClosedReason|showCartNotice|Seller:|Opens/);
    assert.match(row, /accessibilityLabel=\{cartLineAccessibilityLabel\(item\.productName, line\)\}/);
  });

  it("Cart: + is disabled on a closed seller's line (no popup); − and Remove still work", () => {
    const row = cart.slice(cart.indexOf("const renderItem = ({ item }"), cart.indexOf("/* ==============================================================\n   * MAIN"));
    assert.match(row, /increaseDisabled=\{!line\.increase\}\n\s*onIncrement=\{\(\) => void actions\.increment\(item\.variantId\)\}/);
    assert.match(row, /onDecrement=\{\(\) => \{[\s\S]*?void actions\.decrement\(item\.variantId\);/);
    assert.match(row, /void actions\.remove\(item\.variantId\);/);
    const stepper = read("src/components/ProductCard.tsx");
    assert.match(stepper, /const atMax = qty >= max \|\| increaseDisabled;/);
    assert.match(stepper, /onPress=\{onIncrement\}[\s\S]{0,300}?disabled=\{increaseDisabled\}/);
  });

  it("cards, product page, sheet, stores and menus hide a store's own closure while the app is closed", () => {
    assert.match(read("src/components/ProductCard.tsx"), /notAddableLabel\(storeClosed, globalClosed, variant\?\.sellerClosedMessage\)/);
    assert.match(read("src/screens/catalog/ProductDetailScreen.tsx"), /shownStoreClosedHint\(storeClosedHint\(allVariants\), globalClosed\)/);
    assert.match(read("src/components/VariantSheet.tsx"), /shownStoreClosedHint\(storeClosedHint\(visible\), globalClosed\)/);
    assert.match(read("src/screens/catalog/StoreScreen.tsx"), /\{showStatus && \(/);
    assert.match(read("src/screens/home/sections/StoreSection.tsx"), /\{!store\.isOpen && !globalClosed && \(/);
    assert.match(read("src/components/FoodRestaurantCard.tsx"), /\{showStatus && !restaurant\.isOpen && restaurant\.nextOpenText \? \(/);
    assert.match(home, /!deliveryNoticeCoveredByGlobal\(delivery\.state, globalClosed !== null\)/);
  });
});
