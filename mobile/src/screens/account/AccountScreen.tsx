/**
 * Account (Task 14.14, first pass).
 *
 * `mobileVerified` drives a prompt: an account created with email + password
 * has an unproven number, and the rider phones that number — so it is asked
 * for before it becomes a failed delivery.
 */

import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronRight,
  FileText,
  HelpCircle,
  Info,
  MapPin,
  Package,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react-native';
import { formatIndianMobile } from '@shared/phone';
import { colors, radius, spacing } from '@shared/theme';
import { useAuth } from '@/lib/store';
import { AppText, Button, Card, NoticeStrip, Screen } from '@/components/ui';

const MENU: { key: string; label: string; icon: LucideIcon }[] = [
  { key: 'personal', label: 'Personal Information', icon: UserRound },
  { key: 'orders', label: 'My Orders', icon: Package },
  { key: 'addresses', label: 'Addresses', icon: MapPin },
  { key: 'help', label: 'Help & Support', icon: HelpCircle },
  { key: 'about', label: 'About AdiOne', icon: Info },
  { key: 'privacy', label: 'Privacy Policy', icon: ShieldCheck },
  { key: 'terms', label: 'Terms & Conditions', icon: FileText },
];

export default function AccountScreen({ onSelect }: { onSelect: (key: string) => void }) {
  const insets = useSafeAreaInsets();
  const user = useAuth((state) => state.user);
  const logout = useAuth((state) => state.logout);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + spacing.base,
          paddingHorizontal: spacing.base,
          paddingBottom: insets.bottom + spacing.xxl,
        }}
      >
        <AppText variant="h1">My Profile</AppText>

        <Card style={{ marginTop: spacing.base, flexDirection: 'row', alignItems: 'center' }}>
          <View style={styles.avatar}>
            <AppText variant="h2" color={colors.primary}>
              {(user?.fullName ?? user?.mobile ?? 'A').charAt(0).toUpperCase()}
            </AppText>
          </View>
          <View style={{ marginLeft: spacing.base }}>
            <AppText variant="h3">{user?.fullName ?? 'AdiOne customer'}</AppText>
            <AppText variant="body" color={colors.textSecondary}>
              {user ? formatIndianMobile(user.mobile) : ''}
            </AppText>
          </View>
        </Card>

        {user && !user.mobileVerified && (
          <View style={{ marginTop: spacing.base }}>
            <NoticeStrip message="Please verify your mobile number — our delivery partner will call it." />
          </View>
        )}

        <View style={{ marginTop: spacing.lg }}>
          {MENU.map((item) => (
            <Pressable key={item.key} onPress={() => onSelect(item.key)} style={styles.row}>
              <View style={styles.rowIcon}>
                <item.icon size={18} color={colors.primary} strokeWidth={2} />
              </View>
              <AppText variant="bodyLarge" style={styles.rowLabel}>
                {item.label}
              </AppText>
              <ChevronRight size={18} color={colors.textMuted} />
            </Pressable>
          ))}
        </View>

        <Button
          label="Logout"
          variant="secondary"
          onPress={() => void logout()}
          style={{ marginTop: spacing.xl }}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  rowLabel: {
    flex: 1,
  },
});
