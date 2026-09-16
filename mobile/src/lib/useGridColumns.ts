/**
 * Column count for product grids.
 *
 * A fixed `numColumns={2}` is fine on a phone but stretches into two huge,
 * awkwardly wide cards on a tablet — the product photo scales up past its
 * source resolution and ends up looking cropped/blurry rather than simply
 * "bigger". Picking columns from the available width keeps each card close
 * to its designed size on every device instead.
 */

import { useWindowDimensions } from 'react-native';

const TARGET_CARD_WIDTH = 150;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 5;

export function useGridColumns(horizontalPadding = 16): number {
  const { width } = useWindowDimensions();
  const usable = Math.max(0, width - horizontalPadding);
  const fit = Math.round(usable / TARGET_CARD_WIDTH);
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, fit));
}
