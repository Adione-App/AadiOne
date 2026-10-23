import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
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
import { DETECT_MESSAGE, type DetectStatus } from "@shared/location";
import { formatIndianMobile } from "@shared/phone";
import { addressSummary } from "@/lib/addressDisplay";
import {
  buildLiveDestination,
  isActiveLiveDestination,
  isHomeState,
  liveLocationLabel,
} from "@/lib/liveLocation";
import { detectDeviceLocation, suggestAddressFor } from "@/lib/deviceLocation";
import { api } from "@/lib/api";
import { useAuth, useLocation, useSignedIn } from "@/lib/store";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { AppText, Button, Card, Loading, Screen } from "@/components/ui";

type SelectError = { status: Exclude<DetectStatus, "OK"> | "OUTSIDE_STATE"; message: string };

const OUTSIDE_STATE_MESSAGE =
  "Aadione currently delivers only in Rajasthan, and your current location appears to be outside Rajasthan.";

export default function SelectLocationScreen({
  onBack,
  onAddAddress,
}: {
  onBack: () => void;
  onAddAddress: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const user = useAuth((s) => s.user);
  const signedIn = useSignedIn();

  const { selectedAddressId, setLocation, setLiveDestination, selectAddress, liveDestination, location } = useLocation();

  const [detecting, setDetecting] = useState<"gps" | "address" | null>(null);
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
   * Permission → one fresh GPS fix → the readable address → SELECTED, and
   * back to where the customer came from. No second confirmation.
   *
   * What is selected is a genuine live destination: these exact coordinates
   * (sent as `liveLocation` at checkout), the address the geocoder could
   * read, and the recipient from the verified profile. Anything the geocoder
   * or profile lacked is completed at checkout before paying.
   *
   * Nothing is selected for a failed fix (no fallback point) or a point
   * outside Rajasthan; the server re-checks the point and the seller radius
   * on the quote and the order regardless.
   */
  async function useCurrentLocation(): Promise<void> {
    setDetecting("gps");
    setDetectError(null);
    try {
      const result = await detectDeviceLocation();
      if (result.status !== "OK") {
        setDetectError({ status: result.status, message: DETECT_MESSAGE[result.status] });
        return;
      }
      setDetecting("address");
      const suggestion = await suggestAddressFor(result.latitude, result.longitude);
      const destination = buildLiveDestination(result, suggestion, user);
      if (!isHomeState(destination.state)) {
        setDetectError({ status: "OUTSIDE_STATE", message: OUTSIDE_STATE_MESSAGE });
        return;
      }
      // The details first, then the point they belong to (the store keeps a
      // live destination only for the current GPS location).
      setLiveDestination(destination);
      void setLocation({
        latitude: destination.latitude,
        longitude: destination.longitude,
        label: liveLocationLabel(destination),
        source: "GPS",
        accuracyM: destination.accuracyM,
      });
      onBack();
    } finally {
      setDetecting(null);
    }
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
              Use current location
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={{ marginTop: 2 }}
            >
              {detecting === "gps"
                ? "Finding your location…"
                : detecting === "address"
                  ? "Reading the address…"
                  : "Deliver to where you are now — selected at once"}
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
            <Button
              label="Try again"
              onPress={() => void useCurrentLocation()}
              loading={detecting !== null}
              style={{ marginTop: spacing.md }}
            />
            {detectError.status === "PERMISSION_DENIED" && (
              <Button
                label="Open settings"
                variant="ghost"
                onPress={() => void Linking.openSettings()}
                style={{ marginTop: spacing.xs }}
              />
            )}
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
              Add new address
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={{ marginTop: 2 }}
            >
              Save another delivery address
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
