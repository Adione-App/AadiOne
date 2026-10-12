/**
 * Location permission and serviceability (Task 14.5).
 *
 * Two behaviours the brief is specific about:
 *
 *   1. A DENIED PERMISSION IS NOT A DEAD END. The customer can enter their
 *      area manually. Refusing to proceed teaches them the app is broken, and
 *      GPS permission refusal is common on shared and second-hand phones.
 *
 *   2. OUT OF AREA STILL ALLOWS BROWSING. They cannot order, but they can
 *      look — and "notify me when you deliver here" turns a dead end into
 *      demand data for the next store.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@shared/theme';
import { formatStraightLineDistance } from '@shared/distance';
import { DETECT_MESSAGE, describeAccuracy, suggestionLabel, type DetectResult } from '@shared/location';
import { detectDeviceLocation, suggestAddressFor } from '@/lib/deviceLocation';
import { useLocation } from '@/lib/store';
import { AppText, Button, Card, Loading, Screen } from '@/components/ui';

type Phase = 'locating' | 'confirm' | 'failed' | 'done';
type Fix = Extract<DetectResult, { status: 'OK' }> & { label: string };

export default function LocationScreen({
  onReady,
}: {
  onReady: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('locating');
  const [failure, setFailure] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const { setLocation, serviceability, checking, error } = useLocation();

  /**
   * One FRESH fix (never the cached last-known position, which could be
   * minutes old and kilometres off), with a timeout and its accuracy — then
   * shown to the customer to confirm before anything is decided from it.
   */
  const detect = useCallback(async (): Promise<void> => {
    setPhase('locating');
    setFailure(null);
    setFix(null);
    const result = await detectDeviceLocation();
    if (result.status !== 'OK') {
      setFailure(DETECT_MESSAGE[result.status]);
      setPhase('failed');
      return;
    }
    // The address shown is a suggestion from the OS geocoder; the point is the fix itself.
    const suggestion = await suggestAddressFor(result.latitude, result.longitude);
    setFix({ ...result, label: suggestionLabel(suggestion) });
    setPhase('confirm');
  }, []);

  const confirm = useCallback(async (): Promise<void> => {
    if (!fix) return;
    setPhase('done');
    await setLocation({ latitude: fix.latitude, longitude: fix.longitude, label: fix.label, source: 'GPS', accuracyM: fix.accuracyM });
  }, [fix, setLocation]);

  useEffect(() => {
    void detect();
  }, [detect]);

  useEffect(() => {
    if (phase === 'done' && serviceability?.serviceable) onReady();
  }, [phase, serviceability, onReady]);

  if (phase === 'locating') {
    return <Loading label="Finding your location…" />;
  }

  if (phase === 'failed') {
    return (
      <Screen style={{ paddingTop: insets.top + spacing.xxl, paddingHorizontal: spacing.base }}>
        <AppText variant="display">Where should we deliver?</AppText>
        <AppText variant="bodyLarge" color={colors.textSecondary} style={{ marginTop: spacing.sm }}>
          {failure}
        </AppText>

        <Button label="Try again" onPress={detect} style={{ marginTop: spacing.xl }} />
        <Button
          label="Enter address manually"
          variant="secondary"
          onPress={onReady}
          style={{ marginTop: spacing.md }}
        />
      </Screen>
    );
  }

  if (phase === 'confirm' && fix) {
    return (
      <Screen style={{ paddingTop: insets.top + spacing.xxl, paddingHorizontal: spacing.base }}>
        <AppText variant="display">Is this where you are?</AppText>
        <Card style={{ marginTop: spacing.lg }}>
          <AppText variant="bodyStrong">{fix.label}</AppText>
          <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
            {describeAccuracy(fix.accuracyM)} · {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}
          </AppText>
          {fix.quality === 'POOR' && (
            <AppText variant="caption" color={colors.danger} style={{ marginTop: spacing.sm }}>
              Your phone could only find an approximate location. If this is not right, try again outdoors or enter your
              address instead.
            </AppText>
          )}
        </Card>
        <Button label="Deliver here" onPress={() => void confirm()} style={{ marginTop: spacing.xl }} />
        <Button label="Try again" variant="secondary" onPress={detect} style={{ marginTop: spacing.md }} />
        <Button label="Enter address manually" variant="ghost" onPress={onReady} style={{ marginTop: spacing.sm }} />
      </Screen>
    );
  }

  if (checking) {
    return <Loading label="Checking delivery availability…" />;
  }

  if (serviceability && !serviceability.serviceable) {
    return (
      <Screen style={{ paddingTop: insets.top + spacing.xxl, paddingHorizontal: spacing.base }}>
        <View style={styles.sorryMark}>
          <AppText variant="displayLarge" color={colors.danger}>
            ✕
          </AppText>
        </View>

        <AppText variant="displayLarge" style={{ textAlign: 'center' }}>
          Sorry!
        </AppText>
        <AppText variant="h2" color={colors.danger} style={{ textAlign: 'center' }}>
          We don’t deliver here.
        </AppText>
        <AppText
          variant="bodyLarge"
          color={colors.textSecondary}
          style={{ textAlign: 'center', marginTop: spacing.md }}
        >
          This location is {formatStraightLineDistance(serviceability.distanceKm)} from our nearest store. We
          currently deliver up to {serviceability.maxRadiusKm} km (straight line).
        </AppText>

        <Card style={{ marginTop: spacing.xl }}>
          <AppText variant="bodyStrong">Why can’t we deliver here?</AppText>
          <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
            Our delivery partners work from one store, so we can only reach nearby areas for now.
          </AppText>
        </Card>

        {/* Browsing stays open on purpose — a customer who can look is a
            customer we can win when the radius grows. */}
        <Button
          label="Browse products anyway"
          variant="secondary"
          onPress={onReady}
          style={{ marginTop: spacing.lg }}
        />
        <Button
          label="Try a different location"
          variant="ghost"
          onPress={detect}
          style={{ marginTop: spacing.sm }}
        />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen style={{ padding: spacing.base }}>
        <AppText variant="body" color={colors.danger}>
          {error}
        </AppText>
        <Button label="Try again" onPress={detect} style={{ marginTop: spacing.lg }} />
      </Screen>
    );
  }

  return <Loading label="Checking delivery availability…" />;
}

const styles = StyleSheet.create({
  sorryMark: {
    alignSelf: 'center',
    width: 120,
    height: 120,
    borderRadius: radius.circle,
    backgroundColor: colors.dangerSurface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
});
