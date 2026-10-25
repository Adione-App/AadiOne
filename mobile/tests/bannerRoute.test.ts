/**
 * Where a banner / Home card tap goes (src/lib/bannerRoute.ts) — run with
 * `npm run test:unit`.
 *
 * Regression: a Home "restaurant" card (production's Home cards and food
 * carousel all use this action) opened the menu as the Food tab's ONLY
 * screen when the Food tab had not been opened yet — no restaurant list to
 * go back to, and the Food tab kept showing that menu.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bannerRoute } from "../src/lib/bannerRoute.ts";

const SELLER = "8f393434-5224-436a-bda4-a0cc61022a6d";

describe("bannerRoute", () => {
  it("a restaurant banner opens that menu inside the Food tab, with the restaurant list kept beneath it", () => {
    assert.deepEqual(bannerRoute({ actionType: "RESTAURANT", actionValue: SELLER }), {
      name: "Food",
      params: { screen: "RestaurantMenu", params: { sellerId: SELLER }, initial: false },
    });
  });

  it("a Food-section banner opens the restaurant list itself", () => {
    assert.deepEqual(bannerRoute({ actionType: "FOOD", actionValue: null }), { name: "Food", params: { screen: "FoodHome" } });
  });

  it("every screen opened in another tab keeps that tab's first screen underneath", () => {
    for (const banner of [
      { actionType: "PRODUCT" as const, actionValue: "p1" },
      { actionType: "STORE" as const, actionValue: "s1" },
      { actionType: "RAIL" as const, actionValue: "TOP_PICKS" },
      { actionType: "RESTAURANT" as const, actionValue: SELLER },
    ]) {
      const route = bannerRoute(banner);
      assert.ok(route, banner.actionType);
      assert.equal(route.params.initial, false, banner.actionType);
    }
  });

  it("a category banner opens the Categories tab on that category", () => {
    assert.deepEqual(bannerRoute({ actionType: "CATEGORY", actionValue: "c1" }), {
      name: "Categories",
      params: { screen: "CategoriesHome", params: { categoryId: "c1" } },
    });
  });

  it("no target, an unknown rail, or a non-screen action: no navigation (never a dead page)", () => {
    assert.equal(bannerRoute({ actionType: "RESTAURANT", actionValue: null }), null);
    assert.equal(bannerRoute({ actionType: "RAIL", actionValue: "NOT_A_RAIL" }), null);
    assert.equal(bannerRoute({ actionType: "URL", actionValue: "https://adione.in" }), null);
    assert.equal(bannerRoute({ actionType: "NONE", actionValue: null }), null);
  });
});
