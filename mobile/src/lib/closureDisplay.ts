/**
 * App-wide ordering vs one seller's own availability, as the customer app
 * SHOWS them — pure, so it is unit-tested (tests/closureDisplay.test.ts).
 * The server decides both (GET /availability and CartDto.orderingEnabled for
 * the app; each product's / cart line's / restaurant's own flags for a
 * seller); this only decides which of the two the customer is told about.
 *
 *   App-wide ordering closed / paused: the app-wide notice only. Nothing
 *     names a seller, says when it opens or that it is closed — a closed
 *     seller's products read a neutral "Unavailable", its cart lines carry no
 *     store warning, the CLOSED / "Opens at …" / "Open now" labels are hidden.
 *   App-wide ordering open: each seller on its own — a closed one's products
 *     cannot be added; a line of it already in the cart reads ONLY "SELLER
 *     CLOSED — UNAVAILABLE RIGHT NOW" (no seller name, no opening time, no
 *     sentence) and keeps − and Remove (+ is disabled); every other seller
 *     works normally.
 *
 * Only what is shown changes. What can be added, changed or ordered is the
 * same in both states, and the server enforces both layers either way.
 */

import type { CartDto, CartItemDto } from "@shared";
import type { DeliveryState } from "./deliveryArea";
import { DEFAULT_CLOSED_MESSAGE } from "./platformAvailability";
import { isCheckingLine, isOrderableLine, unavailableLabel } from "./cartAvailability";

export interface GlobalOrdering {
  closed: boolean;
  /** The app-wide notice while closed; null while open. */
  message: string | null;
}

/**
 * App-wide ordering as one answer. `globalNotice` is /availability's
 * (lib/platformAvailability.ts `globalClosedNotice`); the cart, where there is
 * one, carries the same rule's answer from its own read. Either saying closed
 * is closed, so the Cart never looks open while one of them says it is not.
 */
export function resolveGlobalOrdering(
  globalNotice: string | null,
  cart?: Pick<CartDto, "orderingEnabled" | "orderingPausedMessage"> | null,
): GlobalOrdering {
  if (cart?.orderingEnabled === false) {
    return { closed: true, message: cart.orderingPausedMessage?.trim() || globalNotice || DEFAULT_CLOSED_MESSAGE };
  }
  if (globalNotice !== null) return { closed: true, message: globalNotice };
  return { closed: false, message: null };
}

/** A seller's own status (CLOSED, "Opens at …", "Open now") is shown only while the app takes orders. */
export function sellerStatusShown(globalClosed: boolean): boolean {
  return !globalClosed;
}

/* -------------------------------------------------------------------------- */
/* Cart lines                                                                 */
/* -------------------------------------------------------------------------- */

export interface CartLineDisplay {
  /** Quantity can be changed (stepper); false: "Qty N" and Remove only. */
  stepper: boolean;
  /** The stepper's + adds more (false: dimmed, refused on the device — the server refuses it too). */
  increase: boolean;
  /** Image and name faded. */
  faded: boolean;
  /** The whole row greyed (a line that is unavailable, not one being checked). */
  greyed: boolean;
  /** The label under the price; null for none. */
  label: string | null;
  labelTone: "danger" | "muted";
  /** The server's sentence under the label (product reasons only); null for none. */
  detail: string | null;
}

/**
 * One cart line.
 *
 *   App closed, the line's seller closed: reads like any other line — no
 *     SELLER CLOSED, no seller name, no opening time (the app-wide notice
 *     explains it); "Qty N" and Remove, nothing can be added.
 *   App open, the line's seller closed: only SELLER CLOSED — UNAVAILABLE
 *     RIGHT NOW. Never the seller's name, its opening time or the server's
 *     sentence (which names the seller). − and Remove work; + is disabled
 *     (the server refuses more from a closed seller too).
 *   Product reasons (sold out, off sale) name no seller: shown in both
 *     states, "Qty N" and Remove.
 */
export function cartLineDisplay(
  item: Pick<CartItemDto, "available" | "unavailableReason" | "unavailableMessage">,
  globalClosed: boolean,
): CartLineDisplay {
  if (isOrderableLine(item)) {
    return { stepper: true, increase: true, faded: false, greyed: false, label: null, labelTone: "danger", detail: null };
  }
  if (isCheckingLine(item)) {
    return { stepper: false, increase: false, faded: true, greyed: false, label: unavailableLabel(item), labelTone: "muted", detail: null };
  }
  if (item.unavailableReason === "STORE_CLOSED") {
    if (globalClosed) {
      return { stepper: false, increase: false, faded: false, greyed: false, label: null, labelTone: "muted", detail: null };
    }
    return { stepper: true, increase: false, faded: true, greyed: true, label: unavailableLabel(item), labelTone: "danger", detail: null };
  }
  return {
    stepper: false,
    increase: false,
    faded: true,
    greyed: true,
    label: unavailableLabel(item),
    labelTone: "danger",
    detail: item.unavailableMessage ?? null,
  };
}

/** The row's screen-reader label: the same text the row shows, nothing more. */
export function cartLineAccessibilityLabel(productName: string, line: CartLineDisplay): string | undefined {
  if (!line.greyed || !line.label) return undefined;
  return [`${productName}, ${line.label.toLowerCase()}.`, line.detail].filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A product card with nothing that can be added: "Store closed" (red) while
 * the app is open; while it is closed, a neutral "Unavailable" — never which
 * store, nor that a store is the reason. `sellerMessage` is the server's
 * sentence for the screen reader (it may name the store: only while open).
 */
export function notAddableLabel(
  storeClosed: boolean,
  globalClosed: boolean,
  sellerMessage: string | null | undefined,
): { text: string; accessibilityLabel: string; tone: "danger" | "muted" } {
  if (!storeClosed) return { text: "Sold Out", accessibilityLabel: "Sold out", tone: "muted" };
  if (globalClosed) return { text: "Unavailable", accessibilityLabel: "Unavailable right now", tone: "muted" };
  return { text: "Store closed", accessibilityLabel: sellerMessage ?? "Store closed", tone: "danger" };
}

/**
 * `cardVariant.ts storeClosedHint` as shown: while the app is closed a closed
 * store's product still reads "Unavailable right now", without when the
 * store opens ("" = no hint). Null stays null (the store is not the reason).
 */
export function shownStoreClosedHint(hint: string | null, globalClosed: boolean): string | null {
  if (hint === null) return null;
  return globalClosed ? "" : hint;
}

/* -------------------------------------------------------------------------- */
/* Notices                                                                    */
/* -------------------------------------------------------------------------- */

/** Delivery states about sellers being closed — covered by the app-wide notice while the app is closed. */
const CLOSED_DELIVERY_STATES = new Set<DeliveryState>(["ORDERING_DISABLED", "STORE_CLOSED", "STORE_NOT_ACCEPTING"]);

/** Home's delivery notice for this state is replaced by the app-wide notice. */
export function deliveryNoticeCoveredByGlobal(state: DeliveryState, globalClosed: boolean): boolean {
  return globalClosed && CLOSED_DELIVERY_STATES.has(state);
}

/**
 * The popup for a refused add because the store closed (SELLER_CLOSED): the
 * server's sentence names the store and when it opens, so while the app is
 * closed the app-wide notice is shown instead.
 */
export function sellerClosedRefusalMessage(serverMessage: string, globalNotice: string | null): string {
  return globalNotice ?? serverMessage;
}
