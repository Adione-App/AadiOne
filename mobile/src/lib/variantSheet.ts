/**
 * Opens the app-wide variant sheet (components/VariantSheet.tsx, mounted once
 * in App.tsx) for a product with several sizes / options that can be bought
 * — from any product card on any screen, without each screen hosting its own
 * sheet.
 *
 * `onViewDetails` is the opening screen's own "open this product" navigation,
 * so "View Details" goes wherever a tap on that card already goes.
 *
 * `openedAt` is the tap's time: the sheet's own opening is measured from it
 * (`sheetTimings`, development builds only).
 */

import { create } from "zustand";
import type { ProductSummaryDto } from "@shared";

interface VariantSheetState {
  product: ProductSummaryDto | null;
  onViewDetails: (() => void) | null;
  openedAt: number;
  open: (product: ProductSummaryDto, onViewDetails: () => void) => void;
  close: () => void;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const useVariantSheet = create<VariantSheetState>((set) => ({
  product: null,
  onViewDetails: null,
  openedAt: 0,
  open: (product, onViewDetails) => set({ product, onViewDetails, openedAt: now() }),
  close: () => set({ product: null, onViewDetails: null }),
}));

/**
 * Development builds only: how long each stage of one opening took after the
 * tap — logged once the slide finishes. Release builds record nothing.
 */
export type SheetStage = "animationStart" | "fullyVisible" | "firstVariant" | "allPrices";

let marks: Partial<Record<SheetStage, number>> = {};
let marksFor = 0;

export function markSheet(stage: SheetStage): void {
  if (!__DEV__) return;
  const { openedAt } = useVariantSheet.getState();
  if (openedAt !== marksFor) {
    marks = {};
    marksFor = openedAt;
  }
  if (marks[stage] !== undefined) return;
  marks[stage] = Math.round(now() - openedAt);
  if (stage === "fullyVisible") {
    console.log(`[variant-sheet] ${JSON.stringify(marks)}`);
  }
}
