/**
 * Optional update — one calm prompt over the app, never a loop of dialogs:
 *   - "Later" hides it for this release for a few days (appUpdate.ts);
 *     a newer release, or a change of policy, asks again;
 *   - "Update Now" opens the official store listing and hides the prompt for
 *     the rest of this session. Whether the update actually happened is
 *     decided by the next check of the installed version, not by this tap.
 * Android's back button counts as "Later".
 */

import { useState } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "@shared/theme";
import { AppText, Button } from "@/components/ui";
import { selectOptionalPrompt, useAppUpdate } from "@/lib/appUpdate";
import { installedApp, openStoreListing } from "@/lib/appVersion";

export function AppUpdatePrompt() {
  const update = useAppUpdate((state) => selectOptionalPrompt(state));
  const dismissOptional = useAppUpdate((state) => state.dismissOptional);
  // "Update Now" this session — not persisted: if the customer came back
  // without updating, the next launch may ask again.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const [storeFailed, setStoreFailed] = useState(false);

  if (!update || hiddenFor === update.promptKey) return null;

  async function updateNow(): Promise<void> {
    if (!update) return;
    const opened = await openStoreListing(update.platform, update.storeUrl);
    if (opened) setHiddenFor(update.promptKey);
    else setStoreFailed(true);
  }

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={dismissOptional}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.icon}>
            <Ionicons name="sparkles" size={26} color={colors.primary} />
          </View>
          <View accessibilityRole="header">
            <AppText variant="h3" style={styles.center}>
              {update.title}
            </AppText>
          </View>
          <AppText variant="body" color={colors.textSecondary} style={styles.center}>
            {update.message}
          </AppText>

          <AppText variant="caption" color={colors.textSecondary} style={styles.center}>
            Installed {installedApp.version ?? "—"} · Latest{" "}
            <AppText variant="caption" color={colors.primaryDark} style={styles.bold}>
              {update.latestVersion ?? "—"}
            </AppText>
          </AppText>

          {update.releaseNotes ? (
            <ScrollView style={styles.notes} contentContainerStyle={styles.notesContent}>
              <AppText variant="bodyStrong">What's new</AppText>
              <AppText variant="body" color={colors.textSecondary}>
                {update.releaseNotes}
              </AppText>
            </ScrollView>
          ) : null}

          {storeFailed ? (
            <AppText variant="caption" color={colors.danger} style={styles.center}>
              We couldn't open the store. Please update Aadione from the {update.platform === "ios" ? "App Store" : "Play Store"}.
            </AppText>
          ) : null}

          <View style={styles.actions}>
            <Button label="Update Now" onPress={() => void updateNow()} />
            <Button label="Later" variant="ghost" onPress={dismissOptional} />
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
  bold: {
    fontWeight: "700",
  },
  notes: {
    maxHeight: 160,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
  },
  notesContent: {
    padding: spacing.md,
    gap: spacing.xs,
  },
  actions: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
});
