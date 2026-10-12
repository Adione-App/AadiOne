/**
 * Add / Edit Address (Task 14.13) — an Indian address in its own fields
 * (@shared/address): house / building, street, locality, village / city /
 * town, district, state, PIN, landmark — and, SEPARATELY, the point that
 * every distance is measured from.
 *
 * WHERE THE POINT COMES FROM — and what it is honestly worth:
 *
 *   GPS        "Use my current location (I'm at this address)": one fresh
 *              fix with its accuracy (@/lib/deviceLocation). The OS
 *              geocoder's reading of that point is offered as SUGGESTED
 *              address fields — applied only when the customer says so.
 *   GEOCODED   "Find location from address": the device's forward geocoder
 *              on the typed address. That is the centre of whatever area the
 *              text names — saved and shown as APPROXIMATE, never as the door.
 *
 * Nothing else is ever used: not the app's current location, not a city
 * centre, not (0, 0). (Falling back to the app's current GPS position — a
 * different place when the address is someone else's — was the old bug.)
 * A PIN code covers many villages; it validates the address, it never
 * places it. The server re-checks serviceability at checkout regardless.
 */

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddressDto, ServiceabilityResult } from '@shared';
import { normalizeIndianMobile } from '@shared/phone';
import { ADDRESS_FIELD_LABEL, INDIAN_STATES, isValidPincode, missingAddressFields } from '@shared/address';
import { coordinateProblem, formatStraightLineDistance } from '@shared/distance';
import { DETECT_MESSAGE, describeAccuracy, type AddressSuggestion, type LocationSource } from '@shared/location';
import { colors, radius, spacing } from '@shared/theme';
import { api, ApiRequestError } from '@/lib/api';
import { detectDeviceLocation, geocodeAddressText, suggestAddressFor } from '@/lib/deviceLocation';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Button, Input, NoticeStrip, Screen } from '@/components/ui';

/** Address Type chips from the mockup. Stored in `label`. */
const ADDRESS_TYPES = ['Home', 'Work', 'Other'] as const;
type AddressType = (typeof ADDRESS_TYPES)[number];

/** The point this address is measured from. `source` null = saved before origins were recorded. */
interface Point {
  latitude: number;
  longitude: number;
  source: LocationSource | null;
  accuracyM: number | null;
}

type Fields = {
  houseNo: string;
  street: string;
  area: string;
  city: string;
  district: string;
  state: string;
  pincode: string;
  landmark: string;
};

const EMPTY_FIELDS: Fields = { houseNo: '', street: '', area: '', city: '', district: '', state: '', pincode: '', landmark: '' };

/** Fields that say WHERE the address is (a change makes an approximate point stale). */
const PLACE_FIELDS: (keyof Fields)[] = ['houseNo', 'street', 'area', 'city', 'district', 'state', 'pincode'];

export default function AddressFormScreen({
  addressId,
  onBack,
}: {
  addressId?: string;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const isEditing = addressId !== undefined;

  // Reuses the same cached list AddressesScreen already fetched — editing
  // opens instantly instead of waiting on a network round trip for data the
  // app already has.
  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<AddressDto[]>('/addresses'),
    enabled: isEditing,
  });
  const existing = addressId ? addresses.data?.find((item) => item.id === addressId) : undefined;

  const [fullName, setFullName] = useState('');
  const [mobile, setMobile] = useState('');
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [addressType, setAddressType] = useState<AddressType>('Home');
  const [isDefault, setIsDefault] = useState(true);
  const [statePickerOpen, setStatePickerOpen] = useState(false);

  const [point, setPoint] = useState<Point | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<{ ok: boolean; message: string } | null>(null);
  /** Address fields read from the GPS point, waiting for the customer to apply them. */
  const [suggestion, setSuggestion] = useState<AddressSuggestion | null>(null);
  const [delivery, setDelivery] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  // Prefill once the address to edit has loaded, without clobbering typing afterwards.
  useEffect(() => {
    if (!existing || seeded) return;
    setFullName(existing.fullName);
    setMobile(existing.mobile);
    setFields({
      houseNo: existing.houseNo ?? '',
      street: existing.street ?? '',
      area: existing.area,
      city: existing.city,
      district: existing.district ?? '',
      state: existing.state,
      pincode: existing.pincode,
      // Older addresses stored "line 2" as both locality and landmark; keep it once.
      landmark: existing.landmark && existing.landmark !== existing.area ? existing.landmark : '',
    });
    setAddressType(ADDRESS_TYPES.includes(existing.label as AddressType) ? (existing.label as AddressType) : 'Other');
    setIsDefault(existing.isDefault);
    setPoint({
      latitude: existing.latitude,
      longitude: existing.longitude,
      source: existing.locationSource,
      accuracyM: existing.locationAccuracyM,
    });
    setSeeded(true);
  }, [existing, seeded]);

  /** Typing changes the address; an APPROXIMATE / unrecorded point for the old text is dropped. */
  function setField(key: keyof Fields, value: string): void {
    setFields((current) => ({ ...current, [key]: value }));
    if (PLACE_FIELDS.includes(key) && point && point.source !== 'GPS') {
      setPoint(null);
      setDelivery(null);
      setLocationNote({ ok: false, message: 'The address changed — set its location again below.' });
    }
  }

  // Every new point gets the server's delivery answer for THAT point.
  useEffect(() => {
    if (!point) return;
    let cancelled = false;
    setDelivery(null);
    api
      .get<ServiceabilityResult>(`/store/serviceability?lat=${point.latitude}&lng=${point.longitude}`)
      .then((result) => {
        if (cancelled) return;
        setDelivery(
          result.serviceable
            ? { ok: true, message: `We deliver here — about ${formatStraightLineDistance(result.distanceKm)} from the nearest store.` }
            : { ok: false, message: `We don't deliver here yet: ${formatStraightLineDistance(result.distanceKm)} away; we deliver up to ${result.maxRadiusKm} km.` },
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setDelivery({ ok: false, message: err instanceof ApiRequestError ? err.message : 'Could not check delivery right now.' });
      });
    return () => {
      cancelled = true;
    };
  }, [point]);

  /** "I'm at this address": a fresh fix + suggested fields (not applied yet). */
  async function useCurrentLocation(): Promise<void> {
    setLocating(true);
    setLocationNote(null);
    setSuggestion(null);
    try {
      const result = await detectDeviceLocation();
      if (result.status !== 'OK') {
        setLocationNote({ ok: false, message: DETECT_MESSAGE[result.status] });
        return;
      }
      setPoint({ latitude: result.latitude, longitude: result.longitude, source: 'GPS', accuracyM: result.accuracyM });
      const suggested = await suggestAddressFor(result.latitude, result.longitude);
      setSuggestion(suggested);
      // Consistency: the point's PIN / district against what was typed.
      const mismatch = [
        suggested?.pincode && isValidPincode(fields.pincode) && suggested.pincode !== fields.pincode ? `PIN ${suggested.pincode}` : null,
        suggested?.district && fields.district.trim() && suggested.district.toLowerCase() !== fields.district.trim().toLowerCase()
          ? `district ${suggested.district}`
          : null,
      ].filter(Boolean);
      setLocationNote({
        ok: result.quality !== 'POOR' && mismatch.length === 0,
        message:
          `Location set from your phone — ${describeAccuracy(result.accuracyM)}.` +
          (result.quality === 'POOR' ? ' That is approximate: make sure you are at this address, or try again outdoors.' : '') +
          (mismatch.length > 0
            ? ` Your phone places you in ${mismatch.join(' / ')}, which differs from the address entered — check that you are at this address.`
            : ''),
      });
    } finally {
      setLocating(false);
    }
  }

  /** Apply the suggested fields: only into empty ones, or replacing everything — the customer chooses. */
  function applySuggestion(mode: 'empty' | 'all'): void {
    if (!suggestion) return;
    setFields((current) => {
      const next = { ...current };
      const put = (key: keyof Fields, value: string | null) => {
        if (value && (mode === 'all' || !current[key].trim())) next[key] = value;
      };
      put('houseNo', suggestion.houseNo);
      put('street', suggestion.street);
      put('area', suggestion.area);
      put('city', suggestion.city);
      put('district', suggestion.district);
      put('state', INDIAN_STATES.find((s) => s.toLowerCase() === suggestion.state?.toLowerCase()) ?? suggestion.state);
      put('pincode', suggestion.pincode);
      return next;
    });
    setSuggestion(null);
  }

  /** The typed address → its APPROXIMATE point (area centre), or an honest failure. */
  async function findFromAddress(): Promise<void> {
    const missing = missingAddressFields(fields);
    if (missing.length > 0) {
      setLocationNote({ ok: false, message: `First fill in: ${missing.map((key) => ADDRESS_FIELD_LABEL[key]).join(', ')}.` });
      return;
    }
    setLocating(true);
    setLocationNote(null);
    setSuggestion(null);
    try {
      const text = [fields.houseNo, fields.street, fields.area, fields.city, fields.district, fields.state, fields.pincode, 'India']
        .map((part) => part.trim())
        .filter(Boolean)
        .join(', ');
      const hit = await geocodeAddressText(text);
      if (!hit || coordinateProblem(hit.latitude, hit.longitude, { requireIndia: true })) {
        setLocationNote({
          ok: false,
          message:
            "This address could not be found on the map. Your details are kept — to set the location, use your current location while you are at this address.",
        });
        return;
      }
      setPoint({ latitude: hit.latitude, longitude: hit.longitude, source: 'GEOCODED', accuracyM: null });
      setLocationNote({
        ok: true,
        message:
          'Approximate location found from the address (the centre of the area, not your door). For exact delivery, use your current location while you are at this address.',
      });
    } finally {
      setLocating(false);
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!point) throw new Error('Set the location of this address first.');
      const body = {
        label: addressType,
        fullName: fullName.trim(),
        mobile,
        houseNo: fields.houseNo.trim() || null,
        street: fields.street.trim() || null,
        area: fields.area.trim(),
        city: fields.city.trim(),
        district: fields.district.trim(),
        state: fields.state,
        pincode: fields.pincode,
        landmark: fields.landmark.trim() || null,
        // The point decides serviceability — always the one confirmed above.
        latitude: point.latitude,
        longitude: point.longitude,
        locationSource: point.source,
        locationAccuracyM: point.source === 'GPS' ? point.accuracyM : null,
        isDefault,
      };
      return isEditing ? api.patch<AddressDto>(`/addresses/${addressId}`, body) : api.post<AddressDto>('/addresses', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses'] });
      onBack();
    },
    onError: (err: Error) => setError(err.message || 'Could not save the address.'),
  });

  const missing = missingAddressFields(fields, { requireArea: true });
  const complete = fullName.trim().length >= 2 && normalizeIndianMobile(mobile) !== null && missing.length === 0 && point !== null;

  const pointSummary = !point
    ? 'Location not set yet.'
    : point.source === 'GPS'
      ? `From your phone at this address — ${describeAccuracy(point.accuracyM)}.`
      : point.source === 'GEOCODED'
        ? 'Approximate — found from the address text, not the exact door.'
        : point.source === 'MAP_PIN'
          ? 'Pin confirmed on the map.'
          : 'Saved earlier; where it came from was not recorded. Set it again to be sure.';

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <View>
          <AppText variant="h3">{isEditing ? 'Edit Address' : 'Add New Address'}</AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            {isEditing ? 'Update your address details' : 'Enter your address details'}
          </AppText>
        </View>
      </View>

      {isEditing && !existing && (
        <View style={{ padding: spacing.base }}>
          <AppText variant="body" color={colors.textSecondary}>
            Loading address…
          </AppText>
        </View>
      )}

      <ScrollView
        contentContainerStyle={{
          padding: spacing.base,
          // The tab bar floats over this screen now (see MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space.
          paddingBottom: tabBarClearance + spacing.xxl,
          gap: spacing.base,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {error && <NoticeStrip message={error} />}

        <Field label="Full Name">
          <Input value={fullName} onChangeText={setFullName} placeholder="Enter full name" />
        </Field>

        <Field label="Phone Number">
          <Input value={mobile} onChangeText={setMobile} placeholder="Enter phone number" keyboardType="phone-pad" maxLength={15} />
        </Field>

        <Field label="House / building / shop no." hint="Optional">
          <Input value={fields.houseNo} onChangeText={(v) => setField('houseNo', v)} placeholder="e.g. 12, Shree Niwas" />
        </Field>

        <Field label="Street / road" hint="Optional">
          <Input value={fields.street} onChangeText={(v) => setField('street', v)} placeholder="e.g. Station Road" />
        </Field>

        <Field label="Locality / mohalla / colony">
          <Input value={fields.area} onChangeText={(v) => setField('area', v)} placeholder="e.g. Shastri Nagar" />
        </Field>

        <Field label="Village / City / Town">
          <Input value={fields.city} onChangeText={(v) => setField('city', v)} placeholder="Your village, or your city / town" />
        </Field>

        <Field label="District">
          <Input value={fields.district} onChangeText={(v) => setField('district', v)} placeholder="e.g. Sikar" />
        </Field>

        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field label="State">
              <Pressable onPress={() => setStatePickerOpen(!statePickerOpen)} style={styles.select}>
                <AppText variant="body" color={fields.state ? colors.textPrimary : colors.textMuted}>
                  {fields.state || 'Select state'}
                </AppText>
                <AppText variant="body" color={colors.textSecondary}>
                  ⌄
                </AppText>
              </Pressable>
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="PIN code">
              <Input
                value={fields.pincode}
                onChangeText={(value) => setField('pincode', value.replace(/\D/g, ''))}
                placeholder="6 digits"
                keyboardType="number-pad"
                maxLength={6}
              />
            </Field>
          </View>
        </View>

        {statePickerOpen && (
          // A plain View clipped the list at maxHeight; it has to be a
          // ScrollView, and on Android a same-axis scroller nested in the
          // form's ScrollView only receives drags with nestedScrollEnabled.
          <ScrollView style={styles.stateList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {INDIAN_STATES.map((item) => (
              <Pressable
                key={item}
                onPress={() => {
                  setField('state', item);
                  setStatePickerOpen(false);
                }}
                style={styles.stateItem}
              >
                <AppText variant="body" color={item === fields.state ? colors.primary : colors.textPrimary}>
                  {item}
                </AppText>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {fields.pincode.length === 6 && !isValidPincode(fields.pincode) && (
          <AppText variant="caption" color={colors.danger}>
            Enter a valid 6-digit PIN code.
          </AppText>
        )}

        <Field label="Landmark" hint="Optional">
          <Input value={fields.landmark} onChangeText={(v) => setField('landmark', v)} placeholder="e.g. Near Shiv Mandir" />
        </Field>

        {/* The point — separate from the text above */}
        <View style={styles.locationBox}>
          <AppText variant="bodyStrong">Delivery location</AppText>
          <AppText variant="caption" color={point?.source === 'GPS' ? colors.primary : colors.textSecondary} style={{ marginTop: spacing.xs }}>
            {pointSummary}
          </AppText>
          <Button
            label={locating ? 'Finding location…' : "Use my current location (I'm at this address)"}
            onPress={() => void useCurrentLocation()}
            disabled={locating}
            style={{ marginTop: spacing.md }}
          />
          <Button
            label="Find location from the address"
            variant="secondary"
            onPress={() => void findFromAddress()}
            disabled={locating}
            style={{ marginTop: spacing.sm }}
          />
          {locationNote && (
            <AppText variant="caption" color={locationNote.ok ? colors.primary : colors.danger} style={{ marginTop: spacing.sm }}>
              {locationNote.message}
            </AppText>
          )}
          {suggestion && (
            <View style={styles.suggestion}>
              <AppText variant="bodyStrong">Address at your location</AppText>
              <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
                {[suggestion.houseNo, suggestion.street, suggestion.area, suggestion.city, suggestion.district, suggestion.state, suggestion.pincode]
                  .filter(Boolean)
                  .join(', ')}
              </AppText>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' }}>
                <Button label="Fill empty fields" variant="secondary" onPress={() => applySuggestion('empty')} />
                <Button label="Replace all" variant="ghost" onPress={() => applySuggestion('all')} />
                <Button label="Ignore" variant="ghost" onPress={() => setSuggestion(null)} />
              </View>
            </View>
          )}
          {delivery && (
            <AppText variant="caption" color={delivery.ok ? colors.primary : colors.danger} style={{ marginTop: spacing.sm }}>
              {delivery.message}
            </AppText>
          )}
        </View>

        {!complete && (missing.length > 0 || !point) && (
          <AppText variant="caption" color={colors.textSecondary}>
            Still needed: {[...missing.map((key) => ADDRESS_FIELD_LABEL[key]), ...(point ? [] : ['Delivery location'])].join(', ')}
          </AppText>
        )}

        <Field label="Address Type">
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            {ADDRESS_TYPES.map((type) => {
              const active = type === addressType;
              return (
                <Pressable
                  key={type}
                  onPress={() => setAddressType(type)}
                  style={[
                    styles.typeChip,
                    active && { borderColor: colors.primary, backgroundColor: colors.primarySurface },
                  ]}
                >
                  <AppText
                    variant="bodyStrong"
                    color={active ? colors.primary : colors.textSecondary}
                  >
                    {type}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </Field>

        <Pressable onPress={() => setIsDefault(!isDefault)} style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <AppText variant="bodyStrong">Make it Default Address</AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              This address will be used as default
            </AppText>
          </View>
          <View style={[styles.toggle, isDefault && { backgroundColor: colors.primary }]}>
            <View style={[styles.toggleKnob, isDefault && { alignSelf: 'flex-end' }]} />
          </View>
        </Pressable>

        <Button
          label={isEditing ? 'Save Changes' : 'Save Address'}
          onPress={() => save.mutate()}
          loading={save.isPending}
          disabled={!complete}
        />
      </ScrollView>
    </Screen>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View>
      <AppText variant="bodyStrong" style={{ marginBottom: spacing.xs }}>
        {label}
        {hint && (
          <AppText variant="body" color={colors.textSecondary}>
            {' '}
            ({hint})
          </AppText>
        )}
      </AppText>
      {children}
    </View>
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
  locationBox: {
    padding: spacing.base,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  suggestion: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted,
  },
  select: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  stateList: {
    maxHeight: 260,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  stateItem: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.base,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  typeChip: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    minHeight: 56,
  },
  toggle: {
    width: 52,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    padding: 3,
    justifyContent: 'center',
  },
  toggleKnob: {
    width: 24,
    height: 24,
    borderRadius: radius.circle,
    backgroundColor: colors.surface,
  },
});
