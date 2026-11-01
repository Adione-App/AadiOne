/**
 * First launch: why Aadione wants the location, shown ONCE, right before the
 * system's own permission dialog ("While using the app" — never background).
 *
 * Its one button continues to the system dialog, where the customer decides;
 * the dialog itself is never repeated by the app (a denial is answered with
 * an explanation and Settings — DeliveryStatusNotice). Browsing works either
 * way. Android's back button closes it without asking.
 */

import { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "@shared/theme";
import { AppText, Button } from "@/components/ui";
import { markLocationIntroShown, refreshCurrentLocation, shouldShowLocationIntro } from "@/lib/locationService";

export function LocationPermissionIntro({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void shouldShowLocationIntro().then((show) => {
      if (!cancelled && show) setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!visible) return null;

  function close(): void {
    setVisible(false);
    void markLocationIntroShown();
  }

  function proceed(): void {
    close();
    void refreshCurrentLocation("user", { prompt: true });
  }

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.icon}>
            <Ionicons name="location" size={26} color={colors.primary} />
          </View>
          <View accessibilityRole="header">
            <AppText variant="h3" style={styles.center}>
              Check delivery where you are
            </AppText>
          </View>
          <AppText variant="body" color={colors.textSecondary} style={styles.center}>
            Aadione uses your phone's location while you use the app to check whether we deliver to you, find stores near
            you and fill in your delivery address.
          </AppText>
          <AppText variant="caption" color={colors.textSecondary} style={styles.center}>
            Your location is never tracked in the background. You can also choose a saved address instead.
          </AppText>
          <View style={styles.actions}>
            <Button label="Continue" onPress={proceed} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
    backgroundColor: "rgba(15, 23, 20, 0.5)",
  },
  card: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  icon: {
    alignSelf: "center",
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryLight,
    marginBottom: spacing.xs,
  },
  center: {
    textAlign: "center",
  },
  actions: {
    marginTop: spacing.sm,
  },
});
