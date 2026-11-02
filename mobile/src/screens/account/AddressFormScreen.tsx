/**
 * Add / Edit Address (Task 14.13) — "Enter Address Manually", and "Confirm
 * your address" for a GPS location (live mode).
 *
 * WHERE AADIONE DELIVERS is the admin's list of approved villages, each with
 * its own PIN code (Configuration → Approved Delivery Villages; the app reads
 * the active ones from GET /store/delivery-locations). So:
 *   - Village / Town / City is a DROPDOWN of the active approved villages;
 *   - PIN Code is a dropdown of THAT village's approved PIN codes only;
 *   - an arbitrary village + PIN can never be entered — and the server checks
 *     every saved address and order against the list again anyway.
 *
 * Fields: Full Name, Mobile Number, House / Flat Number (optional), Street /
 * Road (optional), Locality (optional), Village / Town / City, District,
 * PIN Code, Landmark (optional), State, Address Type, Make Default. Each is
 * its own existing column.
 *
 * THE POINT. There is no map step. A GPS location keeps the phone's own fix.
 * A typed address is placed on the map quietly when it is saved (the OS
 * geocoder, accepting only a result that names the chosen village with no
 * other PIN / district — @/lib/deviceLocation findAddressCandidates); when
 * that finds nothing, no point is sent and the server uses the admin service
 * location as an approximate one. The point only prices the delivery fee and
 * ETA — it never decides whether Aadione delivers.
 *
 * LIVE MODE: the geocoded village + PIN prefill the dropdowns only when they
 * are EXACTLY an approved pair; otherwise the customer chooses (never a
 * silently substituted nearby village). The order goes to the GPS point.
 */

import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddressDto, LiveLocationInput } from '@shared';
import { normalizeIndianMobile } from '@shared/phone';
import { formatAddressLines } from '@shared/address';
import { placeChanged, type LocationSource } from '@shared/location';
import { colors, radius, spacing } from '@shared/theme';
import { api } from '@/lib/api';
import { findAddressCandidates } from '@/lib/deviceLocation';
import { matchApprovedPair, pincodesFor } from '@/lib/deliveryLocations';
import { useDeliveryLocations } from '@/lib/useDeliveryLocations';
import { HOME_STATE, liveLocationLabel, liveState } from '@/lib/liveLocation';
import { useAuth, useLocation } from '@/lib/store';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Button, Input, NoticeStrip, Screen } from '@/components/ui';
import { OptionPicker } from '@/components/OptionPicker';
import type { LiveFixParams } from '@/navigation/types';

/** Address Type chips from the mockup. Stored in `label`. */
const ADDRESS_TYPES = ['Home', 'Work', 'Other'] as const;
type AddressType = (typeof ADDRESS_TYPES)[number];

/** A new address's state, prefilled for convenience (where Aadione operates today) — editable. */
const FIXED_STATE = HOME_STATE;

/** The columns' limits (backend addresses API). */
const HOUSE_NO_MAX = 80;
const STREET_MAX = 160;
const LANDMARK_MAX = 160;

/** A GPS location's point (live mode). */
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
  landmark: string;
  pincode: string;
};

const EMPTY_FIELDS: Fields = { houseNo: '', street: '', area: '', city: '', district: '', landmark: '', pincode: '' };

export default function AddressFormScreen({
  addressId,
  live,
  onBack,
  onLiveConfirmed,
  selectWhenSaved = false,
}: {
  addressId?: string;
  /**
   * LIVE MODE — "Confirm your address" for a fresh GPS fix: the order goes to
   * this point directly, without saving an address (unless the customer
   * ticks "Save this address"). Fields come from the reverse geocoder and the
   * verified profile; the village + PIN only when exactly approved.
   */
  live?: LiveFixParams;
  onBack: () => void;
  /** Live mode: after "Deliver to this address" — back to where it began. */
  onLiveConfirmed?: () => void;
  /**
   * Opened from checkout: a NEW address saved here becomes the one the order
   * goes to (and Home's location), so the Cart shows it straight away.
   */
  selectWhenSaved?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const isEditing = addressId !== undefined;
  const isLive = live !== undefined && !isEditing;
  const user = useAuth((s) => s.user);
  const { liveDestination, setLiveDestination, setLocation, selectAddress } = useLocation();
  const locations = useDeliveryLocations();
  const villages = useMemo(() => locations.data ?? [], [locations.data]);

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
  /** A saved address's own state; a new one starts as FIXED_STATE. Editable. */
  const [state, setState] = useState(FIXED_STATE);
  const [addressType, setAddressType] = useState<AddressType>('Home');
  const [isDefault, setIsDefault] = useState(true);
  const [point, setPoint] = useState<Point | null>(null);
  /** Live mode: the village + PIN the phone read, when they are not an approved pair. */
  const [unmatched, setUnmatched] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  /* --- live mode ------------------------------------------------------- */
  /** Off by default: a live location is for this order only. */
  const [saveAsAddress, setSaveAsAddress] = useState(false);

  // Live mode: prefill once (after the approved list has loaded) from the GPS
  // fix's geocoded address and the VERIFIED profile (or the details confirmed
  // for this point before). Missing parts stay empty — nothing is made up.
  useEffect(() => {
    if (!isLive || !live || seeded || locations.isPending) return;
    const s = live.suggestion;
    const previous =
      liveDestination && liveDestination.latitude === live.latitude && liveDestination.longitude === live.longitude
        ? liveDestination
        : null;
    setFullName(previous?.fullName ?? user?.fullName ?? '');
    // The account's number only when it was verified by OTP.
    setMobile(previous?.mobile ?? (user?.mobileVerified ? user.mobile : ''));
    // The village + PIN only when EXACTLY an approved pair — never a nearby one.
    const match =
      matchApprovedPair(villages, previous?.city, previous?.pincode) ?? matchApprovedPair(villages, s?.city, s?.pincode);
    const read = [s?.city, s?.pincode].filter(Boolean).join(' ');
    setUnmatched(match ? null : read || null);
    setFields({
      houseNo: previous?.houseNo ?? s?.houseNo ?? '',
      street: previous?.street ?? s?.street ?? '',
      area: previous?.area ?? s?.area ?? '',
      city: match?.village ?? '',
      district: previous?.district ?? s?.district ?? '',
      landmark: '',
      pincode: match?.pincode ?? '',
    });
    setState(previous?.state || liveState(s?.state, live.latitude, live.longitude));
    setPoint({ latitude: live.latitude, longitude: live.longitude, source: 'GPS', accuracyM: live.accuracyM });
    setSeeded(true);
  }, [isLive, live, seeded, liveDestination, user, villages, locations.isPending]);

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
      landmark: existing.landmark ?? '',
      pincode: existing.pincode,
    });
    setState(existing.state.trim() || FIXED_STATE);
    setAddressType(ADDRESS_TYPES.includes(existing.label as AddressType) ? (existing.label as AddressType) : 'Other');
    setIsDefault(existing.isDefault);
    setSeeded(true);
  }, [existing, seeded]);

  function setField(key: keyof Fields, value: string): void {
    setFields((current) => ({ ...current, [key]: value }));
  }

  /** A village chosen from the dropdown: its only PIN is chosen with it; a PIN of another village is cleared. */
  function chooseVillage(village: string): void {
    const pins = pincodesFor(villages, village);
    setFields((current) => ({
      ...current,
      city: village,
      pincode: pins.includes(current.pincode) ? current.pincode : pins.length === 1 ? pins[0]! : '',
    }));
    setUnmatched(null);
  }

  const villageOptions = useMemo(() => villages.map((v) => v.village), [villages]);
  const pinOptions = useMemo(() => pincodesFor(villages, fields.city), [villages, fields.city]);
  /** The chosen village + PIN is an active approved pair (the server checks again). */
  const pair = matchApprovedPair(villages, fields.city, fields.pincode);

  const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
  const houseNo = clean(fields.houseNo);
  const street = clean(fields.street);
  const landmark = clean(fields.landmark);

  /**
   * A typed address's point, placed quietly on the map — only a result naming
   * the chosen village (no other PIN / district). Null when the map finds
   * nothing: the server then uses the admin service location (approximate).
   */
  async function placeOnMap(): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const result = await findAddressCandidates({
        houseNo,
        street,
        area: fields.area,
        city: fields.city,
        district: fields.district,
        state,
        pincode: fields.pincode,
      });
      const best = result.status === 'FOUND' ? result.usable[0] : undefined;
      return best ? { latitude: best.latitude, longitude: best.longitude } : null;
    } catch {
      return null;
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!pair) throw new Error('Choose your village / town and its PIN code from the lists.');
      // A new address, or an edit to another place: place it on the map again.
      const needsPoint =
        !isEditing ||
        (existing !== undefined &&
          placeChanged(existing, { city: pair.village, district: fields.district, state, pincode: pair.pincode }));
      const placed = needsPoint ? await placeOnMap() : null;
      const body = {
        label: addressType,
        fullName: fullName.trim(),
        mobile,
        houseNo: houseNo || null,
        street: street || null,
        landmark: landmark || null,
        area: fields.area.trim(),
        city: pair.village,
        district: fields.district.trim(),
        state: state.trim(),
        pincode: pair.pincode,
        ...(placed ? { ...placed, locationSource: 'GEOCODED' as const } : {}),
        isDefault,
      };
      return isEditing ? api.patch<AddressDto>(`/addresses/${addressId}`, body) : api.post<AddressDto>('/addresses', body);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['addresses'] });
      // From checkout: the new address is the one the order goes to — the
      // same selection the Cart's address picker makes.
      if (selectWhenSaved && !isEditing && saved) {
        selectAddress(saved.id);
        const lines = formatAddressLines(saved);
        void setLocation({
          latitude: saved.latitude,
          longitude: saved.longitude,
          label: [lines.line1, saved.city, saved.pincode].filter(Boolean).join(', '),
          source: 'ADDRESS',
          village: saved.city,
          pincode: saved.pincode,
        });
      }
      onBack();
    },
    onError: (err: Error) => setError(err.message || 'Could not save the address.'),
  });

  /**
   * Live mode's "Deliver to this address": the order goes to THIS point with
   * these details — kept in the location store (not saved anywhere) and sent
   * as `liveLocation` at checkout. With "Save this address" ticked, it is
   * saved as an address first and ordered to as one.
   */
  const confirmLive = useMutation({
    mutationFn: async () => {
      if (!point) throw new Error('Your current location is not available. Go back and tap “Use Current Location” to try again.');
      if (!pair) throw new Error('Choose your village / town and its PIN code from the lists.');
      const normalizedMobile = normalizeIndianMobile(mobile);
      if (!normalizedMobile) throw new Error('Enter a valid 10-digit mobile number.');
      const destination: LiveLocationInput = {
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyM: point.accuracyM,
        fullName: fullName.trim(),
        mobile: normalizedMobile,
        houseNo: houseNo || null,
        street: street || null,
        area: fields.area.trim() || null,
        city: pair.village,
        district: fields.district.trim() || null,
        state: state.trim(),
        pincode: pair.pincode,
      };

      if (saveAsAddress) {
        const saved = await api.post<AddressDto>('/addresses', {
          label: addressType,
          fullName: destination.fullName,
          mobile: destination.mobile,
          houseNo: destination.houseNo,
          street: destination.street,
          landmark: landmark || null,
          area: fields.area.trim(),
          city: destination.city,
          district: fields.district.trim(),
          state: destination.state,
          pincode: destination.pincode,
          latitude: point.latitude,
          longitude: point.longitude,
          locationSource: 'GPS',
          locationAccuracyM: point.accuracyM,
          isDefault: false,
        });
        void queryClient.invalidateQueries({ queryKey: ['addresses'] });
        selectAddress(saved.id);
        void setLocation({
          latitude: saved.latitude,
          longitude: saved.longitude,
          label: liveLocationLabel(destination),
          source: 'ADDRESS',
          village: saved.city,
          pincode: saved.pincode,
        });
        return;
      }

      // Order matters: the details first, then the point they belong to.
      setLiveDestination(destination);
      void setLocation({
        latitude: destination.latitude,
        longitude: destination.longitude,
        label: liveLocationLabel(destination),
        source: 'GPS',
        accuracyM: destination.accuracyM,
        village: destination.city,
        pincode: destination.pincode,
      });
    },
    onSuccess: () => (onLiveConfirmed ?? onBack)(),
    onError: (err: Error) => setError(err.message || 'Could not use this location.'),
  });

  /** A saved address needs its district; a live order only who, the village + PIN and the state. */
  const needsDistrict = !isLive || saveAsAddress;
  /** A number was typed that is not a valid Indian mobile number. */
  const mobileInvalid = mobile.replace(/\D/g, '').length >= 10 && normalizeIndianMobile(mobile) === null;
  const missing = [
    ...(fullName.trim().length >= 2 ? [] : ['Full Name']),
    ...(normalizeIndianMobile(mobile) !== null ? [] : ['Mobile Number']),
    ...(fields.city ? [] : ['Village / Town / City']),
    ...(fields.city && !pair ? ['PIN Code'] : []),
    ...(!needsDistrict || fields.district.trim().length >= 2 ? [] : ['District']),
    ...(state.trim().length >= 2 ? [] : ['State']),
  ];
  const complete = missing.length === 0 && (!isLive || point !== null);
  /** An older address whose village + PIN is no longer approved. */
  const existingNotApproved = isEditing && existing !== undefined && seeded && !locations.isPending && !matchApprovedPair(villages, existing.city, existing.pincode);
  const optional = 'Optional';

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <View>
          <AppText variant="h3">{isLive ? 'Confirm your address' : isEditing ? 'Edit Address' : 'Enter Address Manually'}</AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            {isLive
              ? 'Check the address found from your location and fill in anything missing'
              : isEditing
                ? 'Update your address details'
                : 'Tell us who receives the order and where to deliver it'}
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

      {/* Shrinks the scroll area by whatever the keyboard covers (0 when the
          window has already been resized for it), so every field and Save
          can be scrolled into view while typing. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          contentContainerStyle={{
            padding: spacing.base,
            // The tab bar floats over this screen now (see MainTabs.tsx's
            // `AnimatedTabBar`) rather than reserving its own flex space.
            paddingBottom: tabBarClearance + spacing.xl,
            gap: spacing.md,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {error && <NoticeStrip message={error} />}
          {locations.isError && (
            <NoticeStrip message="We couldn't load the villages we deliver to. Check your internet connection and try again." />
          )}

          {isLive && !live?.suggestion && (
            <NoticeStrip
              tone="info"
              message="Your location was found, but its address could not be read. Please choose your village / town and PIN code and fill in the other details below."
            />
          )}
          {isLive && live?.suggestion && unmatched && (
            <NoticeStrip
              tone="info"
              message={`Your location reads as ${unmatched}, which is not on our delivery list. If you are in one of our delivery villages, choose it and its PIN code below.`}
            />
          )}
          {isLive && live?.quality === 'POOR' && (
            <NoticeStrip message="Your phone could only find an approximate location. For exact delivery, try again outdoors." />
          )}
          {existingNotApproved && (
            <NoticeStrip message={`We don't deliver to ${existing!.city} ${existing!.pincode} at the moment. Choose one of our delivery villages and its PIN code to order to this address.`} />
          )}

          <Field label="Full Name">
            <Input value={fullName} onChangeText={setFullName} placeholder="Name of the person receiving the order" autoCapitalize="words" />
          </Field>

          <Field label="Mobile Number">
            <Input value={mobile} onChangeText={setMobile} placeholder="10-digit mobile number" keyboardType="phone-pad" maxLength={15} />
          </Field>
          {mobileInvalid && (
            <AppText variant="caption" color={colors.danger}>
              Enter a valid 10-digit mobile number.
            </AppText>
          )}

          <Field label="House / Flat Number" hint={optional}>
            <Input
              value={fields.houseNo}
              onChangeText={(v) => setField('houseNo', v)}
              placeholder="Enter your house number, e.g. 12 or B-4"
              autoCapitalize="words"
              maxLength={HOUSE_NO_MAX}
            />
          </Field>

          <Field label="Street / Road" hint={optional}>
            <Input
              value={fields.street}
              onChangeText={(v) => setField('street', v)}
              placeholder="Enter your street, e.g. Station Road"
              autoCapitalize="words"
              // An older address can be longer when left as it was.
              maxLength={Math.max(STREET_MAX, existing?.street?.length ?? 0)}
            />
          </Field>

          <Field label="Locality / Mohalla / Colony" hint={optional}>
            <Input value={fields.area} onChangeText={(v) => setField('area', v)} placeholder="Enter your locality, e.g. Shastri Nagar" autoCapitalize="words" />
          </Field>

          <Field label="Village / Town / City">
            <OptionPicker
              value={fields.city}
              options={villageOptions}
              placeholder={locations.isPending ? 'Loading villages…' : 'Choose your village or town'}
              title="Choose your village / town"
              onChange={chooseVillage}
              disabled={locations.isPending || villageOptions.length === 0}
              emptyText="We are not delivering to any village yet."
            />
          </Field>
          {!locations.isPending && !locations.isError && villageOptions.length === 0 && (
            <AppText variant="caption" color={colors.danger}>
              We are not delivering to any village yet.
            </AppText>
          )}

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Field label="District" hint={needsDistrict ? undefined : optional}>
                <Input value={fields.district} onChangeText={(v) => setField('district', v)} placeholder="e.g. Rajsamand" autoCapitalize="words" />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="PIN Code">
                <OptionPicker
                  value={fields.pincode}
                  options={pinOptions}
                  placeholder={fields.city ? 'Choose PIN' : 'Village first'}
                  title={fields.city ? `PIN code for ${fields.city}` : 'PIN code'}
                  onChange={(value) => setField('pincode', value)}
                  disabled={!fields.city || pinOptions.length === 0}
                  emptyText="Choose your village first."
                />
              </Field>
            </View>
          </View>

          {/* A landmark is kept with a SAVED address (a live location is for
              this order only and has no landmark of its own). */}
          {(!isLive || saveAsAddress) && (
            <Field label="Landmark" hint={optional}>
              <Input
                value={fields.landmark}
                onChangeText={(v) => setField('landmark', v)}
                placeholder="Add a nearby landmark (optional), e.g. near Shiv Mandir"
                autoCapitalize="sentences"
                maxLength={Math.max(LANDMARK_MAX, existing?.landmark?.length ?? 0)}
              />
            </Field>
          )}

          {/* Address text only — delivery is decided by the approved village + PIN. */}
          <Field label="State">
            <Input value={state} onChangeText={setState} placeholder="Enter your state" autoCapitalize="words" maxLength={80} />
          </Field>

          {!complete && missing.length > 0 && (
            <AppText variant="caption" color={colors.textSecondary}>
              Still needed: {missing.join(', ')}
            </AppText>
          )}

          {/* Live mode: saving is the customer's explicit choice, off by default. */}
          {isLive && (
            <Pressable
              onPress={() => setSaveAsAddress(!saveAsAddress)}
              style={styles.toggleRow}
              accessibilityRole="switch"
              accessibilityState={{ checked: saveAsAddress }}
            >
              <View style={{ flex: 1 }}>
                <AppText variant="bodyStrong">Save this address for next time</AppText>
                <AppText variant="caption" color={colors.textSecondary}>
                  {saveAsAddress
                    ? 'Saved to your addresses — needs the district.'
                    : 'Not needed to order — this location is used for this order only.'}
                </AppText>
              </View>
              <View style={[styles.toggle, saveAsAddress && { backgroundColor: colors.primary }]}>
                <View style={[styles.toggleKnob, saveAsAddress && { alignSelf: 'flex-end' }]} />
              </View>
            </Pressable>
          )}

          {(!isLive || saveAsAddress) && (
            <Field label="Address Type">
              <View style={styles.row}>
                {ADDRESS_TYPES.map((type) => {
                  const active = type === addressType;
                  return (
                    <Pressable
                      key={type}
                      onPress={() => setAddressType(type)}
                      style={[styles.typeChip, active && { borderColor: colors.primary, backgroundColor: colors.primarySurface }]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                    >
                      <AppText variant="bodyStrong" color={active ? colors.primary : colors.textSecondary}>
                        {type}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
            </Field>
          )}

          {!isLive && (
            <Pressable
              onPress={() => setIsDefault(!isDefault)}
              style={styles.toggleRow}
              accessibilityRole="switch"
              accessibilityState={{ checked: isDefault }}
            >
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
          )}

          {isLive ? (
            <Button
              label={saveAsAddress ? 'Save Address' : 'Deliver to this address'}
              onPress={() => confirmLive.mutate()}
              loading={confirmLive.isPending}
              disabled={!complete}
            />
          ) : (
            <Button
              label={isEditing ? 'Save Changes' : 'Save Address'}
              onPress={() => save.mutate()}
              loading={save.isPending}
              disabled={!complete}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
  row: { flexDirection: 'row', gap: spacing.md },
  typeChip: {
    flex: 1,
    minHeight: 48,
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
    minHeight: 52,
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
