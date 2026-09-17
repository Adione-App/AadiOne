/**
 * About AdiOne (Task 14.14 companion).
 *
 * The delivery promise, support email and support numbers come from public
 * configuration, not from constants in the binary. The mockups contradicted
 * themselves on this (10 minutes on one screen, 30 on another), and a promise
 * compiled into an APK cannot be corrected without a Play Store release.
 */

import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Headphones, ShieldCheck, Tag, Zap, type LucideIcon } from 'lucide-react-native';
import type { PublicConfig } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { api } from '@/lib/api';
import { AppText, Card, Screen } from '@/components/ui';
import BrandMark from '@/components/BrandMark';

// Vector icons, not emoji — emoji render inconsistently across Android OEM
// fonts (the same reason CategoryIcon moved off them); this keeps the About
// page's icon language consistent with the rest of the app.
const FEATURES: { icon: LucideIcon; title: string; body: (promise: string) => string }[] = [
  {
    icon: Zap,
    title: 'Fast Delivery',
    body: (promise: string) => `Get your order delivered to your doorstep ${promise}.`,
  },
  {
    icon: ShieldCheck,
    title: 'Trusted & Safe',
    body: () => 'We ensure quality products and safe delivery every time.',
  },
  {
    icon: Tag,
    title: 'Best Prices',
    body: () => 'Quality products at the best prices.',
  },
  {
    icon: Headphones,
    title: 'Customer Support',
    body: () => 'We are always here to help you.',
  },
];

export default function AboutScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();

  const { data } = useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<PublicConfig>('/config/public'),
    staleTime: 5 * 60_000,
  });

  const promise = data?.DELIVERY_PROMISE_TEXT ?? 'fast';
  const supportEmail = data?.SUPPORT_EMAIL ?? '';
  const supportPhone = data?.SUPPORT_PHONE ?? '';

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">About AdiOne</AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.base,
          paddingBottom: insets.bottom + spacing.xxl,
        }}
      >
        <View style={{ alignItems: 'center' }}>
          <View style={styles.logoRing}>
            <BrandMark size={88} />
          </View>

          <AppText variant="displayLarge" style={{ marginTop: spacing.md }}>
            <AppText variant="displayLarge" color="#0E441C">
              Adi
            </AppText>
            <AppText variant="displayLarge" color={colors.primary}>
              One
            </AppText>
          </AppText>

          <AppText variant="bodyLarge" style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            Your daily essentials, delivered{' '}
            <AppText variant="bodyLarge" color={colors.primary}>
              {promise}
            </AppText>
          </AppText>

          <AppText
            variant="body"
            color={colors.textSecondary}
            style={{ marginTop: spacing.md, textAlign: 'center' }}
          >
            AdiOne is your trusted quick delivery app for groceries and daily essentials. We aim
            to make your shopping experience easy, fast and reliable.
          </AppText>
        </View>

        <Card style={{ marginTop: spacing.lg, padding: 0 }}>
          {FEATURES.map((feature, index) => (
            <View
              key={feature.title}
              style={[styles.featureRow, index === FEATURES.length - 1 && { borderBottomWidth: 0 }]}
            >
              <View style={styles.featureIcon}>
                <feature.icon size={22} color={colors.primary} strokeWidth={2} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="bodyStrong">{feature.title}</AppText>
                <AppText
                  variant="body"
                  color={colors.textSecondary}
                  style={{ marginTop: spacing.xxs }}
                >
                  {feature.body(promise)}
                </AppText>
              </View>
            </View>
          ))}
        </Card>

        <Card style={{ marginTop: spacing.lg }}>
          <AppText variant="h3">App Information</AppText>

          <InfoRow label="Version" value={Constants.expoConfig?.version ?? '1.0.0'} />

          {supportPhone !== '' && (
            <InfoRow
              label="Support Phone"
              value={supportPhone}
              onPress={() => void Linking.openURL(`tel:${supportPhone}`)}
            />
          )}

          {supportEmail !== '' && (
            <InfoRow
              label="Contact Email"
              value={supportEmail}
              onPress={() => void Linking.openURL(`mailto:${supportEmail}`)}
              last
            />
          )}
        </Card>

        <Card style={{ marginTop: spacing.lg, backgroundColor: colors.primarySurface }}>
          <AppText variant="bodyStrong">Made with care in India</AppText>
          <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xxs }}>
            Thank you for choosing AdiOne.
          </AppText>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function InfoRow({
  label,
  value,
  onPress,
  last,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  last?: boolean;
}) {
  const content = (
    <View style={[styles.infoRow, last && { borderBottomWidth: 0 }]}>
      <AppText variant="body" color={colors.textSecondary}>
        {label}
      </AppText>
      <AppText variant="body" color={onPress ? colors.primary : colors.textPrimary}>
        {value}
      </AppText>
    </View>
  );

  return onPress ? <Pressable onPress={onPress}>{content}</Pressable> : content;
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
  logoRing: {
    width: 120,
    height: 120,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureRow: {
    flexDirection: 'row',
    gap: spacing.base,
    padding: spacing.base,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  featureIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
});
