/**
 * "Latest Products" on Home — the newest products a customer can buy right
 * now, newest first: the server's newest-first listing (GET
 * /products/rail/RECENTLY_ADDED — ordered by when the product was created,
 * with the catalogue's own live-seller, approval and stock rules), the same
 * list "View All" opens. Never best-sellers or random picks, and — unlike
 * the Home feed's de-duplicated preview — never skips a new product because
 * another section shows it too.
 *
 * Heading and count come from the Home Page Builder. Drawn with the shared
 * ProductShelf, so cards, wishlist, prices, variants and cart behave exactly
 * as everywhere else on Home. While it loads, when it fails, or when nothing
 * is in stock, the section is simply left out — Home never shows a broken
 * or empty shelf.
 */

import { memo, useMemo } from "react";
import type { ProductSummaryDto } from "@shared";
import { useRailProducts } from "@/lib/queries";
import type { HomeAction, HomeSection } from "../homeEngine";
import { ProductShelf } from "./ProductShelf";

const LATEST_RAIL = "RECENTLY_ADDED" as const;

/** Only things a customer can add right now (the engine's own rule for Home). */
const isBuyable = (product: ProductSummaryDto) => product.defaultVariant !== null && product.defaultVariant.inStock;

function LatestProductsImpl({
  title,
  subtitle,
  maxItems,
  onOpenProduct,
  onAction,
}: {
  title: string;
  subtitle: string | null;
  maxItems: number;
  onOpenProduct: (productId: string) => void;
  onAction: (action: HomeAction) => void;
}) {
  const query = useRailProducts(LATEST_RAIL);
  const section = useMemo((): Extract<HomeSection, { kind: "shelf" }> | null => {
    const products = (query.data?.products ?? []).filter(isBuyable).slice(0, maxItems);
    if (products.length === 0) return null;
    return {
      kind: "shelf",
      key: "latest-products",
      title,
      subtitle,
      products,
      viewAll: { type: "rail", railKey: LATEST_RAIL, title },
    };
  }, [query.data, maxItems, title, subtitle]);

  if (!section) return null;
  return <ProductShelf section={section} onOpenProduct={onOpenProduct} onAction={onAction} />;
}

export const LatestProducts = memo(LatestProductsImpl);
