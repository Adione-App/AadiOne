/**
 * Personal Information (Task 14.14).
 *
 * Name and email are editable; the MOBILE NUMBER IS NOT — it is the account
 * identity and the number the delivery partner calls. The API has no field for
 * changing it, so this is structural rather than a disabled input.
 *
 * Delete Account is here because Google Play requires an in-app deletion path
 * and the DPDP Act requires erasure on request. It really erases.
 */

import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from '@tanstack/react-query';
import type { UserDto } from '@shared';
import { formatIndianMobile } from '@shared/phone';
import { colors, radius, spacing } from '@shared/theme';
import { api, ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Button, Card, Input, NoticeStrip, Screen } from '@/components/ui';

export default function PersonalInfoScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const user = useAuth((state) => state.user);
  const clear = useAuth((state) => state.clear);

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch<UserDto>('/auth/me', {
        fullName: fullName.trim(),
        email: email.trim() === '' ? null : email.trim(),
      }),
    onSuccess: (updated) => {
      setError(null);
      setMessage('Your details have been saved.');
      useAuth.setState({ user: updated });
    },
    onError: (err: Error) =>
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your details.'),
  });

  const deleteAccount = useMutation({
    mutationFn: () => api.delete('/auth/me'),
    // The session is dead server-side, so clear locally rather than leaving
    // the app holding tokens for an account that no longer exists.
    onSuccess: () => clear(),
    onError: (err: Error) =>
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete your account.'),
  });

  function confirmDelete(): void {
    // Two taps, and the second names exactly what is lost. Deletion is
    // irreversible, so a single "Are you sure?" is not enough warning.
    Alert.alert(
      'Delete your account?',
      'This permanently removes your name, email, saved addresses and notifications. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'This cannot be undone',
              'Your account will be deleted immediately. Are you sure?',
              [
                { text: 'Keep my account', style: 'cancel' },
                {
                  text: 'Delete permanently',
                  style: 'destructive',
                  onPress: () => deleteAccount.mutate(),
                },
              ],
            ),
        },
      ],
    );
  }

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">Personal Information</AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.base,
          gap: spacing.base,
          // The tab bar floats over this screen now (see MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space.
          paddingBottom: tabBarClearance + spacing.xxl,
        }}
      >
        {error && <NoticeStrip message={error} />}
        {message && <NoticeStrip message={message} tone="info" />}

        <View>
          <AppText variant="bodyStrong" style={{ marginBottom: spacing.xs }}>
            Full Name
          </AppText>
          <Input value={fullName} onChangeText={setFullName} placeholder="Enter your name" />
        </View>

        <View>
          <AppText variant="bodyStrong" style={{ marginBottom: spacing.xs }}>
            Email Address
          </AppText>
          <Input
            value={email}
            onChangeText={setEmail}
            placeholder="Enter your email (optional)"
            keyboardType="email-address"
          />
        </View>

        <View>
          <AppText variant="bodyStrong" style={{ marginBottom: spacing.xs }}>
            Mobile Number
          </AppText>
          <View style={styles.lockedField}>
            <AppText variant="bodyLarge">
              {user ? formatIndianMobile(user.mobile) : ''}
            </AppText>
            {user?.mobileVerified && (
              <AppText variant="caption" color={colors.primary}>
                Verified ✓
              </AppText>
            )}
          </View>
          <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
            Your mobile number cannot be changed. Our delivery partner calls this number.
          </AppText>
        </View>

        <Button
          label="Save changes"
          onPress={() => save.mutate()}
          loading={save.isPending}
          disabled={fullName.trim().length < 2}
        />

        <Card style={{ marginTop: spacing.xl, borderColor: colors.danger }}>
          <AppText variant="bodyStrong" color={colors.danger}>
            Delete Account
          </AppText>
          <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
            Permanently delete your account and all associated data. Past orders are kept in an
            anonymised form for tax records, as explained in our Privacy Policy.
          </AppText>
          <Button
            label="Delete my account"
            variant="danger"
            onPress={confirmDelete}
            loading={deleteAccount.isPending}
            style={{ marginTop: spacing.base }}
          />
        </Card>
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
  lockedField: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSunken,
  },
});
