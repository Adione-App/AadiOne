/**
 * "Please review our Privacy Policy and Terms" — shown to a signed-in
 * customer when the published versions need their acceptance
 * (lib/legalConsent.ts). Both pages can be read right here, exactly as on the
 * Legal screens; "I agree" records the acceptance on the server with the
 * versions shown; "Not now" records nothing and asks again next launch.
 * Guests never see it, and shopping is never blocked by it.
 */

import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { ErrorCode, INFO_PAGE_TITLES, type LegalConsentStatusDto } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { api, ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { useInfoPage } from '@/lib/infoPages';
import { consentPromptKey, dismissConsentPrompt, dismissedConsentKey, shouldShowConsentPrompt } from '@/lib/legalConsent';
import { AppText, Button, ErrorState } from './ui';
import { InfoPageHeading, InfoPageSections, InfoPageSkeleton } from './InfoPageView';

const CONSENT_KEY = ['legal', 'consent'] as const;

export default function LegalConsentPrompt() {
  const signedIn = useAuth((state) => state.status === 'authenticated');
  const userId = useAuth((state) => state.user?.id ?? null);
  const queryClient = useQueryClient();
  const [, rerender] = useState(0);

  const status = useQuery({
    queryKey: [...CONSENT_KEY, userId],
    queryFn: () => api.get<LegalConsentStatusDto>('/legal/consent'),
    enabled: signedIn && userId !== null,
    staleTime: 5 * 60_000,
  });

  const accept = useMutation({
    mutationFn: (current: LegalConsentStatusDto) =>
      api.post<LegalConsentStatusDto>('/legal/consent', {
        privacyVersion: current.privacyVersion,
        termsVersion: current.termsVersion,
        source: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
        appVersion: Constants.expoConfig?.version ?? undefined,
      }),
    onSuccess: (next) => queryClient.setQueryData([...CONSENT_KEY, userId], next),
    onError: (error) => {
      // A newer version was published meanwhile: show it before asking again.
      if (error instanceof ApiRequestError && error.code === ErrorCode.CONTENT_CHANGED) {
        void queryClient.invalidateQueries({ queryKey: ['legal'] });
      }
    },
  });

  const data = status.data;
  if (!data || !shouldShowConsentPrompt(signedIn, data, dismissedConsentKey())) return null;

  return (
    <ConsentSheet
      saving={accept.isPending}
      error={accept.error instanceof Error ? accept.error.message : null}
      onAccept={() => accept.mutate(data)}
      onLater={() => {
        dismissConsentPrompt(consentPromptKey(data));
        rerender((n) => n + 1);
      }}
    />
  );
}

function ConsentSheet({ saving, error, onAccept, onLater }: { saving: boolean; error: string | null; onAccept: () => void; onLater: () => void }) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'privacy' | 'terms'>('privacy');
  const page = useInfoPage(tab);

  return (
    <Modal visible animationType="slide" onRequestClose={onLater} statusBarTranslucent>
      <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.header}>
          <AppText variant="h2">Please review our Privacy Policy and Terms</AppText>
          <AppText variant="body" color={colors.textSecondary} style={styles.headerText}>
            They explain how Aadione uses your information and the rules for orders, payments, delivery and refunds.
          </AppText>
          <View style={styles.tabs} accessibilityRole="tablist">
            {(['privacy', 'terms'] as const).map((slug) => (
              <Pressable
                key={slug}
                onPress={() => setTab(slug)}
                style={[styles.tab, tab === slug && styles.tabActive]}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === slug }}
              >
                <AppText variant="bodyStrong" color={tab === slug ? colors.onPrimary : colors.textPrimary}>
                  {INFO_PAGE_TITLES[slug]}
                </AppText>
              </Pressable>
            ))}
          </View>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {page.isLoading ? (
            <InfoPageSkeleton />
          ) : page.isError || !page.data ? (
            <ErrorState message="We could not load this page." onRetry={() => void page.refetch()} />
          ) : (
            <>
              <InfoPageHeading title={page.data.title} page={page.data} />
              <InfoPageSections page={page.data} />
            </>
          )}
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.base }]}>
          {error ? (
            <AppText variant="caption" color={colors.danger} style={styles.error}>
              {error}
            </AppText>
          ) : null}
          <Button label="I agree" onPress={onAccept} loading={saving} />
          <Button label="Not now" variant="ghost" onPress={onLater} disabled={saving} />
          <AppText variant="caption" color={colors.textSecondary} style={styles.small}>
            Tapping “I agree” records the versions you accepted and the time. You can read both pages any time in Account.
          </AppText>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  headerText: { marginTop: spacing.xs },
  tabs: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  tab: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.divider, backgroundColor: colors.surface },
  error: { textAlign: 'center' },
  small: { textAlign: 'center' },
});
