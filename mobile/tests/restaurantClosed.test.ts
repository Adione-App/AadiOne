/**
 * A restaurant / cafe that is not taking orders — run with `npm run test:unit`.
 * The screens need a device, so their wiring is checked on the source. The
 * server side (closed adds refused, cart lines kept, checkout refused):
 * backend tests/integration/restaurant-closed.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const badge = read("src/components/ClosedBadge.tsx");
const homeCard = read("src/components/RestaurantCard.tsx");
const foodCard = read("src/components/FoodRestaurantCard.tsx");
const menu = read("src/screens/food/RestaurantMenuScreen.tsx");
const home = read("src/screens/home/HomeScreen.tsx");
const food = read("src/screens/food/FoodScreen.tsx");
const cartActions = read("src/lib/useCartActions.ts");
const availability = read("src/lib/storeAvailability.ts");
const focusHook = read("src/lib/useRefreshOnFocus.ts");

/** The menu row's action slot, from `closed ?` to the end of the ADD button. */
const actionSlot = menu.slice(menu.indexOf("<View style={styles.action}>"), menu.indexOf("</Pressable>\n          )}"));

describe("the CLOSED label", () => {
  it("is light red with dark red text, and is a label, not a button", () => {
    assert.match(badge, /CLOSED_BG = "#FDECEC"/);
    assert.match(badge, /CLOSED_FG = "#B42318"/);
    assert.match(badge, />CLOSED<\/AppText>/);
    assert.doesNotMatch(badge, /Pressable|onPress|accessibilityRole="button"/);
  });

  it("fills the ADD button's slot at ADD's size (96 x 34), so the row keeps its alignment", () => {
    assert.match(badge, /action: \{\n\s*minWidth: 96,\n\s*height: 34,/);
  });
});

describe("Home and Food list cards", () => {
  it("Home's restaurant card shows the CLOSED badge instead of the dark band, and stays pressable", () => {
    assert.match(homeCard, /\{!restaurant\.isOpen && <ClosedBadge style=\{styles\.closedBadge\} \/>\}/);
    assert.doesNotMatch(homeCard, /closedBand|Closed now/);
    assert.match(homeCard, /<Pressable\n\s*onPress=\{\(\) => onPress\(restaurant\.sellerId\)\}/);
  });

  it("the Food list card swaps its grey Closed pill for the light red CLOSED (the Open pill is unchanged)", () => {
    assert.match(foodCard, /restaurant\.isOpen \? \(\n\s*<View style=\{\[styles\.status, styles\.statusOpen\]\}>/);
    assert.match(foodCard, /<ClosedBadge style=\{styles\.closedBadge\} \/>/);
    assert.doesNotMatch(foodCard, /statusClosed|"Closed"/);
  });

  it("a closed-store refusal is a short popup, never Home's persistent banner", () => {
    const branch = cartActions.slice(cartActions.indexOf("err.code === ErrorCode.SELLER_CLOSED"));
    assert.match(branch, /^err\.code === ErrorCode\.SELLER_CLOSED\) \{[\s\S]*?showCartNotice\(err\.message\);\n\s*revalidateStoreAvailability\(\);\n\s*\} else \{/);
    // Home's only cart banner is the shared cart error, which this never sets.
    assert.match(home, /\{cartError && \(/);
  });
});

describe("the menu page of a closed restaurant", () => {
  it("its header shows CLOSED (and when it opens next, if known)", () => {
    assert.match(menu, /\{restaurant\.isOpen \? \([\s\S]*?Open now[\s\S]*?\) : \(\n\s*<>\n\s*<ClosedBadge \/>/);
  });

  it("shows no banner on top: the error strip is for an open restaurant only", () => {
    assert.match(menu, /\{cart\.error && !closed && \(/);
  });

  it("every item shows CLOSED in place of ADD — and of the stepper, even for an item already in the cart", () => {
    assert.ok(actionSlot.indexOf("{closed ? (") >= 0);
    assert.ok(actionSlot.indexOf("{closed ? (") < actionSlot.indexOf("<ClosedBadge size=\"action\" />"));
    assert.ok(actionSlot.indexOf("<ClosedBadge size=\"action\" />") < actionSlot.indexOf("<QuantityStepper"));
    assert.ok(actionSlot.indexOf("<ClosedBadge size=\"action\" />") < actionSlot.indexOf("styles.addButton"));
  });

  it("the menu stays browsable: sections, names, photos and prices do not depend on open / closed", () => {
    const sectionsBlock = menu.slice(menu.indexOf("const allSections = useMemo"), menu.indexOf("const sections = useMemo"));
    assert.doesNotMatch(sectionsBlock, /isOpen|closed/);
    assert.match(menu, /const closed = menu\.data\?\.restaurant\.isOpen === false;/);
    assert.match(menu, /closed=\{closed\}/);
  });

  it("an open restaurant gets ADD and the stepper back (the same row, closed = false)", () => {
    assert.match(actionSlot, /\) : qty > 0 \? \(\n\s*<QuantityStepper/);
    assert.match(actionSlot, /<AppText style=\{styles\.addText\}>ADD<\/AppText>/);
    assert.match(menu, /\[cart, closed\],/);
  });
});

describe("open / closed reaches the screen without a restart", () => {
  it("the socket / resume refresh includes the restaurant list and the menu", () => {
    assert.match(availability, /\["restaurants"\],\n\s*\["restaurant-menu"\],/);
  });

  it("the menu asks again on focus and every minute while shown; Home and Food on focus", () => {
    assert.match(menu, /useRefreshOnFocus\(menu, \{ intervalMs: 60_000 \}\);/);
    assert.match(home, /useRefreshOnFocus\(restaurantsQuery, \{ minAgeMs: 30_000 \}\);/);
    assert.match(food, /useRefreshOnFocus\(query, \{ minAgeMs: 30_000 \}\);/);
  });

  it("the focus refresh cleans up its timer", () => {
    assert.match(focusHook, /const timer = setInterval\(refresh, intervalMs\);\n\s*return \(\) => clearInterval\(timer\);/);
  });
});

describe("other stores are unaffected", () => {
  it("only the restaurant / cafe screens use the CLOSED label", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(path.join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && /from "@\/components\/ClosedBadge"/.test(read(rel))) users.push(rel);
      }
    };
    walk("src");
    assert.deepEqual(users.sort(), [
      "src/components/FoodRestaurantCard.tsx",
      "src/components/RestaurantCard.tsx",
      "src/screens/food/RestaurantMenuScreen.tsx",
    ]);
    // The grocery / clothing card keeps its own "Store closed" treatment.
    assert.match(read("src/components/ProductCard.tsx"), /Store closed/);
  });
});
