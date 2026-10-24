/**
 * Which stored image each Food surface shows. Three separate sources, and
 * none of them ever borrows another's picture:
 *
 *   Restaurant Image   restaurant.coverImageUrl   Food list card, Home food rail
 *   Menu Cover Image   restaurant.menuImageUrl    hero at the top of the menu page
 *   Menu item image    item.imageUrl              that item's own row
 *
 * A missing (or failed) image is the surface's own placeholder, never the
 * first menu item's photo or the other restaurant image: borrowing made the
 * card, the menu hero and the first menu row the same picture.
 *
 * Pure (no React Native), so `npm run test:unit` covers it.
 */

/** A stored image reference, or null for a missing / blank one. */
function stored(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  return trimmed ? trimmed : null;
}

/** The Restaurant Image (Food list card, Home food rail). */
export function restaurantListImage(restaurant: { coverImageUrl?: string | null }): string | null {
  return stored(restaurant.coverImageUrl);
}

/** The Menu Cover Image (menu page hero). */
export function restaurantMenuCoverImage(restaurant: { menuImageUrl?: string | null }): string | null {
  return stored(restaurant.menuImageUrl);
}

/** One menu item's own photo. */
export function menuItemImage(item: { imageUrl?: string | null }): string | null {
  return stored(item.imageUrl);
}
