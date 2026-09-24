/**
 * Help & Support.
 *
 * A shop this size has no ticketing system — support IS the shopkeeper's
 * phone. So the screen leads with the three ways to reach a human and keeps
 * the FAQ underneath for the questions that do not need one.
 *
 * Every contact detail comes from public configuration, so changing the
 * support number is an admin form submission, not an app release.
 */

import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import type { PublicConfig } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { api } from '@/lib/api';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Card, Screen } from '@/components/ui';

const FAQ: { q: string; a: string }[] = [
  {
    q: 'How long does delivery take?',
    a: 'Most orders reach you within 30 minutes. The exact estimate for your address is shown at checkout and updates live on the tracking screen.',
  },
  {
    q: 'Can I cancel an order?',
    a: 'Yes, until the store starts packing it. Open the order from My Orders and tap Cancel. After packing has begun, call us and we will sort it out.',
  },
  {
    q: 'How do I pay?',
    a: 'Pay by UPI from any app on your phone, or choose Cash on Delivery where it is available. For UPI, tap "I have paid" once the payment is done and the store confirms it against their account.',
  },
  {
    q: 'Something was missing or damaged',
    a: 'Call us the same day. Tell us the order number shown at the top of the order and we will refund or replace the item.',
  },
  {
    q: 'When do I get my refund?',
    a: 'Refunds for UPI payments are sent back to the same account, usually within 3 to 5 working days. Cash orders are settled directly by the store.',
  },
];

function ContactRow({
  label,
  value,
  hint,
  onPress,
}: {
  label: string;
  value: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.contact}>
      <View style={{ flex: 1 }}>
        <AppText variant="bodyStrong">{label}</AppText>
        <AppText variant="body" color={colors.primary}>
          {value}
        </AppText>
        <AppText variant="caption" color={colors.textSecondary}>
          {hint}
        </AppText>
      </View>
      <AppText variant="h3" color={colors.textMuted}>
        ›
      </AppText>
    </Pressable>
  );
}

function FaqItem({ item }: { item: { q: string; a: string } }) {
  return (
    <View style={styles.faq}>
      <AppText variant="bodyStrong">{item.q}</AppText>
      <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
        {item.a}
      </AppText>
    </View>
  );
}

export default function HelpScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();

  const { data } = useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<PublicConfig>('/config/public'),
    staleTime: 5 * 60_000,
  });

  const phone = data?.SUPPORT_PHONE ?? '';
  const whatsapp = data?.SUPPORT_WHATSAPP ?? '';
  const email = data?.SUPPORT_EMAIL ?? '';

  /** wa.me wants a bare international number: no +, spaces or dashes. */
  const whatsappDigits = whatsapp.replace(/\D/g, '');

  async function open(url: string): Promise<void> {
    // Nothing here is essential enough to justify an error screen if the
    // handset has no dialler or mail client.
    await Linking.openURL(url).catch(() => undefined);
  }

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">Help & Support</AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.base,
          // The tab bar floats over this screen now (see MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space.
          paddingBottom: tabBarClearance + spacing.xxl,
        }}
      >
        <AppText variant="body" color={colors.textSecondary}>
          We are here during store hours. Calling is the quickest way to reach us.
        </AppText>

        <Card style={{ marginTop: spacing.base, padding: 0 }}>
          {phone !== '' && (
            <ContactRow
              label="Call us"
              value={phone}
              hint="Fastest for a problem with a live order"
              onPress={() => void open(`tel:${phone}`)}
            />
          )}
          {whatsappDigits !== '' && (
            <ContactRow
              label="WhatsApp"
              value={whatsapp}
              hint="Send a photo if an item arrived damaged"
              onPress={() => void open(`https://wa.me/${whatsappDigits}`)}
            />
          )}
          {email !== '' && (
            <ContactRow
              label="Email"
              value={email}
              hint="For billing questions and anything not urgent"
              onPress={() => void open(`mailto:${email}`)}
            />
          )}

          {phone === '' && whatsappDigits === '' && email === '' && (
            <View style={{ padding: spacing.base }}>
              <AppText variant="body" color={colors.textSecondary}>
                Support contact details have not been set up yet. Please try again shortly.
              </AppText>
            </View>
          )}
        </Card>

        <AppText variant="h3" style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}>
          Common questions
        </AppText>

        <Card style={{ padding: 0 }}>
          {FAQ.map((item) => (
            <FaqItem key={item.q} item={item} />
          ))}
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: { width: 40, height: 40, justifyContent: 'center' },
  contact: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  faq: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    borderRadius: radius.sm,
  },
});
