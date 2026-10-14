/**
 * Opens the app-wide variant sheet (components/VariantSheet.tsx, mounted once
 * in App.tsx) for a product with several sizes / options — from any product
 * card on any screen, without each screen hosting its own sheet.
 *
 * `onViewDetails` is the opening screen's own "open this product" navigation,
 * so "View Details" goes wherever a tap on that card already goes.
 */

import { create } from "zustand";
import type { ProductSummaryDto } from "@shared";

interface VariantSheetState {
  product: ProductSummaryDto | null;
  onViewDetails: (() => void) | null;
  open: (product: ProductSummaryDto, onViewDetails: () => void) => void;
  close: () => void;
}

export const useVariantSheet = create<VariantSheetState>((set) => ({
  product: null,
  onViewDetails: null,
  open: (product, onViewDetails) => set({ product, onViewDetails }),
  close: () => set({ product: null, onViewDetails: null }),
}));
