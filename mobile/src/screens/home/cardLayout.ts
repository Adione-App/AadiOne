/**
 * Sizes of Home's configurable cards — pure, so `npm run test:unit` covers
 * them (tests/cardLayout.test.ts).
 *
 * The extra white space around Home cards came from boxes sized without
 * their content:
 *   - top cards ("home_cards" banners) were a fixed-height box: a "show the
 *     whole image" card whose image is a different shape got empty bands,
 *     drawn white — a white frame around artwork meant to fill the card;
 *   - category tiles had a fixed box per tiles-per-row, so on a wider phone
 *     the rest of each cell became an ever bigger gap between tiles.
 * Here a card takes its image's own shape, and a tile fills its cell less
 * one constant gap — still within the same safe limits, never wider than the
 * screen, never stretching or cropping an image the admin asked to show whole.
 */

import { HOME_CARD_HEIGHT_LIMITS } from "@shared";

export interface FeatureCardInput {
  /** The banner's image fit: "contain" = show the whole image, "cover" = fill the card. */
  fit: "contain" | "cover";
  /** Width / height of its image; null when unknown. */
  aspectRatio: number | null;
}

/**
 * The top cards' width and the row's shared height. Width: the screen less
 * the side margins and gaps, split evenly (never overflowing). Height: when
 * every card shows its whole image, the height at which those images fill
 * their cards exactly (the tallest of them, so no card is cut) — kept within
 * the card height limits; otherwise the height set in the Home Page Builder.
 */
export function featureCardSize(input: {
  screenWidth: number;
  side: number;
  gap: number;
  configuredHeight: number;
  cards: readonly FeatureCardInput[];
}): { width: number; height: number } {
  const count = Math.max(1, input.cards.length);
  const width = Math.max(0, Math.floor((input.screenWidth - input.side * 2 - input.gap * (count - 1)) / count));
  const natural = input.cards.every((card) => card.fit === "contain" && card.aspectRatio !== null && card.aspectRatio > 0)
    ? Math.max(...input.cards.map((card) => width / card.aspectRatio!))
    : null;
  const height = natural === null ? input.configuredHeight : Math.round(natural);
  return { width, height: Math.min(HOME_CARD_HEIGHT_LIMITS.max, Math.max(HOME_CARD_HEIGHT_LIMITS.min, height)) };
}

/** Space between neighbouring category tiles in a grid (dp) — one consistent gap. */
export const CATEGORY_TILE_GAP = 6;

/**
 * A grid tile's coloured box and its image for a cell of `cell` dp: the box
 * fills the cell less the gap; the image keeps the designed share of the box
 * (`designImage` / `designBox`, e.g. 72 / 88 at 4 per row) so a bigger tile
 * shows a proportionally bigger whole image — or the whole box when the
 * admin chose "fill the tile".
 */
export function categoryTileSize(input: {
  cell: number;
  designBox: number;
  designImage: number;
  imageFit: "contain" | "cover";
}): { box: number; image: number } {
  const box = Math.max(48, Math.floor(input.cell - CATEGORY_TILE_GAP));
  if (input.imageFit === "cover") return { box, image: box };
  const image = Math.max(36, Math.round(box * (input.designImage / input.designBox)));
  return { box, image: Math.min(image, box) };
}
