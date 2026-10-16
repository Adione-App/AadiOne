/**
 * Add / Edit Address (Task 14.13) — an Indian address in its own fields:
 * house no. + street (one field), locality, village / city / town, district,
 * state (Rajasthan — the only state served), PIN — and, SEPARATELY, the point
 * the address is delivered to.
 *
 * HOUSE NO. + STREET is one field over the two existing columns, with no
 * migration: new or edited text is stored whole in `street` (houseNo null);
 * an older address that filled both is shown joined and, while the text is
 * left as it was, neither column is sent — so it is never rewritten. Landmark
 * is no longer collected; an existing one is never sent, so it is kept.
 *
 * WHERE THE POINT COMES FROM — two ways, both checked against the typed
 * village / district / state / PIN (@shared/location checkPointAgainstAddress):
 *   - "Use my current location": one fresh GPS fix, for when the customer is
 *     AT the address. Its geocoded place fills only EMPTY fields; when it
 *     names a different PIN, district or state than what was typed, the
 *     customer must confirm (an address for somewhere else must not get the
 *     phone's position).
 *   - "Find this address": the full typed address is forward-geocoded
 *     (@/lib/deviceLocation findAddressCandidates). Results naming another
 *     PIN / district / state are rejected; the rest are offered for the
 *     customer to choose — never the first one silently. Such a point is the
 *     centre of the area the geocoder matched: saved as GEOCODED, with no
 *     accuracy, and shown as approximate.
 * Nothing else is ever used: not the app's current location, not a city
 * centre, not (0, 0); a failure sets nothing.
 *
 * A point belongs to the PLACE it was confirmed for. Changing the village /
 * district / state / PIN afterwards (also when editing) invalidates it until
 * it is confirmed again; house / street edits keep it. The server enforces
 * the same rule. Serviceability is decided by the server on save, checkout
 * and order placement — this screen shows no distance.
 */

import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddressDto, LiveLocationInput } from '@shared';
import { normalizeIndianMobile } from '@shared/phone';
import { ADDRESS_FIELD_LABEL, isValidPincode, missingAddressFields } from '@shared/address';
import {
  DETECT_MESSAGE,
  checkPointAgainstAddress,
  describeAccuracy,
  describeFoundPlace,
  placeChanged,
  type AddressPlaceFields,
  type DetectStatus,
  type GeocodeCandidate,
  type LocationSource,
} from '@shared/location';
import { colors, radius, spacing } from '@shared/theme';
import { api } from '@/lib/api';
import { houseAndStreet } from '@/lib/addressDisplay';
import { detectDeviceLocation, findAddressCandidates, mapPreviewUrl, suggestAddressFor } from '@/lib/deviceLocation';
import { HOME_STATE, isHomeState, liveLocationLabel, liveState, stateFromGeocoder } from '@/lib/liveLocation';
import { useAuth, useLocation } from '@/lib/store';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, Button, Input, NoticeStrip, Screen } from '@/components/ui';
import type { LiveFixParams } from '@/navigation/types';

/** Address Type chips from the mockup. Stored in `label`. */
const ADDRESS_TYPES = ['Home', 'Work', 'Other'] as const;
type AddressType = (typeof ADDRESS_TYPES)[number];

/** Aadione delivers in Rajasthan only, so a saved address's state is fixed. */
const FIXED_STATE = HOME_STATE;

/** The `street` column's limit — the combined field is stored there. */
const HOUSE_STREET_MAX = 160;

/** The point this address is delivered to. `source` null = saved before origins were recorded. */
interface Point {
  latitude: number;
  longitude: number;
  source: LocationSource | null;
  accuracyM: number | null;
  /** Captured on this screen just now (not loaded from the saved address). */
  fresh: boolean;
}

type Fields = {
  houseStreet: string;
  area: string;
  city: string;
  district: string;
  pincode: string;
};

const EMPTY_FIELDS: Fields = { houseStreet: '', area: '', city: '', district: '', pincode: '' };

export default function AddressFormScreen({
  addressId,
  live,
  onBack,
  onLiveConfirmed,
}: {
  addressId?: string;
  /**
   * LIVE MODE — "Delivery details" for a fresh GPS fix: the order goes to
   * this point directly, without saving an address (unless the customer
   * ticks "Also save"). Fields come only from the reverse geocoder and the
   * verified profile; whatever is missing the customer fills in.
   */
  live?: LiveFixParams;
  onBack: () => void;
  /** Live mode: after "Deliver to this location" — back to where it began. */
  onLiveConfirmed?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();
  const isEditing = addressId !== undefined;
  const isLive = live !== undefined && !isEditing;
  const user = useAuth((s) => s.user);
  const { liveDestination, setLiveDestination, setLocation, selectAddress } = useLocation();

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
  /** A saved address keeps its own state; new ones are Rajasthan. Never editable here. */
  const [state, setState] = useState(FIXED_STATE);
  /** The combined text as loaded — unchanged means houseNo / street are left alone. */
  const [originalHouseStreet, setOriginalHouseStreet] = useState('');
  const [addressType, setAddressType] = useState<AddressType>('Home');
  const [isDefault, setIsDefault] = useState(true);

  const [point, setPoint] = useState<Point | null>(null);
  /** The village / district / state / PIN the point was confirmed for. */
  const [pointPlace, setPointPlace] = useState<AddressPlaceFields | null>(null);
  /** Set when the point's place differs from the typed one: the customer must confirm. */
  const [confirmPoint, setConfirmPoint] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ usable: GeocodeCandidate[]; rejected: GeocodeCandidate[]; message: string | null } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<{ status: Exclude<DetectStatus, 'OK'>; message: string } | null>(null);
  const [locationNote, setLocationNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  /* --- live mode ------------------------------------------------------- */
  /** Off by default: a live location is for this order only. */
  const [saveAsAddress, setSaveAsAddress] = useState(false);

  // Live mode: prefill once from the GPS fix's geocoded address and the
  // VERIFIED profile (or the details confirmed for this point before).
  // Missing parts stay empty for the customer — nothing is made up.
  useEffect(() => {
    if (!isLive || !live || seeded) return;
    const s = live.suggestion;
    const previous =
      liveDestination && liveDestination.latitude === live.latitude && liveDestination.longitude === live.longitude
        ? liveDestination
        : null;
    setFullName(previous?.fullName ?? user?.fullName ?? '');
    // The account's number only when it was verified by OTP.
    setMobile(previous?.mobile ?? (user?.mobileVerified ? user.mobile : ''));
    setFields({
      houseStreet: s ? houseAndStreet(s) : '',
      area: s?.area ?? '',
      city: s?.city ?? '',
      district: s?.district ?? '',
      pincode: s?.pincode ?? '',
    });
    setState(liveState(s?.state, live.latitude, live.longitude));
    setPoint({ latitude: live.latitude, longitude: live.longitude, source: 'GPS', accuracyM: live.accuracyM, fresh: true });
    setSeeded(true);
  }, [isLive, live, seeded, liveDestination, user]);

  // Prefill once the address to edit has loaded, without clobbering typing afterwards.
  useEffect(() => {
    if (!existing || seeded) return;
    const houseStreet = houseAndStreet(existing);
    setFullName(existing.fullName);
    setMobile(existing.mobile);
    setFields({
      houseStreet,
      area: existing.area,
      city: existing.city,
      district: existing.district ?? '',
      pincode: existing.pincode,
    });
    setOriginalHouseStreet(houseStreet);
    setState(existing.state.trim() || FIXED_STATE);
    setAddressType(ADDRESS_TYPES.includes(existing.label as AddressType) ? (existing.label as AddressType) : 'Other');
    setIsDefault(existing.isDefault);
    setPoint({
      latitude: existing.latitude,
      longitude: existing.longitude,
      source: existing.locationSource,
      accuracyM: existing.locationAccuracyM,
      fresh: false,
    });
    // The saved point stays valid for exactly the place it was saved with.
    setPointPlace({ city: existing.city, district: existing.district, state: existing.state, pincode: existing.pincode });
    setSeeded(true);
  }, [existing, seeded]);

  /** Text only — but see `pointStale`: a different place invalidates the point. */
  function setField(key: keyof Fields, value: string): void {
    setFields((current) => ({ ...current, [key]: value }));
    setFound(null);
  }

  /** The place the customer has typed now. */
  const typedPlace: AddressPlaceFields = { city: fields.city, district: fields.district, state, pincode: fields.pincode };
  /**
   * The point was confirmed for another village / district / state / PIN than
   * the one typed now: it cannot be saved with this address until confirmed
   * again (live mode keeps its GPS point — the customer is there).
   */
  const pointStale = !isLive && point !== null && pointPlace !== null && placeChanged(pointPlace, typedPlace);

  /**
   * "Find this address": forward-geocode the full typed address and offer the
   * results that agree with it. Nothing is chosen for the customer.
   */
  async function findThisAddress(): Promise<void> {
    setFinding(true);
    setFound(null);
    setLocationError(null);
    setLocationNote(null);
    try {
      const result = await findAddressCandidates({ street: fields.houseStreet, area: fields.area, ...typedPlace });
      const message =
        result.status === 'FAILED'
          ? 'The map service could not be reached. Check your connection and try again — or, if you are at this address, use your current location.'
          : result.usable.length === 0
            ? result.rejected.length > 0
              ? `The map found only ${result.rejected.map((r) => describeFoundPlace(r.place)).join('; ')} — not the village / PIN you entered. Check the address, or use your current location if you are there.`
              : 'This address could not be found on the map. Check the village, district and PIN — or, if you are at this address, use your current location.'
            : null;
      setFound({ usable: result.usable, rejected: result.rejected, message });
    } finally {
      setFinding(false);
    }
  }

  /** The customer chose one of the found results. */
  function useFoundLocation(candidate: GeocodeCandidate): void {
    setPoint({ latitude: candidate.latitude, longitude: candidate.longitude, source: 'GEOCODED', accuracyM: null, fresh: true });
    setPointPlace(typedPlace);
    setConfirmPoint(null);
    setFound(null);
    setLocationNote({
      ok: true,
      message: 'Approximate location found from the address — the centre of that area, not your exact door. The delivery partner also uses your address and phone number.',
    });
  }

  /**
   * ADD mode only (a new address has no point yet): one fresh fix at the
   * address; its reverse-geocoded text fills only the empty fields. Edit and
   * live modes keep the point they were opened with.
   */
  async function useCurrentLocation(): Promise<void> {
    setLocating(true);
    setLocationError(null);
    setLocationNote(null);
    try {
      const result = await detectDeviceLocation();
      if (result.status !== 'OK') {
        // No fallback point: whatever was set before stays, nothing is invented.
        setLocationError({ status: result.status, message: DETECT_MESSAGE[result.status] });
        return;
      }
      setPoint({ latitude: result.latitude, longitude: result.longitude, source: 'GPS', accuracyM: result.accuracyM, fresh: true });
      setFound(null);
      setConfirmPoint(null);

      const suggested = await suggestAddressFor(result.latitude, result.longitude);
      // Where the phone says this point is, when that is not Rajasthan.
      const gpsState = stateFromGeocoder(suggested?.state);
      const outsideHomeState = gpsState !== null && !isHomeState(gpsState);
      const fill: Partial<Fields> = {};
      if (suggested) {
        const offered: Fields = {
          houseStreet: houseAndStreet(suggested),
          area: suggested.area ?? '',
          city: suggested.city ?? '',
          district: suggested.district ?? '',
          pincode: suggested.pincode ?? '',
        };
        for (const key of Object.keys(offered) as (keyof Fields)[]) {
          if (offered[key] && !fields[key].trim()) fill[key] = offered[key];
        }
        // Re-checked against the latest state: anything typed meanwhile wins.
        setFields((current) => {
          const next = { ...current };
          for (const key of Object.keys(fill) as (keyof Fields)[]) {
            if (!current[key].trim()) next[key] = fill[key]!;
          }
          return next;
        });
      }
      const filled = Object.keys(fill);

      // Is the phone actually AT the typed address? Compared on what was
      // typed (plus anything just filled): a different PIN / district / state
      // must be confirmed — an address for another village must not quietly
      // get the phone's position. A different village name alone is only
      // noted (geocoders name areas coarsely).
      const merged = { ...fields, ...fill };
      const place: AddressPlaceFields = { city: merged.city, district: merged.district, state, pincode: merged.pincode };
      setPointPlace(place);
      const check = checkPointAgainstAddress(place, suggested);
      if (check.verdict === 'MISMATCH') {
        setConfirmPoint(
          `Your phone places you in ${describeFoundPlace(suggested)} — not the address entered above. If this address is somewhere else, use “Find this address” instead. Only confirm if you are at this address now.`,
        );
      }
      const notes = [
        check.verdict === 'CONFLICT'
          ? `The map names this spot ${suggested?.city ?? 'differently'} — make sure you are at the address entered above.`
          : null,
        // The server refuses it too; say it here first.
        outsideHomeState
          ? `Your phone places you in ${gpsState}. Aadione currently delivers only in Rajasthan, so this location cannot be saved.`
          : null,
        filled.length > 0 ? 'Empty fields were filled from your location — please check them.' : null,
        result.quality === 'POOR' ? 'Your phone could only find an approximate location. For exact delivery, try again outdoors.' : null,
      ].filter(Boolean);
      setLocationNote(
        notes.length > 0 ? { ok: result.quality !== 'POOR' && !outsideHomeState, message: notes.join(' ') } : null,
      );
    } finally {
      setLocating(false);
    }
  }

  const houseStreet = fields.houseStreet.trim().replace(/\s+/g, ' ');
  const houseStreetChanged = houseStreet !== originalHouseStreet;

  const save = useMutation({
    mutationFn: async () => {
      if (!point) throw new Error('Set where this address is: find it on the map, or use your current location while you are there.');
      if (pointStale) throw new Error('You changed the village, district or PIN — confirm where the address is again before saving.');
      if (confirmPoint) throw new Error('Confirm that you are at this address, or find the address on the map instead.');
      if (houseStreetChanged && houseStreet.length > HOUSE_STREET_MAX) {
        throw new Error(`Keep House No. + Street / Road under ${HOUSE_STREET_MAX} characters.`);
      }
      const body = {
        label: addressType,
        fullName: fullName.trim(),
        mobile,
        // Left out while unchanged, so an older address keeps its own two columns.
        ...(isEditing && !houseStreetChanged ? {} : { houseNo: null, street: houseStreet || null }),
        area: fields.area.trim(),
        city: fields.city.trim(),
        district: fields.district.trim(),
        state,
        pincode: fields.pincode,
        // The point decides serviceability — always the one shown on this screen.
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

  /**
   * Live mode's "Deliver to this location": the order goes to THIS point
   * with these details — kept in the location store (not saved anywhere)
   * and sent as `liveLocation` at checkout. With "Also save" ticked, it is
   * saved as an address first and ordered to as one.
   */
  const confirmLive = useMutation({
    mutationFn: async () => {
      if (!point) throw new Error('Your current location is not available. Tap “Use my current location” to try again.');
      if (houseStreet.length > HOUSE_STREET_MAX) throw new Error(`Keep House No. + Street / Road under ${HOUSE_STREET_MAX} characters.`);
      const normalizedMobile = normalizeIndianMobile(mobile);
      if (!normalizedMobile) throw new Error('Enter a valid 10-digit mobile number.');
      const destination: LiveLocationInput = {
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyM: point.accuracyM,
        fullName: fullName.trim(),
        mobile: normalizedMobile,
        houseNo: null,
        street: houseStreet || null,
        area: fields.area.trim() || null,
        city: fields.city.trim(),
        district: fields.district.trim() || null,
        state: state.trim(),
        pincode: fields.pincode || null,
      };

      if (saveAsAddress) {
        const saved = await api.post<AddressDto>('/addresses', {
          label: addressType,
          fullName: destination.fullName,
          mobile: destination.mobile,
          houseNo: null,
          street: destination.street,
          area: fields.area.trim(),
          city: destination.city,
          district: fields.district.trim(),
          state: destination.state,
          pincode: fields.pincode,
          latitude: point.latitude,
          longitude: point.longitude,
          locationSource: 'GPS',
          locationAccuracyM: point.accuracyM,
          isDefault: false,
        });
        void queryClient.invalidateQueries({ queryKey: ['addresses'] });
        selectAddress(saved.id);
        void setLocation({ latitude: saved.latitude, longitude: saved.longitude, label: liveLocationLabel(destination), source: 'ADDRESS' });
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
      });
    },
    onSuccess: () => (onLiveConfirmed ?? onBack)(),
    onError: (err: Error) => setError(err.message || 'Could not use this location.'),
  });

  const missing = isLive && !saveAsAddress
    ? // A live order needs only where (the point), who, and the village / town;
      // a PIN is optional but must be valid when given.
      [
        ...(fields.city.trim().length >= 2 ? [] : (['city'] as const)),
        ...(state.trim().length >= 2 ? [] : (['state'] as const)),
        ...(!fields.pincode || isValidPincode(fields.pincode) ? [] : (['pincode'] as const)),
      ]
    : missingAddressFields(
        { area: fields.area, city: fields.city, district: fields.district, state, pincode: fields.pincode },
        { requireArea: true },
      );
  /**
   * Rajasthan only. A live point the phone places elsewhere (or cannot place
   * at all outside Rajasthan) is refused here; an older saved address outside
   * Rajasthan is shown as it is — never rewritten — and cannot be saved or
   * ordered to. The server checks the point itself either way.
   */
  const stateBlock = !isHomeState(state)
    ? isLive
      ? state
        ? `Aadione currently delivers only in Rajasthan. Your phone places this location in ${state}.`
        : 'Aadione currently delivers only in Rajasthan, and this location appears to be outside Rajasthan.'
      : isEditing
        ? `This address is in ${state || 'another state'}. Aadione currently delivers only in Rajasthan, so it cannot be used for orders — delete it, or add an address in Rajasthan.`
        : null
    : null;
  const complete =
    fullName.trim().length >= 2 &&
    normalizeIndianMobile(mobile) !== null &&
    missing.length === 0 &&
    point !== null &&
    !pointStale &&
    !confirmPoint &&
    !stateBlock;

  /** Live mode (not saving): locality, district and PIN may be left empty. */
  const liveOptional = isLive && !saveAsAddress ? 'Optional' : undefined;

  /**
   * The location section appears when ADDING an address, and when EDITING
   * one whose village / district / state / PIN was changed (its point must be
   * confirmed again). An unchanged edit keeps the saved point untouched; the
   * live-details form already has its point from Select Location.
   */
  const showLocationCapture = !isLive && (!isEditing || pointStale);
  /** Enough of the address to look it up: village / town, district, a valid PIN. */
  const canFind = fields.city.trim().length >= 2 && fields.district.trim().length >= 2 && isValidPincode(fields.pincode);

  const pointStatus = !point
    ? { ok: false, text: 'Location not set yet — find the address on the map, or use your current location while you are there.' }
    : pointStale
      ? { ok: false, text: 'The village, district or PIN changed — confirm the location again.' }
      : point.source === 'GEOCODED'
        ? { ok: true, text: 'Approximate location found from the address (not an exact doorstep point).' }
        : point.source === 'GPS' && point.fresh
          ? { ok: true, text: `Current location captured — ${describeAccuracy(point.accuracyM).toLowerCase()}.` }
          : { ok: true, text: 'Saved location.' };

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <View>
          <AppText variant="h3">{isLive ? 'Delivery details' : isEditing ? 'Edit Address' : 'Add New Address'}</AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            {isLive
              ? 'Check the details for your current location'
              : isEditing
                ? 'Update your address details'
                : 'Enter your address details'}
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

          {isLive && !live?.suggestion && (
            <NoticeStrip
              tone="info"
              message="Your location was found, but its address could not be read. Please fill in the details below — or tap “Use my current location” to try reading it again."
            />
          )}
          {isLive && live?.quality === 'POOR' && (
            <NoticeStrip message="Your phone could only find an approximate location. For exact delivery, try again outdoors." />
          )}
          {stateBlock && <NoticeStrip message={stateBlock} />}

          <Field label="Full Name">
            <Input value={fullName} onChangeText={setFullName} placeholder="Enter full name" autoCapitalize="words" />
          </Field>

          <Field label="Phone Number">
            <Input value={mobile} onChangeText={setMobile} placeholder="Enter phone number" keyboardType="phone-pad" maxLength={15} />
          </Field>

          <Field label="House No. + Street / Road" hint="Optional">
            <Input
              value={fields.houseStreet}
              onChangeText={(v) => setField('houseStreet', v)}
              placeholder="e.g. 12, Shree Niwas, Station Road"
              autoCapitalize="words"
              // An older address can be longer when left as it was; edited text must fit the column.
              maxLength={Math.max(HOUSE_STREET_MAX, originalHouseStreet.length)}
            />
          </Field>

          <Field label="Locality / Mohalla / Colony" hint={liveOptional}>
            <Input value={fields.area} onChangeText={(v) => setField('area', v)} placeholder="e.g. Shastri Nagar" autoCapitalize="words" />
          </Field>

          <Field label="Village / City / Town">
            <Input value={fields.city} onChangeText={(v) => setField('city', v)} placeholder="Your village, or your city / town" autoCapitalize="words" />
          </Field>

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Field label="District" hint={liveOptional}>
                <Input value={fields.district} onChangeText={(v) => setField('district', v)} placeholder="e.g. Rajsamand" autoCapitalize="words" />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="PIN Code" hint={liveOptional}>
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

          {fields.pincode.length === 6 && !isValidPincode(fields.pincode) && (
            <AppText variant="caption" color={colors.danger}>
              Enter a valid 6-digit PIN code.
            </AppText>
          )}

          {/* Never editable: Rajasthan for new addresses, the phone's reading
              for a live point, an older address's own state as saved. */}
          <Field label="State">
            <View style={styles.fixedValue} accessible accessibilityLabel={`State, ${state || 'not in Rajasthan'}, cannot be changed`}>
              <AppText variant="body" color={stateBlock ? colors.danger : colors.textSecondary}>
                {state || 'Outside Rajasthan'}
              </AppText>
              <Ionicons name="lock-closed-outline" size={16} color={colors.textMuted} />
            </View>
          </Field>

          {/* The point — separate from the text above. Only when ADDING an
              address (see showLocationCapture). */}
          {showLocationCapture && (
          <View style={styles.locationBox}>
            <View style={styles.locationStatus}>
              <Ionicons
                name={pointStatus.ok ? 'checkmark-circle' : 'location-outline'}
                size={18}
                color={pointStatus.ok ? colors.primary : colors.textSecondary}
              />
              <AppText variant="caption" color={pointStatus.ok ? colors.primary : colors.textSecondary} style={{ flex: 1 }}>
                {pointStatus.text}
              </AppText>
            </View>
            {point && !pointStale && (
              <Pressable onPress={() => void Linking.openURL(mapPreviewUrl(point.latitude, point.longitude))} hitSlop={8} style={{ marginTop: spacing.xs }}>
                <AppText variant="caption" color={colors.primary}>
                  View this location on the map
                </AppText>
              </Pressable>
            )}
            {confirmPoint && (
              <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
                <AppText variant="caption" color={colors.danger}>
                  {confirmPoint}
                </AppText>
                <Button label="I am at this address now — use this location" variant="secondary" onPress={() => setConfirmPoint(null)} />
              </View>
            )}
            <Button
              label={finding ? 'Finding the address…' : 'Find this address on the map'}
              onPress={() => void findThisAddress()}
              loading={finding}
              disabled={!canFind || finding || locating}
              style={{ marginTop: spacing.sm }}
            />
            {!canFind && (
              <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
                Enter the village / town, district and PIN to find the address.
              </AppText>
            )}
            {found && (
              <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
                {found.message && (
                  <AppText variant="caption" color={colors.danger}>
                    {found.message}
                  </AppText>
                )}
                {found.usable.length > 1 && (
                  <AppText variant="caption" color={colors.textSecondary}>
                    More than one place matches — choose the right one.
                  </AppText>
                )}
                {found.usable.map((candidate) => (
                  <View key={`${candidate.latitude},${candidate.longitude}`} style={styles.candidate}>
                    <AppText variant="bodyStrong">{describeFoundPlace(candidate.place)}</AppText>
                    <AppText variant="caption" color={candidate.check.verdict === 'MATCH' ? colors.primary : colors.textSecondary}>
                      {candidate.check.verdict === 'MATCH'
                        ? 'Matches the village / PIN you entered. Approximate — the centre of this area.'
                        : candidate.check.verdict === 'CONFLICT'
                          ? `The map names this place ${candidate.place?.city ?? 'differently'} — use it only if this is your village.`
                          : 'The map could not confirm the village or PIN — check it on the map first.'}
                    </AppText>
                    <View style={styles.candidateActions}>
                      <Pressable onPress={() => void Linking.openURL(mapPreviewUrl(candidate.latitude, candidate.longitude))} hitSlop={8}>
                        <AppText variant="caption" color={colors.primary}>
                          View on map
                        </AppText>
                      </Pressable>
                      <Button label="Use this location" variant="secondary" onPress={() => useFoundLocation(candidate)} />
                    </View>
                  </View>
                ))}
              </View>
            )}
            <Button
              label={locating ? 'Getting your location…' : locationError ? 'Try again' : 'Use my current location'}
              variant="ghost"
              onPress={() => void useCurrentLocation()}
              loading={locating}
              disabled={finding}
              style={{ marginTop: spacing.sm }}
            />
            <AppText variant="caption" color={colors.textSecondary}>
              Only use your current location when you are at this address.
            </AppText>
            {locationError && (
              <View style={{ marginTop: spacing.sm }}>
                <AppText variant="caption" color={colors.danger}>
                  {locationError.message}
                </AppText>
                {locationError.status === 'PERMISSION_DENIED' && (
                  <Pressable onPress={() => void Linking.openSettings()} hitSlop={8} style={{ marginTop: spacing.xs }}>
                    <AppText variant="bodyStrong" color={colors.primary}>
                      Open settings
                    </AppText>
                  </Pressable>
                )}
              </View>
            )}
            {locationNote && (
              <AppText variant="caption" color={locationNote.ok ? colors.primary : colors.danger} style={{ marginTop: spacing.sm }}>
                {locationNote.message}
              </AppText>
            )}
          </View>
          )}

          {!complete && (missing.length > 0 || !point || pointStale || !!confirmPoint) && (
            <AppText variant="caption" color={colors.textSecondary}>
              Still needed:{' '}
              {[
                ...missing.map((key) => ADDRESS_FIELD_LABEL[key]),
                ...(!point || pointStale ? ['Location of this address'] : confirmPoint ? ['Confirm the location'] : []),
              ].join(', ')}
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
                <AppText variant="bodyStrong">Also save this address</AppText>
                <AppText variant="caption" color={colors.textSecondary}>
                  {saveAsAddress
                    ? 'Saved to your addresses — needs locality, district and PIN.'
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
              label="Deliver to this location"
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
  fixedValue: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted,
  },
  locationBox: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  candidate: {
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    gap: spacing.xs,
  },
  candidateActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  locationStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
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
