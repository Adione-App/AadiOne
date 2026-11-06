/**
 * The rules of the "Category products" dialog (categoryProductSection.tsx),
 * kept free of React so they are unit-tested (web/tests/homeBuilder.test.ts).
 */

import { PRODUCT_SHELF_COUNT_LIMITS, type AdminCategoryOptionDto, type CategoryShelfSource, type HomeLayoutContent } from '@shared';

/** The counts offered first (any number within the limits can be typed). */
export const CATEGORY_SECTION_COUNTS = [10, 12, 15] as const;

export interface CategoryProductSectionInput {
  path: string;
  title: string;
  count: number;
  source: CategoryShelfSource;
}

/** Why the form cannot be added yet, or null. Pure — unit-tested. */
export function categorySectionProblem(
  input: CategoryProductSectionInput,
  options: readonly AdminCategoryOptionDto[],
  layout: HomeLayoutContent,
): string | null {
  if (!options.some((option) => option.path === input.path)) return 'Choose the category its products come from.';
  if (!input.title.trim()) return 'Give the section a heading — customers see it above the products.';
  if (!Number.isInteger(input.count) || input.count < PRODUCT_SHELF_COUNT_LIMITS.min || input.count > PRODUCT_SHELF_COUNT_LIMITS.max) {
    return `Show between ${PRODUCT_SHELF_COUNT_LIMITS.min} and ${PRODUCT_SHELF_COUNT_LIMITS.max} products.`;
  }
  const heading = input.title.trim().toLowerCase();
  if (layout.sections.some((section) => section.visible && section.title?.trim().toLowerCase() === heading)) {
    return 'Another section already has this heading — give each section its own.';
  }
  return null;
}
