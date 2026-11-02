/**
 * "Need help with your order?" — the bottom of the order screen: the support
 * email and phone the admin configured (lib/supportContact.ts), each a
 * tappable mailto / tel link. Only what is actually configured is shown;
 * with neither, the card is not shown at all (never a blank or placeholder).
 */

import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Mail, Phone } from 'lucide-react-native';
import { colors, spacing } from '@shared/theme';
import { AppText } from '@/components/ui';
import { usePublicConfig } from '@/lib/queries';
import { supportContact } from '@/lib/supportContact';

export function OrderSupportCard() {
  const { data } = usePublicConfig();
  const contact = supportContact(data);
  if (!contact.email && !contact.phone) return null;

  const open = (url: string) => void Linking.openURL(url).catch(() => undefined);

  return (
    <View style={styles.card} accessibilityRole="summary">
      <AppText variant="h3" color={colors.primaryDark}>
        Need help with your order?
      </AppText>
      <AppText variant="body" color={colors.textSecondary} style={styles.text}>
        Having an issue with a missing, damaged or incorrect item, or with the delivery? Contact our support team.
      </AppText>

      {contact.email && contact.mailto && (
        <Pressable
          onPress={() => open(contact.mailto!)}
          style={styles.row}
          accessibilityRole="link"
          accessibilityLabel={`Email support at ${contact.email}`}
        >
          <View style={styles.icon}>
            <Mail size={18} strokeWidth={2} color={colors.primary} />
          </View>
          <View style={styles.flex}>
            <AppText variant="caption" color={colors.textSecondary}>
              Email Support
            </AppText>
            <AppText variant="bodyStrong" color={colors.primary} numberOfLines={1}>
              {contact.email}
            </AppText>
          </View>
        </Pressable>
      )}

      {contact.phone && contact.tel && (
        <Pressable
          onPress={() => open(contact.tel!)}
          style={styles.row}
          accessibilityRole="link"
          accessibilityLabel={`Call support on ${contact.phone}`}
        >
          <View style={styles.icon}>
            <Phone size={18} strokeWidth={2} color={colors.primary} />
          </View>
          <View style={styles.flex}>
            <AppText variant="caption" color={colors.textSecondary}>
              Call Support
            </AppText>
            <AppText variant="bodyStrong" color={colors.primary}>
              {contact.phone}
            </AppText>
          </View>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The order screen's own card shape (OrderTrackingScreen summaryCard), in green.
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    backgroundColor: colors.surface,
    marginTop: spacing.sm,
  },
  text: {
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.xs,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryLight,
  },
  flex: {
    flex: 1,
  },
});
