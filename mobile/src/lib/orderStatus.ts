/**
 * Order-status badge label and colours, for every status the V2 API sends.
 *
 * Labels are V2's own (`ORDER_STATUS_LABELS` in @shared/order-state-machine).
 * Colours come from `statusColors` in @shared/theme, which has no entry for
 * V2's PROCESSING, PICKED_UP, PARTIALLY_CANCELLED or PARTIALLY_REFUNDED —
 * indexing it with those gives `undefined`, and a V2 COD order is PROCESSING
 * from the moment it is placed — so each V2 status is mapped to a tone here.
 * The map is keyed by the V2 OrderStatus, so a status added to the enum fails
 * to compile until it gets a tone; a status the app does not know at runtime
 * renders with a neutral tone instead of crashing.
 */

import { ORDER_STATUS_LABELS, type OrderStatus } from "@shared";
import { colors, statusColors } from "@shared/theme";

export interface OrderStatusPresentation {
  label: string;
  bg: string;
  fg: string;
}

/** V2 OrderStatus -> badge colours. Statuses V1 also had keep their existing colours. */
const TONE: Record<OrderStatus, { bg: string; fg: string }> = {
  PENDING_PAYMENT: statusColors.PENDING_PAYMENT,
  PAYMENT_CONFIRMED: statusColors.PAYMENT_CONFIRMED,
  PROCESSING: statusColors.PREPARING,
  READY_FOR_PICKUP: statusColors.READY_FOR_PICKUP,
  PICKED_UP: statusColors.OUT_FOR_DELIVERY,
  OUT_FOR_DELIVERY: statusColors.OUT_FOR_DELIVERY,
  DELIVERED: statusColors.DELIVERED,
  PARTIALLY_CANCELLED: { bg: colors.warningSurface, fg: colors.warning },
  CANCELLED: statusColors.CANCELLED,
  PAYMENT_FAILED: statusColors.PAYMENT_FAILED,
  REFUNDED: statusColors.REFUNDED,
  PARTIALLY_REFUNDED: statusColors.REFUNDED,
};

/** "SOME_NEW_STATUS" -> "Some new status". */
function humanize(status: string): string {
  const words = status.toLowerCase().replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Unknown";
}

export function orderStatusPresentation(status: string): OrderStatusPresentation {
  const tone = TONE[status as OrderStatus];
  if (tone) return { label: ORDER_STATUS_LABELS[status as OrderStatus], ...tone };
  return {
    label: humanize(status),
    bg: colors.surfaceSunken,
    fg: colors.textSecondary,
  };
}
