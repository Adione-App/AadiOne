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
import * as Location from 'expo-location';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@shared/theme';
import { formatDistance } from '@shared/distance';
import { useLocation } from '@/lib/store';
import { AppText, Button, Card, Loading, Screen } from '@/components/ui';

type Phase = 'asking' | 'locating' | 'denied' | 'done' | 'error';

export default function LocationScreen({
  onReady,
}: {
  onReady: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('asking');
  const { setLocation, serviceability, checking, error } = useLocation();

  const detect = useCallback(async (): Promise<void> => {
    setPhase('locating');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPhase('denied');
        return;
      }

      // A fresh GPS fix can take several seconds — long enough that this
      // screen was the single biggest "why is this app slow" complaint. A
      // cached fix is near-instant and, at the kilometre scale serviceability
      // cares about, just as useful, so show it immediately and let the
      // accurate fix refine things quietly in the background rather than
      // leaving the customer staring at a spinner.
      const cached = await Location.getLastKnownPositionAsync({
        maxAge: 5 * 60_000,
      }).catch(() => null);

      if (cached) {
        await setLocation({
          latitude: cached.coords.latitude,
          longitude: cached.coords.longitude,
          label: 'Current location',
        });
        setPhase('done');
      }

      const position = await Location.getCurrentPositionAsync({
        // Balanced, not Highest: high accuracy costs seconds and battery for
        // precision serviceability does not need at kilometre scale.
        accuracy: Location.Accuracy.Balanced,
      });

      let label = 'Current location';
      try {
        const [place] = await Location.reverseGeocodeAsync({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        if (place) {
          label = [place.district ?? place.subregion, place.city ?? place.region, place.postalCode]
            .filter(Boolean)
            .join(', ');
        }
      } catch {
        // Reverse geocoding is cosmetic; coordinates are what decide.
      }

      await setLocation({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        label,
      });
      setPhase('done');
    } catch {
      setPhase('error');
    }
  }, [setLocation]);

  useEffect(() => {
    void detect();
  }, [detect]);

  useEffect(() => {
    if (phase === 'done' && serviceability?.serviceable) onReady();
  }, [phase, serviceability, onReady]);

  if (phase === 'locating' || checking) {
    return <Loading label="Finding your location…" />;
  }

  if (phase === 'denied' || phase === 'error') {
    return (
      <Screen style={{ paddingTop: insets.top + spacing.xxl, paddingHorizontal: spacing.base }}>
        <AppText variant="display">Where should we deliver?</AppText>
        <AppText
          variant="bodyLarge"
          color={colors.textSecondary}
          style={{ marginTop: spacing.sm }}
        >
          {phase === 'denied'
            ? 'We could not access your location. You can allow it, or continue and add your address yourself.'
            : 'We could not detect your location right now.'}
        </AppText>

        <Button label="Allow location" onPress={detect} style={{ marginTop: spacing.xl }} />
        <Button
          label="Enter address manually"
          variant="secondary"
          onPress={onReady}
          style={{ marginTop: spacing.md }}
        />
      </Screen>
    );
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
          This location is {formatDistance(serviceability.distanceKm)} from our store. We
          currently deliver up to {serviceability.maxRadiusKm} km.
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
