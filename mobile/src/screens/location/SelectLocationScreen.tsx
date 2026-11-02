import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import type { AddressDto } from "@shared";
import { colors, radius, spacing } from "@shared/theme";
import { formatAddressLines } from "@shared/address";
import { formatIndianMobile } from "@shared/phone";
import { addressSummary } from "@/lib/addressDisplay";
import { isActiveLiveDestination } from "@/lib/liveLocation";
import { GPS_FAILURE_MESSAGE, type GpsFailure } from "@/lib/currentLocation";
import { enableLocationServices } from "@/lib/deviceLocation";
import { refreshCurrentLocation } from "@/lib/locationService";
import { api } from "@/lib/api";
import { useLocation, useSignedIn } from "@/lib/store";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { AppText, Button, Card, Loading, Screen } from "@/components/ui";

type SelectError = { status: GpsFailure; message: string };

export default function SelectLocationScreen({
  onBack,
  onAddAddress,
}: {
  onBack: () => void;
  onAddAddress: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const signedIn = useSignedIn();

  const { selectedAddressId, setLocation, selectAddress, liveDestination, location } = useLocation();

  const [detecting, setDetecting] = useState<"gps" | null>(null);
  const [detectError, setDetectError] = useState<SelectError | null>(null);

  // Saved addresses are an account's. A guest still chooses where they are
  // with "Use current location" (permission asked only on that tap), which is
  // enough to see what delivers there.
  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<AddressDto[]>("/addresses"),
    enabled: signedIn,
  });

  /**
   * Permission (the system dialog only if it may still ask) → one fresh GPS
   * fix → the readable address → SELECTED, and back to where the customer
   * came from. No second confirmation. The same reading as every other
   * current-location request (lib/locationService.ts — never two at once).
   *
   * What is selected is a genuine live destination: these exact coordinates
   * (sent as `liveLocation` at checkout), the address the geocoder could
   * read, and the recipient from the verified profile. Anything the geocoder
   * or profile lacked is completed at checkout before paying. A point
   * outside Rajasthan is selected as the current location — Home then says
   * Aadione does not deliver there — but never as an order destination.
   *
   * Nothing is selected for a failed fix (no fallback point); the server
   * re-checks the point and the seller radius on the quote and the order.
   */
  async function useCurrentLocation(): Promise<void> {
    setDetecting("gps");
    setDetectError(null);
    try {
      const outcome = await refreshCurrentLocation("user", { prompt: true });
      if (outcome.kind === "FAILED") {
        setDetectError({ status: outcome.failure, message: GPS_FAILURE_MESSAGE[outcome.failure] });
        return;
      }
      if (outcome.kind === "UPDATED") onBack();
    } finally {
      setDetecting(null);
    }
  }

  async function turnOnLocation(): Promise<void> {
    if (await enableLocationServices()) await useCurrentLocation();
  }

  // The live location already confirmed, if it is still the chosen one.
  const activeLive = isActiveLiveDestination(liveDestination, location) ? liveDestination : null;

  function selectSavedAddress(address: AddressDto): void {
    selectAddress(address.id);
    const lines = formatAddressLines(address);

    void setLocation({
      latitude: address.latitude,
      longitude: address.longitude,
      label: [lines.line1, address.city, address.pincode].filter(Boolean).join(", "),
      source: "ADDRESS",
      // The approved village + PIN decide delivery for it (Home check).
      village: address.city,
      pincode: address.pincode,
    });

    onBack();
  }

  if (addresses.isLoading) {
    return <Loading label="Loading addresses…" />;
  }

  const list = addresses.data ?? [];

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>

        <View>
          <AppText variant="h3">Select Location</AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            Choose where you want your order delivered
          </AppText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.base,
          // The tab bar floats over this screen now (see MainTabs.tsx's
          // `AnimatedTabBar`) rather than reserving its own flex space.
          paddingBottom: tabBarClearance + spacing.xxl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Current location */}
        <Pressable
          onPress={() => void useCurrentLocation()}
          // Only its own detection blocks it — not a background
          // serviceability re-check of the location already chosen.
          disabled={detecting !== null}
          style={styles.currentLocation}
        >
          <View style={styles.locationIcon}>
            {detecting ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <AppText style={styles.locationIconText}>⌖</AppText>
            )}
          </View>

          <View style={styles.currentLocationContent}>
            <AppText variant="bodyStrong" color={colors.primary}>
              Use Current Location
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={{ marginTop: 2 }}
            >
              {detecting === "gps"
                ? "Finding your location…"
                : "Uses your phone's GPS — allow location permission when asked"}
            </AppText>
          </View>

          <AppText variant="h3" color={colors.primary}>
            ›
          </AppText>
        </Pressable>

        {detectError && (
          <Card style={{ marginTop: spacing.md }}>
            <AppText variant="body" color={colors.danger}>
              {detectError.message}
            </AppText>
            {/* A denied permission gets no button of Aadione's: the saved
                addresses below, or "Use current location" again (Android's
                own dialog, when it still asks). */}
            {detectError.status === "SERVICES_DISABLED" ? (
              <Button
                label="Turn on location"
                onPress={() => void turnOnLocation()}
                loading={detecting !== null}
                style={{ marginTop: spacing.md }}
              />
            ) : detectError.status !== "PERMISSION_DENIED" && detectError.status !== "PERMISSION_BLOCKED" ? (
              <Button
                label="Try again"
                onPress={() => void useCurrentLocation()}
                loading={detecting !== null}
                style={{ marginTop: spacing.md }}
              />
            ) : null}
          </Card>
        )}

        {/* The live location confirmed earlier — still the one orders go to. */}
        {activeLive && (
          <View style={[styles.addressCard, styles.addressCardSelected]}>
            <View style={styles.addressContent}>
              <View style={styles.addressTitleRow}>
                <AppText variant="bodyStrong">Live location</AppText>
                <View style={styles.selectedBadge}>
                  <AppText variant="caption" color={colors.primary}>
                    Selected
                  </AppText>
                </View>
              </View>
              {activeLive.fullName ? (
                <AppText variant="caption" color={colors.textPrimary} style={{ marginTop: 2 }}>
                  {activeLive.fullName}
                  {activeLive.mobile ? ` · ${formatIndianMobile(activeLive.mobile)}` : ""}
                </AppText>
              ) : null}
              <AppText variant="body" color={colors.textSecondary} style={{ marginTop: 2 }}>
                {addressSummary(activeLive) || "Your current location"}
              </AppText>
            </View>
          </View>
        )}

        {/* Saved addresses */}
        {list.length > 0 && (
          <>
            <AppText variant="h3" style={{ marginTop: spacing.xl }}>
              Saved addresses
            </AppText>

            <View style={{ marginTop: spacing.sm }}>
              {list.map((address) => {
                const selected = selectedAddressId === address.id;

                return (
                  <Pressable
                    key={address.id}
                    onPress={() => selectSavedAddress(address)}
                    style={[
                      styles.addressCard,
                      selected && styles.addressCardSelected,
                    ]}
                  >
                    <View style={styles.addressIcon}>
                      <AppText style={styles.addressIconText}>
                        {address.label === "Work" ? "⌂" : "⌂"}
                      </AppText>
                    </View>

                    <View style={styles.addressContent}>
                      <View style={styles.addressTitleRow}>
                        <AppText variant="bodyStrong">{address.label}</AppText>

                        {selected && (
                          <View style={styles.selectedBadge}>
                            <AppText variant="caption" color={colors.primary}>
                              Selected
                            </AppText>
                          </View>
                        )}
                      </View>

                      <AppText
                        variant="body"
                        color={colors.textSecondary}
                        style={{ marginTop: 2 }}
                      >
                        {addressSummary(address)}
                      </AppText>

                      {!address.isServiceable && (
                        <AppText
                          variant="caption"
                          color={colors.danger}
                          style={{ marginTop: spacing.xs }}
                        >
                          We don't deliver to this address yet
                        </AppText>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        {/* Add address */}
        <Pressable onPress={onAddAddress} style={styles.addAddress}>
          <View style={styles.addIcon}>
            <AppText variant="h2" color={colors.primary}>
              +
            </AppText>
          </View>

          <View style={{ flex: 1 }}>
            <AppText variant="bodyStrong" color={colors.primary}>
              Enter Address Manually
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={{ marginTop: 2 }}
            >
              Type your name, phone, house and street, village or town, and PIN code
            </AppText>
          </View>

          <AppText variant="h3" color={colors.primary}>
            ›
          </AppText>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },

  back: {
    width: 40,
    height: 40,
    justifyContent: "center",
  },

  currentLocation: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySurface,
  },

  locationIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.circle,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    marginRight: spacing.md,
  },

  locationIconText: {
    fontSize: 25,
    color: colors.primary,
  },

  currentLocationContent: {
    flex: 1,
  },

  addressCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },

  addressCardSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySurface,
  },

  addressIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.circle,
    backgroundColor: colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },

  addressIconText: {
    fontSize: 22,
    color: colors.primary,
  },

  addressContent: {
    flex: 1,
  },

  addressTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  selectedBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },

  addAddress: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },

  addIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
});
