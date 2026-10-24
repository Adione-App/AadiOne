/**
 * Food image sources (src/lib/restaurantImages.ts) — run with `npm run test:unit`.
 *
 * Regression: a restaurant without its own photos showed the first menu
 * item's photo on its Food card, as its menu hero AND on that item's row.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { menuItemImage, restaurantListImage, restaurantMenuCoverImage } from "../src/lib/restaurantImages.ts";

const RESTAURANT_IMAGE = "https://cdn.example/products/s-1/2026-10-24/place.webp";
const MENU_COVER = "https://cdn.example/products/s-1/2026-10-24/menu.webp";
const ITEM_PHOTO = "https://cdn.example/products/s-1/2026-10-18/burger-thumb.webp";

describe("restaurant images", () => {
  it("each surface shows its own stored image", () => {
    const restaurant = { coverImageUrl: RESTAURANT_IMAGE, menuImageUrl: MENU_COVER, logoUrl: null };
    assert.equal(restaurantListImage(restaurant), RESTAURANT_IMAGE);
    assert.equal(restaurantMenuCoverImage(restaurant), MENU_COVER);
    assert.equal(menuItemImage({ imageUrl: ITEM_PHOTO }), ITEM_PHOTO);
  });

  it("never borrows the first menu item's photo when the restaurant has none", () => {
    const restaurant = { coverImageUrl: null, menuImageUrl: null, logoUrl: null };
    const items = [{ imageUrl: ITEM_PHOTO }, { imageUrl: null }];
    assert.equal(restaurantListImage(restaurant), null);
    assert.equal(restaurantMenuCoverImage(restaurant), null);
    assert.deepEqual(items.map(menuItemImage), [ITEM_PHOTO, null]);
  });

  it("never uses the Restaurant Image as the Menu Cover, or the other way round", () => {
    const onlyRestaurantImage = { coverImageUrl: RESTAURANT_IMAGE, menuImageUrl: null };
    const onlyMenuCover = { coverImageUrl: null, menuImageUrl: MENU_COVER };
    assert.equal(restaurantMenuCoverImage(onlyRestaurantImage), null);
    assert.equal(restaurantListImage(onlyMenuCover), null);
  });

  it("treats a missing or blank reference as no image (older servers omit the fields)", () => {
    assert.equal(restaurantListImage({}), null);
    assert.equal(restaurantMenuCoverImage({ menuImageUrl: "   " }), null);
    assert.equal(menuItemImage({ imageUrl: undefined }), null);
    assert.equal(restaurantMenuCoverImage({ menuImageUrl: ` ${MENU_COVER} ` }), MENU_COVER);
  });
});
