/**
 * The ONE out-of-stock wording the customer app shows — product cards (Home,
 * category and subcategory listings, search, stores, shelves), the product
 * page and the variant sheet all read it from here, drawn by the shared
 * components/OutOfStockLabel.tsx. Never "Sold Out", "Out of stock" or a
 * shortened form.
 *
 * Pure (no React Native) so tests read it directly (tests/stockLabel.test.ts).
 */

export const OUT_OF_STOCK_LABEL = "Out of Stock";

/** What a screen reader says for it. */
export const OUT_OF_STOCK_A11Y_LABEL = "Out of stock";
