/**
 * Refunds on the order screen — the pure parts, unit-tested
 * (tests/refunds.test.ts). What a refund IS (its amount, its status) is
 * always the server's answer (GET /orders/:id/refunds); this only decides how
 * it looks and what the request form may send.
 */

import type { CustomerRefundStatus, OrderRefundsDto } from "@shared";
import { colors } from "@shared/theme";

/**
 * Customer refunds on the order screen — TEMPORARILY SWITCHED OFF: no
 * Refunds card, no "Request a refund", no request form (the order screen
 * shows the support contacts instead). The server refuses requests too
 * (backend refunds/refund-requests-availability.ts). Everything below is kept
 * for when this is switched back on.
 */
export const CUSTOMER_REFUNDS_ENABLED: boolean = false;

export type RefundTone = { fg: string; bg: string };

/** Green for done, amber while it moves, red only for "not approved". */
export function refundTone(status: CustomerRefundStatus): RefundTone {
  switch (status) {
    case "SUCCESS":
      return { fg: colors.primaryDark, bg: colors.primarySurface };
    case "REJECTED":
      return { fg: colors.danger, bg: colors.dangerSurface };
    case "PARTIAL_FAILURE":
    case "FAILED":
    case "UNDER_REVIEW":
    case "APPROVED":
    case "PROCESSING":
    default:
      return { fg: colors.warning, bg: colors.warningSurface };
  }
}

/** Show the refunds card at all? Only when there is a refund, or a request can (or could) be made. */
export function showRefundsCard(data: OrderRefundsDto | undefined): boolean {
  if (!data) return false;
  return data.refunds.length > 0 || data.request.eligible || data.request.reason !== null;
}

export const REFUND_CATEGORIES = [
  { value: "MISSING_ITEM", label: "Missing item" },
  { value: "DAMAGED_ITEM", label: "Damaged item" },
  { value: "WRONG_ITEM", label: "Wrong item" },
  { value: "QUALITY_ISSUE", label: "Quality issue" },
  { value: "DELIVERY_DISPUTE", label: "Delivery issue" },
  { value: "OTHER", label: "Other" },
] as const;

export type RefundCategoryValue = (typeof REFUND_CATEGORIES)[number]["value"];

export const MAX_REFUND_PHOTOS = 4;
export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 1000;

export interface RefundFormState {
  category: RefundCategoryValue | null;
  description: string;
  /** orderItemId -> chosen quantity (0 = not chosen). */
  quantities: Record<string, number>;
  photoCount: number;
}

/** What is missing before the form can be sent, or null when it is ready. Never an amount. */
export function refundFormProblem(form: RefundFormState, photoRequired: readonly string[]): string | null {
  if (!form.category) return "Choose what went wrong.";
  if (!Object.values(form.quantities).some((qty) => qty > 0)) return "Choose at least one item.";
  if (form.description.trim().length < MIN_DESCRIPTION_LENGTH) return "Tell us a little more about the problem.";
  if (photoRequired.includes(form.category) && form.photoCount === 0) return "Add at least one photo of the item.";
  return null;
}

/** The items the request sends — chosen quantities only, never prices. */
export function refundFormItems(form: RefundFormState): { orderItemId: string; qty: number }[] {
  return Object.entries(form.quantities)
    .filter(([, qty]) => qty > 0)
    .map(([orderItemId, qty]) => ({ orderItemId, qty }));
}
