/**
 * Sell on Aadione (Account → Sell on Aadione).
 *
 * The signed-in customer opens a store on THIS SAME account: the server takes
 * the account from the session (GET /auth/seller/application,
 * POST /auth/seller/apply) — so there is no mobile field, no OTP and no
 * "this number already has an account" warning. Orders, addresses, coupons
 * and shopping carry on unchanged.
 *
 * The Seller Panel (Aadione Partner Portal, on the web) signs in with email +
 * password. The form only asks for the ones this account does not have yet;
 * an existing email or password is never replaced.
 *
 * Once applied, the screen shows the application's progress instead of the
 * form: the store goes live only after Aadione approves it.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SellerLifecycleStatus,
  SellerType,
  type SellerApplicationStatusDto,
  type SellerApplyRequest,
  type SellerApplyResult,
} from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { api, ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Button, Card, ErrorState, Input, Loading, NoticeStrip, Screen } from '@/components/ui';

const APPLICATION_KEY = ['seller-application'] as const;

/** Same labels as the Partner Portal (web SellerBadges). */
const SELLER_TYPE_LABEL: Record<SellerType, string> = {
  [SellerType.GROCERY]: 'Grocery',
  [SellerType.FASHION]: 'Fashion',
  [SellerType.ELECTRONICS]: 'Electronics',
  [SellerType.BEAUTY]: 'Beauty',
  [SellerType.HOME]: 'Home',
  [SellerType.HOME_KITCHEN]: 'Home & Kitchen',
  [SellerType.PHARMACY]: 'Pharmacy',
  [SellerType.RESTAURANT]: 'Restaurant',
  [SellerType.CAFE]: 'Cafe',
  [SellerType.SPORTS]: 'Sports',
  [SellerType.BOOKS]: 'Books',
  [SellerType.KIDS]: 'Kids',
  [SellerType.AUTOMOTIVE]: 'Automotive',
  [SellerType.PETS]: 'Pets',
  [SellerType.SERVICES]: 'Services',
  [SellerType.OTHER]: 'Other',
};

const STATUS_COPY: Record<SellerLifecycleStatus, { title: string; body: string }> = {
  APPLICATION_PENDING: {
    title: 'Application submitted',
    body: 'Aadione is reviewing your application. We will let you know once it is approved.',
  },
  APPLICATION_REJECTED: {
    title: 'Your application needs changes',
    body: 'Sign in to the Seller Panel to correct and resubmit it.',
  },
  ONBOARDING_PENDING: {
    title: 'Application approved',
    body: 'Sign in to the Seller Panel to complete onboarding: store address, documents and bank details.',
  },
  ONBOARDING_CHANGES_REQUIRED: {
    title: 'Onboarding needs changes',
    body: 'Sign in to the Seller Panel to update your onboarding details.',
  },
  ONBOARDING_PENDING_REVIEW: {
    title: 'Onboarding under review',
    body: 'Aadione is checking your store details. Your store goes live once they are approved.',
  },
  ONBOARDING_REJECTED: {
    title: 'Onboarding not approved',
    body: 'Sign in to the Seller Panel to see what to change.',
  },
  ACTIVE: {
    title: 'Your store is live',
    body: 'Manage products and orders in the Seller Panel.',
  },
};

/** The same rules the server applies — checked here only to answer sooner. */
function problemWith(
  form: { businessName: string; sellerType: SellerType | null; ownerFullName: string; email: string; password: string; confirm: string },
  status: SellerApplicationStatusDto,
): string | null {
  if (form.businessName.trim().length < 2) return 'Enter your business or store name.';
  if (!form.sellerType) return 'Choose what you sell.';
  if (form.ownerFullName.trim().length < 2) return "Enter the owner's full name.";
  if (status.needsEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return 'Enter a valid email address.';
  if (status.needsPassword) {
    if (form.password.length < 8 || !/[a-zA-Z]/.test(form.password) || !/\d/.test(form.password)) {
      return 'Choose a password of at least 8 characters with a letter and a number.';
    }
    if (form.password !== form.confirm) return 'The passwords do not match.';
  }
  return null;
}

export default function SellOnAadioneScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const user = useAuth((state) => state.user);

  const application = useQuery({
    queryKey: APPLICATION_KEY,
    queryFn: ({ signal }) => api.get<SellerApplicationStatusDto>('/auth/seller/application', { signal }),
  });

  const [businessName, setBusinessName] = useState('');
  const [sellerType, setSellerType] = useState<SellerType | null>(null);
  const [ownerFullName, setOwnerFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: (body: SellerApplyRequest) => api.post<SellerApplyResult>('/auth/seller/apply', body),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: APPLICATION_KEY });
    },
    onError: (err: Error) => setError(err instanceof ApiRequestError ? err.message : 'Could not submit your application. Please try again.'),
  });

  function submit(status: SellerApplicationStatusDto): void {
    const problem = problemWith({ businessName, sellerType, ownerFullName, email, password, confirm }, status);
    if (problem) return setError(problem);
    setError(null);
    apply.mutate({
      businessName: businessName.trim(),
      sellerType: sellerType!,
      ownerFullName: ownerFullName.trim(),
      // Only what the account does not have yet — an existing email/password is never sent, never replaced.
      ...(status.needsEmail ? { email: email.trim() } : {}),
      ...(status.needsPassword ? { password } : {}),
    });
  }

  const status = application.data;

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">Sell on Aadione</AppText>
      </View>

      {application.isPending ? (
        <Loading />
      ) : application.isError || !status ? (
        <ErrorState message="Could not load your seller details." onRetry={() => void application.refetch()} />
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: spacing.base, gap: spacing.base, paddingBottom: tabBarClearance + spacing.xxl }}
        >
          {error && <NoticeStrip message={error} />}

          {status.status !== 'NONE' ? (
            <Card>
              <AppText variant="bodyStrong">{STATUS_COPY[status.status].title}</AppText>
              {status.sellerName && (
                <AppText variant="body" style={{ marginTop: spacing.xs }}>
                  {status.sellerName}
                </AppText>
              )}
              <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
                {STATUS_COPY[status.status].body}
              </AppText>
              {status.reason && (
                <AppText variant="body" color={colors.danger} style={{ marginTop: spacing.sm }}>
                  {status.reason}
                </AppText>
              )}
              {status.sellerPanelEmail && (
                <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.base }}>
                  Seller Panel (Aadione Partner Portal, on the web): sign in with {status.sellerPanelEmail}.
                </AppText>
              )}
              <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
                You keep shopping with this same account.
              </AppText>
            </Card>
          ) : !status.canApply ? (
            <NoticeStrip message="This account cannot open a store on Aadione. Please contact Aadione support." />
          ) : (
            <>
              <AppText variant="body" color={colors.textSecondary}>
                Open your store with this same account — your orders, addresses and rewards stay as they are. Aadione
                reviews every application before your store goes live.
              </AppText>

              <View>
                <AppText variant="bodyStrong" style={styles.label}>
                  Business / store name
                </AppText>
                <Input value={businessName} onChangeText={setBusinessName} placeholder="e.g. Sharma General Store" maxLength={120} />
              </View>

              <View>
                <AppText variant="bodyStrong" style={styles.label}>
                  What do you sell?
                </AppText>
                <View style={styles.chips}>
                  {Object.values(SellerType).map((type) => {
                    const selected = sellerType === type;
                    return (
                      <Pressable
                        key={type}
                        onPress={() => setSellerType(type)}
                        style={[styles.chip, selected && styles.chipSelected]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                      >
                        <AppText variant="caption" color={selected ? colors.primary : colors.textPrimary}>
                          {SELLER_TYPE_LABEL[type]}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View>
                <AppText variant="bodyStrong" style={styles.label}>
                  Owner's full name
                </AppText>
                <Input value={ownerFullName} onChangeText={setOwnerFullName} placeholder="Full name" maxLength={120} />
              </View>

              {status.needsEmail ? (
                <View>
                  <AppText variant="bodyStrong" style={styles.label}>
                    Email for the Seller Panel
                  </AppText>
                  <Input
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@yourstore.in"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={160}
                  />
                </View>
              ) : (
                <AppText variant="caption" color={colors.textSecondary}>
                  You will sign in to the Seller Panel with {status.sellerPanelEmail}.
                </AppText>
              )}

              {status.needsPassword ? (
                <>
                  <View>
                    <AppText variant="bodyStrong" style={styles.label}>
                      Seller Panel password
                    </AppText>
                    <Input value={password} onChangeText={setPassword} placeholder="At least 8 characters, a letter and a number" secureTextEntry />
                  </View>
                  <View>
                    <AppText variant="bodyStrong" style={styles.label}>
                      Confirm password
                    </AppText>
                    <Input value={confirm} onChangeText={setConfirm} placeholder="Type it again" secureTextEntry />
                  </View>
                </>
              ) : (
                <AppText variant="caption" color={colors.textSecondary}>
                  Use your existing Seller Panel password (or reset it there with “Forgot password”).
                </AppText>
              )}

              <Button label="Submit application" onPress={() => submit(status)} loading={apply.isPending} />
            </>
          )}
        </ScrollView>
      )}
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
  label: { marginBottom: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
});
