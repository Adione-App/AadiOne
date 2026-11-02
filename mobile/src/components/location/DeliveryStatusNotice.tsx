/**
 * The delivery status of the chosen location (lib/deliveryArea.ts
 * deliveryView) with its way forward — refresh the location, turn GPS on,
 * choose a saved address, or check again. Shown on Home and Cart; renders
 * nothing while delivery is available, and never for the location
 * permission (Android's own dialog is the only ask).
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "@shared/theme";
import { AppText, Button } from "@/components/ui";
import type { DeliveryAction, DeliveryView } from "@/lib/deliveryArea";
import { enableLocationServices } from "@/lib/deviceLocation";
import { refreshCurrentLocation } from "@/lib/locationService";
import { useLocation } from "@/lib/store";

const ACTION_LABEL: Record<DeliveryAction, string> = {
  REFRESH: "Refresh location",
  ENABLE_GPS: "Turn on location",
  CHOOSE_ADDRESS: "Choose saved address",
  RETRY_CHECK: "Try again",
};

/** States with a message to show (the rest — available, locating, checking, nothing chosen — show none). */
const SHOWN = new Set<DeliveryView["state"]>([
  "OUTSIDE_RADIUS",
  "OUTSIDE_SERVICE_STATE",
  "NO_ELIGIBLE_STORE",
  "STORE_CLOSED",
  "STORE_NOT_ACCEPTING",
  "ORDERING_DISABLED",
  "GPS_FAILED",
  "CHECK_FAILED",
]);

/** True when the notice has something to say (so a screen can skip its wrapper). */
export function deliveryNoticeShown(view: DeliveryView): boolean {
  return SHOWN.has(view.state) && !!view.message;
}

export function DeliveryStatusNotice({
  view,
  onChooseAddress,
  hideActions = [],
}: {
  view: DeliveryView;
  onChooseAddress: () => void;
  /** Actions the screen already offers elsewhere. */
  hideActions?: DeliveryAction[];
}) {
  const [busy, setBusy] = useState<DeliveryAction | null>(null);
  if (!deliveryNoticeShown(view)) return null;

  const severe = view.state !== "STORE_CLOSED" && view.state !== "STORE_NOT_ACCEPTING" && view.state !== "ORDERING_DISABLED";

  async function act(action: DeliveryAction): Promise<void> {
    if (action === "CHOOSE_ADDRESS") return onChooseAddress();
    setBusy(action);
    try {
      if (action === "RETRY_CHECK") await useLocation.getState().refresh();
      else if (action === "ENABLE_GPS") {
        if (await enableLocationServices()) await refreshCurrentLocation("user");
      } else await refreshCurrentLocation("user");
    } finally {
      setBusy(null);
    }
  }

  const actions = view.actions.filter((action) => !hideActions.includes(action));

  return (
    <View
      style={[styles.card, { backgroundColor: severe ? colors.dangerSurface : colors.warningSurface }]}
      accessibilityRole="alert"
    >
      <View style={styles.titleRow}>
        <Ionicons
          name={view.state === "GPS_FAILED" ? "navigate-circle-outline" : severe ? "alert-circle-outline" : "time-outline"}
          size={18}
          color={severe ? colors.danger : colors.warning}
        />
        <AppText variant="bodyStrong" color={severe ? colors.danger : colors.warning} style={styles.title}>
          {view.title}
        </AppText>
      </View>
      <AppText variant="body" color={colors.textPrimary}>
        {view.message}
      </AppText>
      {actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((action, index) => (
            <Button
              key={action}
              label={ACTION_LABEL[action]}
              variant={index === 0 ? "primary" : "secondary"}
              loading={busy === action}
              disabled={busy !== null && busy !== action}
              onPress={() => void act(action)}
              style={styles.action}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  title: {
    flex: 1,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  action: {
    flexGrow: 1,
    minWidth: 140,
  },
});
