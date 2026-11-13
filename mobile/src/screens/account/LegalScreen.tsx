/**
 * Privacy Policy and Terms & Conditions.
 *
 * Fetched from the server rather than bundled into the app: legal text and
 * the business / grievance contact details it shows (Admin Configuration)
 * must be correctable without a store release, and the same published page
 * is what the website and the public HTML link show — same text, same "Last
 * updated" date and version. Works for guests and signed-in customers alike.
 * The header (and its back button) stays on screen while the page loads or
 * if it fails; pull down to refresh.
 */

import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { INFO_PAGE_TITLES } from '@shared';
import { colors, spacing } from '@shared/theme';
import { useInfoPage } from '@/lib/infoPages';
import type { CustomerLegalSlug } from '@/navigation/types';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, ErrorState, Screen } from '@/components/ui';
import { InfoPageHeading, InfoPageSections, InfoPageSkeleton } from '@/components/InfoPageView';

export default function LegalScreen({
  slug,
  onBack,
}: {
  slug: CustomerLegalSlug;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const page = useInfoPage(slug);
  const title = page.data?.title || INFO_PAGE_TITLES[slug];

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3" numberOfLines={1} style={styles.headerTitle}>
          {INFO_PAGE_TITLES[slug]}
        </AppText>
      </View>

      {page.isLoading ? (
        <View style={styles.content}>
          <InfoPageSkeleton />
        </View>
      ) : page.isError || !page.data ? (
        <ErrorState
          message="We could not load this page."
          offline={(page.error as { isOffline?: boolean } | null)?.isOffline === true}
          onRetry={() => void page.refetch()}
        />
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.content,
            // The tab bar floats over this screen (MainTabs.tsx's
            // `AnimatedTabBar`) rather than reserving its own flex space.
            { paddingBottom: tabBarClearance + spacing.xxl },
          ]}
          refreshControl={<RefreshControl refreshing={page.isRefetching} onRefresh={() => void page.refetch()} tintColor={colors.primary} colors={[colors.primary]} />}
        >
          <InfoPageHeading title={title} page={page.data} />
          <InfoPageSections page={page.data} />
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: { width: 40, height: 40, justifyContent: 'center' },
  headerTitle: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.base },
});
