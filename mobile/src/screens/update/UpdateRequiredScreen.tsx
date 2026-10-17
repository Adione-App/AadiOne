/**
 * Update required — shown INSTEAD of the whole app (App.tsx renders it in
 * place of every navigator), so there is no screen behind it to go back to,
 * no tab bar and no deep link that leads around it. Android's back button
 * simply leaves the app; reopening it checks again.
 *
 * "Update Now" opens this app's official store listing. Nothing here assumes
 * the update happened: the app re-checks its INSTALLED version whenever it
 * returns to the foreground (and on "Check again"), and this screen goes away
 * only when the server says that installed version is supported.
 */

import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { AppUpdateCheckDto } from "@shared";
import { colors, radius, spacing } from "@shared/theme";
import BrandMark from "@/components/BrandMark";
import { AppText, Button, NoticeStrip } from "@/components/ui";
import { useAppUpdate } from "@/lib/appUpdate";
import { installedApp, openStoreListing } from "@/lib/appVersion";

const STORE_NAME = { android: "Google Play Store", ios: "App Store" } as const;

export default function UpdateRequiredScreen({ update }: { update: AppUpdateCheckDto | null }) {
  const insets = useSafeAreaInsets();
  const refresh = useAppUpdate((state) => state.refresh);
  const checking = useAppUpdate((state) => state.checking);
  const [notice, setNotice] = useState<string | null>(null);
  const platform = update?.platform ?? installedApp.platform ?? "android";
  // The version to install: the latest release (else the minimum supported one).
  const required = update?.latestVersion ?? update?.minimumVersion ?? null;

  async function updateNow(): Promise<void> {
    setNotice(null);
    const opened = await openStoreListing(platform, update?.storeUrl);
    if (!opened) {
      setNotice(`We couldn't open the ${STORE_NAME[platform]}. Please open it and update Aadione from there.`);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} bounces={false}>
        <View style={styles.hero}>
          <BrandMark size={84} />
          <View style={styles.badge}>
            <Ionicons name="arrow-up-circle" size={18} color={colors.onPrimary} />
            <AppText variant="caption" color={colors.onPrimary} style={styles.badgeText}>
              Update required
            </AppText>
          </View>
        </View>

        <View accessibilityRole="header">
          <AppText variant="h2" style={styles.title}>
            {update?.title ?? "Update required"}
          </AppText>
        </View>
        <AppText variant="body" color={colors.textSecondary} style={styles.message}>
          {update?.message ??
            "This version of Aadione is no longer supported. Please update to the latest version to continue."}
        </AppText>

        <View style={styles.versions} accessible accessibilityLabel={`Installed version ${installedApp.version ?? "unknown"}${required ? `, latest version ${required}` : ""}`}>
          <View style={styles.versionCell}>
            <AppText variant="caption" color={colors.textSecondary}>
              Installed
            </AppText>
            <AppText variant="bodyStrong">{installedApp.version ?? "—"}</AppText>
          </View>
          <View style={styles.versionDivider} />
          <View style={styles.versionCell}>
            <AppText variant="caption" color={colors.textSecondary}>
              Latest
            </AppText>
            <AppText variant="bodyStrong" color={colors.primaryDark}>
              {required ?? "—"}
            </AppText>
          </View>
        </View>

        {update?.releaseNotes ? (
          <View style={styles.notes}>
            <AppText variant="bodyStrong">What's new</AppText>
            <AppText variant="body" color={colors.textSecondary}>
              {update.releaseNotes}
            </AppText>
          </View>
        ) : null}

        {notice ? <NoticeStrip message={notice} /> : null}
      </ScrollView>

      <View style={styles.actions}>
        <Button label="Update Now" onPress={() => void updateNow()} />
        <Button
          label={checking ? "Checking…" : "I've updated — check again"}
          variant="ghost"
          onPress={() => void refresh({ force: true })}
          disabled={checking}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    gap: spacing.base,
  },
  hero: {
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  badgeText: {
    fontWeight: "700",
  },
  title: {
    textAlign: "center",
  },
  message: {
    textAlign: "center",
  },
  versions: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.primarySurface,
    paddingVertical: spacing.md,
  },
  versionCell: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  versionDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: colors.border,
  },
  notes: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted,
  },
  actions: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.base,
    gap: spacing.xs,
  },
});
