/**
 * Food tab placeholder.
 *
 * A dedicated food-ordering flow isn't built yet — this tells the customer
 * that plainly instead of leaving the tab empty or dead.
 */

import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@shared/theme';
import { AppText, Screen } from '@/components/ui';

export default function FoodScreen() {
  const insets = useSafeAreaInsets();

  return (
    <Screen style={{ paddingTop: insets.top }}>
      <View style={styles.body}>
        <View style={styles.iconCircle}>
          <Ionicons name="fast-food" size={56} color={colors.primary} />
        </View>

        <AppText variant="h1" style={styles.title}>
          Coming Soon
        </AppText>

        <AppText variant="body" color={colors.textSecondary} style={styles.subtitle}>
          We're cooking up something tasty. Food ordering will be available
          here soon — stay tuned!
        </AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
