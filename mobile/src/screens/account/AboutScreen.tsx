/**
 * About Aadione.
 *
 * The page itself is the admin-published "About Aadione" content (Admin Panel
 * → Information Pages; GET /legal/about) — the same text the website shows —
 * whose business / contact details come from Admin Configuration. Until it is
 * published, this screen shows only a short, claim-free introduction and the
 * support contacts that are configured (GET /legal/business; an empty setting
 * has no row).
 *
 * No delivery-time promises, "best price" or "always available" claims are
 * written into the app: anything the business says about itself is published
 * text an admin can correct without a store release.
 */

import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { colors, spacing } from '@shared/theme';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Screen } from '@/components/ui';
import BrandMark from '@/components/BrandMark';
import { ContactRows, InfoPageHeading, InfoPageSections, InfoPageSkeleton, LinkedText } from '@/components/InfoPageView';
import { useBusinessInfo, useInfoPage } from '@/lib/infoPages';
import { supportContactRows } from '@/lib/infoPageFormat';

export default function AboutScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const about = useInfoPage('about');
  const business = useBusinessInfo();
  const published = about.data ?? null;
  const contactRows = supportContactRows(business.data);
  const appVersion = Constants.expoConfig?.version ?? null;

  const refresh = () => {
    void about.refetch();
    void business.refetch();
  };

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">About Aadione</AppText>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          // The tab bar floats over this screen (MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space.
          { paddingBottom: tabBarClearance + spacing.xxl },
        ]}
        refreshControl={
          <RefreshControl refreshing={about.isRefetching || business.isRefetching} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />
        }
      >
        <View style={styles.brand}>
          <BrandMark size={48} />
          <AppText variant="display" style={styles.wordmark}>
            <AppText variant="display" color="#0E441C">
              Aadi
            </AppText>
            <AppText variant="display" color={colors.primary}>
              one
            </AppText>
          </AppText>
        </View>

        {about.isLoading ? (
          <InfoPageSkeleton />
        ) : published ? (
          <>
            <InfoPageHeading title={published.title} page={published} />
            <InfoPageSections page={published} />
          </>
        ) : (
          <>
            <LinkedText
              text="Aadione is a hyperlocal marketplace: it brings the shops, restaurants and other local businesses around you into one app, so you can order from them in one place."
              style={styles.intro}
            />
            {contactRows.length > 0 ? (
              <View style={styles.block}>
                <AppText variant="h3" style={styles.blockTitle}>
                  Contact us
                </AppText>
                <ContactRows rows={contactRows} />
              </View>
            ) : null}
          </>
        )}

        {appVersion ? (
          <AppText variant="caption" color={colors.textSecondary} style={styles.version}>
            App version {appVersion}
          </AppText>
        ) : null}
      </ScrollView>
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
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.base },
  wordmark: { flexShrink: 1 },
  intro: { marginTop: spacing.sm },
  block: { marginTop: spacing.xl },
  blockTitle: { marginBottom: spacing.sm },
  version: { marginTop: spacing.xxl, textAlign: 'center' },
});
