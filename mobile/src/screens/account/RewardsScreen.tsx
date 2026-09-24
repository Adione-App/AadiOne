/**
 * Rewards — Refer & Earn + the customer's coupon wallet.
 *
 * One combined screen (not two separate nav entries) reached from Account's
 * existing "Refer & Earn" tile — matches the spec's own instruction to reuse
 * existing navigation rather than add a new destination for what is really
 * one cohesive page (referral code + stats live right above the coupon
 * tabs, exactly like the mockup).
 */

import { useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Copy, Gift, Share2 } from 'lucide-react-native';
import type { RewardCouponDto, RewardCouponStatus } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { useMyCoupons, useReferralSummary } from '@/lib/queries';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Card, EmptyState, Loading, Screen } from '@/components/ui';

const TABS: { key: RewardCouponStatus; label: string }[] = [
  { key: 'ACTIVE', label: 'Available' },
  { key: 'USED', label: 'Used' },
  { key: 'EXPIRED', label: 'Expired' },
];

export default function RewardsScreen({
  onBack,
  onGoToCart,
}: {
  onBack: () => void;
  onGoToCart: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const summary = useReferralSummary();
  const coupons = useMyCoupons();
  const [tab, setTab] = useState<RewardCouponStatus>('ACTIVE');
  const [copied, setCopied] = useState(false);

  const referralCode = summary.data?.referralCode ?? null;

  async function copyCode(): Promise<void> {
    if (!referralCode) return;
    await Clipboard.setStringAsync(referralCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function shareCode(): Promise<void> {
    if (!referralCode) return;
    try {
      await Share.share({
        message: `Join me on AdiOne and get great deals on groceries and more.\n\nUse my referral code: ${referralCode}`,
      });
    } catch {
      // Share sheet dismissed/cancelled — nothing to recover from.
    }
  }

  const tabCoupons = (coupons.data ?? []).filter((c) => c.status === tab);

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">Rewards</AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.base,
          // The tab bar floats over this screen now (see MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space.
          paddingBottom: tabBarClearance + spacing.xxl,
          gap: spacing.base,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* ------------------------------------------------------------
            REFER & EARN
        ------------------------------------------------------------ */}

        <Card style={styles.referCard}>
          <View style={styles.referIconCircle}>
            <Gift size={24} color={colors.primary} strokeWidth={2} />
          </View>

          <AppText variant="h2" style={{ marginTop: spacing.md }}>
            Invite your friends to AdiOne
          </AppText>

          <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
            Earn ₹50 when your friend completes their first eligible order of
            ₹99 or more.
          </AppText>

          {referralCode && (
            <>
              <AppText
                variant="caption"
                color={colors.textSecondary}
                style={{ marginTop: spacing.lg, textTransform: 'uppercase', letterSpacing: 0.5 }}
              >
                Your Referral Code
              </AppText>

              <View style={styles.codeBox}>
                <AppText variant="h1" style={styles.codeText}>
                  {referralCode}
                </AppText>
              </View>

              <View style={styles.referActions}>
                <Pressable onPress={copyCode} style={[styles.referActionButton, styles.referActionSecondary]}>
                  <Copy size={16} color={colors.primary} strokeWidth={2.2} />
                  <AppText variant="bodyStrong" color={colors.primary} style={{ marginLeft: spacing.xs }}>
                    {copied ? 'Copied!' : 'Copy Code'}
                  </AppText>
                </Pressable>

                <Pressable onPress={shareCode} style={[styles.referActionButton, styles.referActionPrimary]}>
                  <Share2 size={16} color={colors.onPrimary} strokeWidth={2.2} />
                  <AppText variant="bodyStrong" color={colors.onPrimary} style={{ marginLeft: spacing.xs }}>
                    Share
                  </AppText>
                </Pressable>
              </View>
            </>
          )}

          {summary.data && summary.data.referredCount > 0 && (
            <View style={styles.referStatsRow}>
              <AppText variant="caption" color={colors.textSecondary}>
                {summary.data.referredCount} friend{summary.data.referredCount === 1 ? '' : 's'} joined ·{' '}
                {summary.data.completedCount} completed first order ·{' '}
                {summary.data.rewardsIssuedCount} coupon{summary.data.rewardsIssuedCount === 1 ? '' : 's'} earned
              </AppText>
            </View>
          )}
        </Card>

        {/* ------------------------------------------------------------
            YOUR REFERRALS — history
        ------------------------------------------------------------ */}

        {summary.data && summary.data.history.length > 0 && (
          <Card style={styles.historyCard}>
            <AppText variant="h3" style={{ marginBottom: spacing.sm }}>
              Your Referrals
            </AppText>

            {summary.data.history.map((row, index) => (
              <View
                key={`${row.referredDisplayName}-${row.createdAt}`}
                style={[styles.historyRow, index === 0 && { borderTopWidth: 0 }]}
              >
                <View style={{ flex: 1 }}>
                  <AppText variant="bodyStrong">{row.referredDisplayName}</AppText>
                  <AppText variant="caption" color={colors.textSecondary}>
                    {new Date(row.createdAt).toLocaleDateString()}
                  </AppText>
                </View>

                <ReferralStatusChip status={row.status} />
              </View>
            ))}
          </Card>
        )}

        {/* ------------------------------------------------------------
            COUPONS
        ------------------------------------------------------------ */}

        <View>
          <AppText variant="h3" style={{ marginBottom: spacing.sm }}>
            Rewards
          </AppText>

          <View style={styles.tabRow}>
            {TABS.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                style={[styles.tabButton, tab === t.key && styles.tabButtonActive]}
              >
                <AppText
                  variant="bodyStrong"
                  color={tab === t.key ? colors.onPrimary : colors.textSecondary}
                >
                  {t.label}
                </AppText>
              </Pressable>
            ))}
          </View>

          {coupons.isLoading ? (
            <Loading />
          ) : tabCoupons.length === 0 ? (
            <View style={{ marginTop: spacing.base }}>
              <EmptyState
                icon={<Gift size={44} color={colors.primary} strokeWidth={2} />}
                title={
                  tab === 'ACTIVE'
                    ? 'No available coupons'
                    : tab === 'USED'
                      ? 'No used coupons yet'
                      : 'No expired coupons'
                }
                hint={
                  tab === 'ACTIVE'
                    ? summary.data?.referredCount
                      ? 'Your earned coupons will appear here.'
                      : 'Refer friends and earn ₹50 when they complete their first eligible order.'
                    : undefined
                }
              />
            </View>
          ) : (
            <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
              {tabCoupons.map((coupon) => (
                <CouponCard key={coupon.code} coupon={coupon} onUse={onGoToCart} />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

/* ================================================================
   COUPON CARD
================================================================ */

function CouponCard({ coupon, onUse }: { coupon: RewardCouponDto; onUse: () => void }) {
  return (
    <Card style={styles.couponCard}>
      <AppText variant="h1" color={colors.primary}>
        ₹{Math.round(coupon.discountValue / 100)} OFF
      </AppText>

      <AppText variant="bodyStrong" style={{ marginTop: 2 }}>
        {coupon.origin === 'REFERRAL_REWARD' ? 'Referral Reward' : 'Special Offer'}
      </AppText>

      <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
        Minimum order ₹{Math.round(coupon.minOrderPaise / 100)}
      </AppText>

      {coupon.status === 'ACTIVE' && coupon.expiresInLabel && (
        <AppText variant="caption" color={colors.textSecondary}>
          {coupon.expiresInLabel}
        </AppText>
      )}

      {coupon.status === 'USED' && (
        <AppText variant="caption" color={colors.textMuted} style={styles.couponStatusText}>
          Used
        </AppText>
      )}

      {coupon.status === 'EXPIRED' && (
        <AppText variant="caption" color={colors.textMuted} style={styles.couponStatusText}>
          Expired
        </AppText>
      )}

      {coupon.status === 'ACTIVE' && (
        <Pressable onPress={onUse} style={styles.useCouponButton}>
          <AppText variant="bodyStrong" color={colors.onPrimary}>
            Use Coupon
          </AppText>
        </Pressable>
      )}
    </Card>
  );
}

/* ================================================================
   REFERRAL STATUS CHIP
================================================================ */

function ReferralStatusChip({ status }: { status: string }) {
  const label =
    status === 'REWARD_ISSUED'
      ? 'Rewarded'
      : status === 'COMPLETED'
        ? 'Completed'
        : 'Pending first order';

  const tone = status === 'REWARD_ISSUED' ? colors.primary : colors.textSecondary;

  return (
    <View style={[styles.statusChip, { borderColor: tone }]}>
      <AppText variant="caption" color={tone}>
        {label}
      </AppText>
    </View>
  );
}

/* ================================================================
   STYLES
================================================================ */

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

  referCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySurface,
  },

  referIconCircle: {
    width: 48,
    height: 48,
    borderRadius: radius.circle,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },

  codeBox: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    backgroundColor: colors.surface,
    alignItems: 'center',
  },

  codeText: {
    letterSpacing: 4,
  },

  referActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },

  referActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 44,
    borderRadius: radius.pill,
  },

  referActionSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
  },

  referActionPrimary: {
    backgroundColor: colors.primary,
  },

  referStatsRow: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },

  historyCard: {
    padding: spacing.md,
    borderRadius: radius.lg,
  },

  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },

  statusChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },

  tabRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill,
    padding: 4,
    gap: 4,
  },

  tabButton: {
    flex: 1,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },

  tabButtonActive: {
    backgroundColor: colors.primary,
  },

  couponCard: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.divider,
  },

  couponStatusText: {
    marginTop: spacing.xs,
    fontWeight: '700',
  },

  useCouponButton: {
    marginTop: spacing.md,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
