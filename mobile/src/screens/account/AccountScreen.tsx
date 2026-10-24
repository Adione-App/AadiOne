/**
 * Account (Task 14.14).
 *
 * `mobileVerified` drives a prompt: an account created with email + password
 * has an unproven number, and the rider phones that number — so it is asked
 * for before it becomes a failed delivery.
 */

import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CheckCircle2,
  ChevronRight,
  FileText,
  Gift,
  Headphones,
  Heart,
  Info,
  LogOut,
  MapPin,
  Package,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react-native';
import { formatIndianMobile } from '@shared/phone';
import { colors, radius, spacing } from '@shared/theme';
import { openLogin } from '@/lib/authGate';
import { useAuth } from '@/lib/store';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Button, NoticeStrip, Screen } from '@/components/ui';

interface MenuItem {
  key: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
}

const SUPPORT_MENU: MenuItem[] = [
  { key: 'personal', label: 'Personal Information', subtitle: 'Manage your details', icon: UserRound },
  { key: 'addresses', label: 'Addresses', subtitle: 'Manage your delivery addresses', icon: MapPin },
  { key: 'refer', label: 'Refer & Earn', subtitle: 'Invite friends and earn rewards', icon: Gift },
  { key: 'help', label: 'Help & Support', subtitle: 'Get help or contact us', icon: Headphones },
];

const ABOUT_MENU: MenuItem[] = [
  { key: 'about', label: 'About AadiOne', subtitle: 'Know more about us', icon: Info },
  { key: 'privacy', label: 'Privacy Policy', subtitle: 'How we handle your data', icon: ShieldCheck },
  { key: 'terms', label: 'Terms & Conditions', subtitle: 'Rules and guidelines', icon: FileText },
];

function MenuCard({ items, onSelect }: { items: MenuItem[]; onSelect: (key: string) => void }) {
  return (
    <View style={styles.menuCard}>
      {items.map((item, index) => (
        <Pressable
          key={item.key}
          onPress={() => onSelect(item.key)}
          style={[styles.row, index === items.length - 1 && styles.rowLast]}
        >
          <View style={styles.rowIcon}>
            <item.icon size={18} color={colors.primary} strokeWidth={2} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodyStrong">{item.label}</AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              {item.subtitle}
            </AppText>
          </View>
          <ChevronRight size={18} color={colors.textMuted} />
        </Pressable>
      ))}
    </View>
  );
}

export default function AccountScreen({ onSelect }: { onSelect: (key: string) => void }) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const user = useAuth((state) => state.user);
  const logout = useAuth((state) => state.logout);

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + spacing.base,
          paddingHorizontal: spacing.base,
          // The tab bar floats over this screen now (see MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space, so
          // this needs its OWN clearance to keep the last menu row clear of
          // its visible plate at rest — `insets.bottom` alone (the old
          // value) no longer accounts for `layout.tabBarHeight` on top of it.
          paddingBottom: tabBarClearance + spacing.xxl,
        }}
      >
        <AppText variant="h1">My Account</AppText>
        <AppText variant="body" color={colors.textSecondary} style={styles.headerSubtitle}>
          Manage your profile and settings
        </AppText>

        {/* ==========================================================
            PROFILE CARD
        ========================================================== */}

        {/* A guest: everything below that is not account-only (wishlist,
            help, about, policies) works as it is; the rest asks for a login
            when tapped (stacks.tsx). */}
        {!user ? (
          <View style={styles.guestCard}>
            <View style={styles.guestRow}>
              <View style={styles.guestAvatar}>
                <UserRound size={24} color={colors.primary} strokeWidth={2.2} />
              </View>
              <View style={styles.guestText}>
                <AppText variant="bodyLarge" style={styles.guestTitle}>
                  Welcome to Aadione
                </AppText>
                <AppText variant="caption" color={colors.textSecondary} numberOfLines={2}>
                  Log in to order, track deliveries and save addresses.
                </AppText>
              </View>
            </View>
            <Button label="Log in / Sign up" onPress={() => openLogin('account')} style={styles.guestButton} />
          </View>
        ) : (
          <View style={styles.profileCard}>
            <View style={styles.avatar}>
              <UserRound size={30} color={colors.onPrimary} strokeWidth={2} />
            </View>

            <View style={{ marginLeft: spacing.base, flex: 1 }}>
              <AppText variant="h3">{user.fullName ?? 'AdiOne customer'}</AppText>
              <AppText variant="body" color={colors.textSecondary} style={{ marginTop: 2 }}>
                {formatIndianMobile(user.mobile)}
              </AppText>

              {user.mobileVerified && (
                <View style={styles.verifiedBadge}>
                  <CheckCircle2 size={13} color={colors.primary} strokeWidth={2.4} />
                  <AppText variant="caption" color={colors.primary} style={styles.verifiedText}>
                    Verified
                  </AppText>
                </View>
              )}
            </View>
          </View>
        )}

        {user && !user.mobileVerified && (
          <View style={{ marginTop: spacing.base }}>
            <NoticeStrip message="Please verify your mobile number — our delivery partner will call it." />
          </View>
        )}

        {/* ==========================================================
            QUICK ACTIONS
        ========================================================== */}

        <View style={styles.quickRow}>
          <Pressable
            style={[styles.quickTile, { backgroundColor: colors.primarySurface }]}
            onPress={() => onSelect('orders')}
          >
            <View style={styles.quickTop}>
              <View style={styles.quickIconCircle}>
                <Package size={20} color={colors.primary} strokeWidth={2} />
              </View>
              <ChevronRight size={18} color={colors.textMuted} />
            </View>
            <AppText variant="bodyStrong" style={{ marginTop: spacing.sm }}>
              My Orders
            </AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              Track your orders
            </AppText>
          </Pressable>

          <Pressable
            style={[styles.quickTile, { backgroundColor: colors.dangerSurface }]}
            onPress={() => onSelect('wishlist')}
          >
            <View style={styles.quickTop}>
              <View style={styles.quickIconCircle}>
                <Heart size={20} color={colors.danger} strokeWidth={2} />
              </View>
              <ChevronRight size={18} color={colors.textMuted} />
            </View>
            <AppText variant="bodyStrong" style={{ marginTop: spacing.sm }}>
              My Wishlist
            </AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              Saved products
            </AppText>
          </Pressable>
        </View>

        {/* ==========================================================
            ACCOUNT & SUPPORT
        ========================================================== */}

        <AppText variant="overline" color={colors.textSecondary} style={styles.sectionLabel}>
          Account & Support
        </AppText>
        <MenuCard items={SUPPORT_MENU} onSelect={onSelect} />

        {/* ==========================================================
            ABOUT
        ========================================================== */}

        <AppText variant="overline" color={colors.textSecondary} style={styles.sectionLabel}>
          About
        </AppText>
        <MenuCard items={ABOUT_MENU} onSelect={onSelect} />

        {/* ==========================================================
            LOGOUT
        ========================================================== */}

        {user ? (
          <Pressable style={styles.logoutButton} onPress={() => void logout()}>
            <LogOut size={18} color={colors.danger} strokeWidth={2} />
            <AppText variant="bodyStrong" color={colors.danger} style={{ marginLeft: spacing.sm }}>
              Logout
            </AppText>
          </Pressable>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerSubtitle: { marginTop: 2 },

  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.base,
    padding: spacing.base,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySurface,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.circle,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  verifiedText: { fontWeight: '700' },
  /* Signed out: a compact white card — small avatar beside a short welcome,
     then one full-width sign-in button. */
  guestCard: {
    marginTop: spacing.base,
    padding: spacing.base,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  guestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  guestAvatar: {
    width: 48,
    height: 48,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guestText: { flex: 1, minWidth: 0, gap: 2 },
  guestTitle: { fontWeight: '700', color: colors.textPrimary },
  guestButton: {
    marginTop: spacing.md,
    alignSelf: 'stretch',
  },

  quickRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.base,
  },
  quickTile: {
    flex: 1,
    borderRadius: radius.lg,
    padding: spacing.base,
  },
  quickTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quickIconCircle: {
    width: 36,
    height: 36,
    borderRadius: radius.circle,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  sectionLabel: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  menuCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowLast: {
    borderBottomWidth: 0,
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

  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSurface,
  },
});
