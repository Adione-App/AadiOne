/**
 * Business configuration (Task 13.6).
 *
 * Admin UI displays monetary values in RUPEES.
 * Backend/database continue to store monetary values in PAISE.
 *
 * Example:
 *   Database: 5000 paise
 *   Admin UI: ₹50
 *
 * IMPORTANT:
 * Never rename the actual ConfigKey values such as
 * MIN_ORDER_VALUE_PAISE. Those are backend/database keys.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConfigKey } from "@shared";

import { api } from "@/lib/api";
import { Card, ErrorBanner, Spinner } from "@/components/ui";
import StoreAvailabilityCard from "@/components/StoreAvailabilityCard";
import StoreLocationCard from "@/components/StoreLocationCard";

interface ConfigEntry {
  key: ConfigKey;
  value: unknown;
  description: string;
  isPublic: boolean;
  isOverridden: boolean;
}

/**
 * ---------------------------------------------------------------------------
 * Display labels
 * ---------------------------------------------------------------------------
 *
 * These are ONLY for the Admin UI.
 *
 * The real backend keys remain:
 *
 * MIN_ORDER_VALUE_PAISE
 * PLATFORM_FEE_PAISE
 * COD_MAX_ORDER_VALUE_PAISE
 * etc.
 */
const DISPLAY_LABELS: Partial<Record<ConfigKey, string>> = {
  MAX_SERVICE_RADIUS_KM: "Maximum Service Radius",
  ROAD_DISTANCE_FACTOR: "Road Distance Factor",

  STORE_TIMEZONE: "Store Timezone",
  ALLOW_ORDERS_WHEN_CLOSED: "Allow Orders When Closed",
  STORE_GSTIN: "Store GSTIN",

  MIN_ORDER_VALUE_PAISE: "Minimum Order Value",
  DELIVERY_FEE_SLABS: "Delivery Fee Slabs",
  FREE_DELIVERY_THRESHOLD_PAISE: "Free Delivery Threshold",
  PLATFORM_FEE_PAISE: "Platform Fee",

  DEFAULT_COD_POLICY: "Default COD Policy",
  COD_MAX_ORDER_VALUE_PAISE: "Maximum COD Order Value",
  COD_FIRST_ORDER_MAX_PAISE: "First Order Maximum COD Value",

  BASE_PREPARATION_MINUTES: "Base Preparation Time",
  PER_ITEM_PICK_SECONDS: "Per Item Picking Time",
  AVG_DELIVERY_SPEED_KMPH: "Average Delivery Speed",
  ORDERS_PER_RIDER_BATCH: "Orders Per Rider Batch",
  BATCH_DELAY_MINUTES: "Batch Delay",
  ETA_BUFFER_MINUTES: "ETA Buffer",

  PAYMENT_HOLD_MINUTES: "Payment Hold Time",
  CANCELLATION_ALLOWED_UNTIL: "Cancellation Allowed Until",
  DEFAULT_MAX_QTY_PER_ORDER: "Default Maximum Quantity Per Order",
  MAX_ADDRESSES_PER_USER: "Maximum Addresses Per User",

  LOW_STOCK_THRESHOLD: "Low Stock Threshold",

  DELIVERY_OTP_REQUIRED_FOR_COD: "Delivery OTP Required For COD",

  REFERRAL_REWARD_PAISE: "Referral Reward Amount",
  REFERRAL_MIN_ORDER_PAISE: "Referral Minimum Order Value",
  REFERRAL_COUPON_EXPIRY_DAYS: "Referral Coupon Expiry",

  FEATURE_REFERRAL_ENABLED: "Referral Feature",
  FEATURE_COUPONS_ENABLED: "Coupons Feature",
  FEATURE_RATINGS_ENABLED: "Ratings Feature",
  FEATURE_WISHLIST_ENABLED: "Wishlist Feature",

  SUPPORT_PHONE: "Support Phone",
  SUPPORT_WHATSAPP: "Support WhatsApp",
  SUPPORT_EMAIL: "Support Email",
  DELIVERY_PROMISE_TEXT: "Delivery Promise",
};

/**
 * ---------------------------------------------------------------------------
 * Display descriptions
 * ---------------------------------------------------------------------------
 *
 * These descriptions are written for the Admin user.
 * Monetary values are intentionally described as RUPEES here.
 */
const DISPLAY_DESCRIPTIONS: Partial<Record<ConfigKey, string>> = {
  MIN_ORDER_VALUE_PAISE: "Minimum order value before delivery fees, in rupees.",

  DELIVERY_FEE_SLABS:
    "Delivery fee bands by road distance. Enter fees in rupees.",

  FREE_DELIVERY_THRESHOLD_PAISE:
    "Order value above which delivery is free, in rupees.",

  PLATFORM_FEE_PAISE:
    "Flat platform fee added to every order, in rupees. Set 0 to hide the line.",

  COD_MAX_ORDER_VALUE_PAISE:
    "Maximum order value eligible for Cash on Delivery, in rupees.",

  COD_FIRST_ORDER_MAX_PAISE:
    "Maximum COD value for a customer's first order, in rupees.",

  MAX_SERVICE_RADIUS_KM:
    "Maximum straight-line delivery distance from the store, in km.",

  ROAD_DISTANCE_FACTOR:
    "Multiplier converting straight-line distance to road distance, used for ETA and delivery fee.",

  STORE_TIMEZONE: "Timezone used to evaluate store opening hours.",

  ALLOW_ORDERS_WHEN_CLOSED:
    "Allow customers to place orders outside opening hours.",

  STORE_GSTIN:
    "GST registration number. When set, order receipts show a tax invoice breakdown.",

  DEFAULT_COD_POLICY:
    "COD policy used when no product, category or store rule applies.",

  BASE_PREPARATION_MINUTES:
    "Fixed picking and packing time per order, in minutes.",

  PER_ITEM_PICK_SECONDS: "Additional picking time per item, in seconds.",

  AVG_DELIVERY_SPEED_KMPH: "Average rider speed used for ETA, in km/h.",

  ORDERS_PER_RIDER_BATCH:
    "Active orders a rider handles before ETA is extended.",

  BATCH_DELAY_MINUTES:
    "Minutes added to ETA per additional batch of active orders.",

  ETA_BUFFER_MINUTES: "Safety buffer added to every ETA, in minutes.",

  PAYMENT_HOLD_MINUTES:
    "How long stock stays reserved for an unpaid online order before it is released.",

  CANCELLATION_ALLOWED_UNTIL:
    "Last order status at which a customer may still cancel by themselves.",

  DEFAULT_MAX_QTY_PER_ORDER: "Default maximum quantity of one item per order.",

  MAX_ADDRESSES_PER_USER: "Maximum saved addresses per customer.",

  LOW_STOCK_THRESHOLD:
    "Stock level at or below which an item appears in the low-stock report.",

  DELIVERY_OTP_REQUIRED_FOR_COD:
    "Require a delivery OTP before marking COD orders delivered.",

  REFERRAL_REWARD_PAISE:
    "Coupon value credited to the referrer once their friend completes a qualifying first order, in rupees.",

  REFERRAL_MIN_ORDER_PAISE:
    "Minimum order value (items subtotal) the referred friend's first order must reach, in rupees.",

  REFERRAL_COUPON_EXPIRY_DAYS: "Days after issuance before a referral reward coupon expires.",

  FEATURE_REFERRAL_ENABLED:
    "Show the Refer & Earn rewards programme in the app.",

  FEATURE_COUPONS_ENABLED: "Allow coupon codes at checkout.",

  FEATURE_RATINGS_ENABLED: "Show product ratings and reviews.",

  FEATURE_WISHLIST_ENABLED: "Show the wishlist / favourites feature.",

  SUPPORT_PHONE: "Phone number shown on Help & Support.",

  SUPPORT_WHATSAPP: "WhatsApp number shown on Help & Support.",

  SUPPORT_EMAIL: "Support email address.",

  DELIVERY_PROMISE_TEXT:
    "Marketing copy for delivery speed. Per-order ETA is computed separately.",
};

/**
 * ---------------------------------------------------------------------------
 * Money configuration keys
 * ---------------------------------------------------------------------------
 *
 * These keys are stored in PAISE in the backend/database.
 * Admin sees RUPEES.
 */
const MONEY_KEYS = new Set<string>([
  "MIN_ORDER_VALUE_PAISE",
  "FREE_DELIVERY_THRESHOLD_PAISE",
  "PLATFORM_FEE_PAISE",
  "COD_MAX_ORDER_VALUE_PAISE",
  "COD_FIRST_ORDER_MAX_PAISE",
  "REFERRAL_REWARD_PAISE",
  "REFERRAL_MIN_ORDER_PAISE",
]);

/**
 * ---------------------------------------------------------------------------
 * Delivery fee slab helper
 * ---------------------------------------------------------------------------
 *
 * Backend:
 *
 * [
 *   { maxKm: 3, feePaise: 5000 }
 * ]
 *
 * Admin:
 *
 * [
 *   { maxKm: 3, feeRupees: 50 }
 * ]
 *
 * The API still receives feePaise.
 */
function paiseToRupees(value: number): number {
  return value / 100;
}

function rupeesToPaise(value: number): number {
  return Math.round(value * 100);
}

/**
 * Convert backend delivery slabs into Admin-friendly slabs.
 */
function slabsToRupees(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  return value.map((slab) => {
    if (
      typeof slab === "object" &&
      slab !== null &&
      "maxKm" in slab &&
      "feePaise" in slab
    ) {
      const item = slab as {
        maxKm: number;
        feePaise: number;
      };

      return {
        maxKm: item.maxKm,
        feeRupees: paiseToRupees(item.feePaise),
      };
    }

    return slab;
  });
}

/**
 * Convert Admin delivery slabs back to backend format.
 */
function slabsToPaise(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  return value.map((slab) => {
    if (typeof slab === "object" && slab !== null && "maxKm" in slab) {
      const item = slab as Record<string, unknown>;

      if ("feeRupees" in item) {
        return {
          maxKm: Number(item.maxKm),
          feePaise: rupeesToPaise(Number(item.feeRupees)),
        };
      }

      if ("feePaise" in item) {
        return {
          maxKm: Number(item.maxKm),
          feePaise: Number(item.feePaise),
        };
      }
    }

    return slab;
  });
}

/**
 * Format a normal monetary backend value for Admin UI.
 */
function formatMoneyValue(value: unknown): string {
  if (typeof value !== "number") {
    return String(value ?? "");
  }

  return String(paiseToRupees(value));
}

/**
 * Convert a money value entered by Admin from RUPEES to PAISE.
 */
function parseMoneyValue(raw: string): number {
  const rupees = Number(raw);

  if (!Number.isFinite(rupees)) {
    return NaN;
  }

  return rupeesToPaise(rupees);
}

/**
 * ---------------------------------------------------------------------------
 * Configuration groups
 * ---------------------------------------------------------------------------
 *
 * IMPORTANT:
 *
 * Pricing group explicitly excludes COD keys.
 * Otherwise COD_MAX_ORDER_VALUE_PAISE and
 * COD_FIRST_ORDER_MAX_PAISE appear twice.
 */
const GROUPS: {
  title: string;
  match: (key: string) => boolean;
}[] = [
  {
    title: "Delivery area",
    match: (k) => k.includes("RADIUS") || k.includes("ROAD_DISTANCE"),
  },

  {
    title: "Pricing & fees",
    match: (k) =>
      (k.includes("PAISE") || k === "DELIVERY_FEE_SLABS") &&
      !k.startsWith("COD_") &&
      !k.startsWith("REFERRAL_"),
  },

  {
    title: "Cash on Delivery",
    match: (k) => k.startsWith("COD_") || k === "DEFAULT_COD_POLICY",
  },

  {
    title: "Refer & Earn",
    match: (k) => k.startsWith("REFERRAL_"),
  },

  {
    title: "Delivery time",
    match: (k) =>
      k.includes("MINUTES") ||
      k.includes("SPEED") ||
      k.includes("SECONDS") ||
      k.includes("BATCH"),
  },

  {
    title: "Store",
    match: (k) => k.startsWith("STORE") || k.includes("ORDERS_WHEN_CLOSED"),
  },

  {
    title: "Features",
    match: (k) => k.startsWith("FEATURE_"),
  },

  {
    title: "Support",
    match: (k) => k.startsWith("SUPPORT") || k.includes("PROMISE"),
  },
];

/**
 * Get the human-readable title.
 */
function getDisplayLabel(entry: ConfigEntry): string {
  return DISPLAY_LABELS[entry.key] ?? entry.key;
}

/**
 * Get the Admin-friendly description.
 */
function getDisplayDescription(entry: ConfigEntry): string {
  return DISPLAY_DESCRIPTIONS[entry.key] ?? entry.description;
}

/**
 * Check whether a configuration value is money.
 */
function isMoneyKey(key: string): boolean {
  return MONEY_KEYS.has(key);
}

/**
 * Check whether configuration value is delivery slabs.
 */
function isDeliveryFeeSlabs(key: string): boolean {
  return key === "DELIVERY_FEE_SLABS";
}

export default function ConfigPage() {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<ConfigEntry[]>("/admin/config"),
  });

  const save = useMutation({
    mutationFn: (input: { key: ConfigKey; value: unknown }) =>
      api.patch("/admin/config", input),

    onSuccess: (_result, input) => {
      setError(null);
      setSaved(input.key);

      window.setTimeout(() => {
        setSaved(null);
      }, 2000);

      void queryClient.invalidateQueries({
        queryKey: ["config"],
      });
    },

    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (config.isLoading || !config.data) {
    return <Spinner label="Loading settings…" />;
  }

  const entries = config.data;

  /**
   * Group configuration entries.
   */
  const grouped = GROUPS.map((group) => ({
    title: group.title,
    items: entries.filter((entry) => group.match(entry.key)),
  })).filter((group) => group.items.length > 0);

  /**
   * Put any ungrouped configuration into Other.
   */
  const covered = new Set(
    grouped.flatMap((group) => group.items.map((item) => item.key)),
  );

  const other = entries.filter((entry) => !covered.has(entry.key));

  if (other.length > 0) {
    grouped.push({
      title: "Other",
      items: other,
    });
  }

  /**
   * -------------------------------------------------------------------------
   * Commit configuration
   * -------------------------------------------------------------------------
   */
  function commit(entry: ConfigEntry, raw: string): void {
    let value: unknown = raw;

    /**
     * Boolean
     */
    if (typeof entry.value === "boolean") {
      value = raw === "true";
    } else if (isMoneyKey(entry.key)) {

    /**
     * Money
     *
     * Admin enters RUPEES.
     *
     * Example:
     *
     * Admin: 50
     *
     * API:
     * 5000
     */
      value = parseMoneyValue(raw);

      if (!Number.isFinite(value)) {
        setError(`${getDisplayLabel(entry)} must be a valid amount.`);
        return;
      }
    } else if (isDeliveryFeeSlabs(entry.key)) {

    /**
     * Delivery fee slabs
     *
     * Admin uses:
     *
     * [
     *   {"maxKm":3,"feeRupees":50},
     *   {"maxKm":7,"feeRupees":50}
     * ]
     *
     * Backend receives:
     *
     * [
     *   {"maxKm":3,"feePaise":5000},
     *   {"maxKm":7,"feePaise":5000}
     * ]
     */
      try {
        const parsed = JSON.parse(raw);

        if (!Array.isArray(parsed)) {
          setError(`${getDisplayLabel(entry)} must be a JSON array.`);
          return;
        }

        value = slabsToPaise(parsed);
      } catch {
        setError(`${getDisplayLabel(entry)} must be valid JSON.`);
        return;
      }
    } else if (typeof entry.value === "number") {

    /**
     * Normal numbers
     */
      value = Number(raw);

      if (!Number.isFinite(value)) {
        setError(`${getDisplayLabel(entry)} must be a valid number.`);
        return;
      }
    } else if (typeof entry.value === "object" && entry.value !== null) {

    /**
     * Other JSON values
     */
      try {
        value = JSON.parse(raw);
      } catch {
        setError(`${getDisplayLabel(entry)} must be valid JSON.`);
        return;
      }
    }

    /**
     * Do not send unchanged values.
     */
    if (JSON.stringify(value) === JSON.stringify(entry.value)) {
      return;
    }

    save.mutate({
      key: entry.key,
      value,
    });
  }

  /**
   * -------------------------------------------------------------------------
   * Render
   * -------------------------------------------------------------------------
   */
  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />

      {/* Store availability */}
      <StoreAvailabilityCard />

      {/* Store location */}
      <StoreLocationCard />

      {grouped.map((group) => (
        <Card key={group.title}>
          <h2 className="mb-3 font-semibold">{group.title}</h2>

          <div className="divide-y divide-gray-100">
            {group.items.map((entry) => {
              const money = isMoneyKey(entry.key);
              const slabs = isDeliveryFeeSlabs(entry.key);

              return (
                <div
                  key={entry.key}
                  className="grid gap-2 py-3 md:grid-cols-2 md:items-center"
                >
                  {/* -------------------------------------------------------
                      Label / Description
                  ------------------------------------------------------- */}
                  <div>
                    <p className="font-medium text-gray-800">
                      {getDisplayLabel(entry)}
                    </p>

                    <p className="text-sm text-gray-600">
                      {getDisplayDescription(entry)}
                    </p>
                  </div>

                  {/* -------------------------------------------------------
                      Input
                  ------------------------------------------------------- */}
                  <div className="flex items-center gap-2">
                    {typeof entry.value === "boolean" ? (
                      <select
                        defaultValue={String(entry.value)}
                        onChange={(event) => commit(entry, event.target.value)}
                        className="min-h-11 w-full rounded-lg border border-gray-300 px-3 text-sm"
                      >
                        <option value="true">Enabled</option>

                        <option value="false">Disabled</option>
                      </select>
                    ) : slabs ? (
                      <div className="w-full">
                        <textarea
                          defaultValue={JSON.stringify(
                            slabsToRupees(entry.value),
                          )}
                          onBlur={(event) => commit(entry, event.target.value)}
                          rows={3}
                          className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
                          placeholder='[{"maxKm":3,"feeRupees":50}]'
                        />

                        <p className="mt-1 text-xs text-gray-500">
                          Enter delivery fees in ₹. Example:{" "}
                          <span className="font-mono">
                            {'[{"maxKm":3,"feeRupees":50}]'}
                          </span>
                        </p>
                      </div>
                    ) : money ? (
                      <div className="relative w-full">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-semibold text-gray-700">
                          ₹
                        </span>

                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          defaultValue={formatMoneyValue(entry.value)}
                          onBlur={(event) => commit(entry, event.target.value)}
                          className="min-h-11 w-full rounded-lg border border-gray-300 py-2 pl-8 pr-3 text-sm"
                        />
                      </div>
                    ) : (
                      <input
                        defaultValue={
                          typeof entry.value === "object"
                            ? JSON.stringify(entry.value)
                            : String(entry.value ?? "")
                        }
                        onBlur={(event) => commit(entry, event.target.value)}
                        className="min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm"
                      />
                    )}

                    {saved === entry.key && (
                      <span className="whitespace-nowrap text-xs font-semibold text-brand-600">
                        Saved
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}

      {/* -------------------------------------------------------------------
          Money storage explanation
      ------------------------------------------------------------------- */}
      <p className="text-xs text-gray-500">
        Money is entered in rupees (₹) here. The backend automatically stores
        monetary values in paise (₹1 = 100 paise). Changes take effect within a
        minute.
      </p>
    </div>
  );
}
