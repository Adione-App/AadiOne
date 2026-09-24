/**
 * Privacy Policy and Terms & Conditions (Task 14.16 companion).
 *
 * Fetched from the server rather than bundled into the app: legal text has to
 * be correctable without a Play Store release, and the same source also serves
 * the public HTML page that Play requires.
 */

import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { colors, spacing } from '@shared/theme';
import { api } from '@/lib/api';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, ErrorState, Loading, Screen } from '@/components/ui';

interface LegalDocument {
  slug: string;
  title: string;
  updatedAt: string;
  sections: { heading: string; body: string[] }[];
}

export default function LegalScreen({
  slug,
  onBack,
}: {
  slug: 'privacy' | 'terms';
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();

  const document = useQuery({
    queryKey: ['legal', slug],
    queryFn: () => api.get<LegalDocument>(`/legal/${slug}`),
    staleTime: 60 * 60_000,
  });

  if (document.isLoading) return <Loading />;

  if (document.isError || !document.data) {
    return (
      <ErrorState
        message="We could not load this page."
        offline={(document.error as { isOffline?: boolean } | null)?.isOffline === true}
        onRetry={() => void document.refetch()}
      />
    );
  }

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">{document.data.title}</AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.base,
          // The tab bar floats over this screen now (see MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space.
          paddingBottom: tabBarClearance + spacing.xxl,
        }}
      >
        <AppText variant="caption" color={colors.textSecondary}>
          Last updated {document.data.updatedAt}
        </AppText>

        {document.data.sections.map((section) => (
          <View key={section.heading} style={{ marginTop: spacing.lg }}>
            <AppText variant="h3">{section.heading}</AppText>
            {section.body.map((paragraph, index) => (
              <AppText
                key={index}
                variant="body"
                color={colors.textSecondary}
                style={{ marginTop: spacing.sm }}
              >
                {paragraph}
              </AppText>
            ))}
          </View>
        ))}
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
});
