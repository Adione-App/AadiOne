/**
 * Generic "not built yet" placeholder — tells the customer plainly instead
 * of leaving a menu item pointing nowhere or dead. Shared by every
 * not-yet-built feature (Food tab, Wishlist, Refer & Earn, …) so they all
 * read as the same deliberate, polished state rather than each screen
 * inventing its own.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@shared/theme';
import { AppText, Screen } from '@/components/ui';

export default function ComingSoonScreen({
  icon,
  message,
  onBack,
}: {
  icon: ReactNode;
  message: string;
  /** Omitted for a tab root (e.g. Food) that has no "back" — present for a
   * screen pushed from a menu (e.g. Wishlist, Refer & Earn). */
  onBack?: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Screen style={{ paddingTop: insets.top }}>
      {onBack && (
        <View style={styles.header}>
          <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
            <AppText variant="h2">←</AppText>
          </Pressable>
        </View>
      )}

      <View style={styles.body}>
        <View style={styles.iconCircle}>{icon}</View>

        <AppText variant="h1" style={styles.title}>
          Coming Soon
        </AppText>

        <AppText variant="body" color={colors.textSecondary} style={styles.subtitle}>
          {message}
        </AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
  },
  back: { width: 40, height: 40, justifyContent: 'center' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  iconCircle: {
    width: 128,
    height: 128,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 22,
  },
});
