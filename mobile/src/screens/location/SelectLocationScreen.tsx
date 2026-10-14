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
import { addressDetailLines } from "@/lib/addressDisplay";
import { isActiveLiveDestination } from "@/lib/liveLocation";
import { detectDeviceLocation, suggestAddressFor } from "@/lib/deviceLocation";
import { api } from "@/lib/api";
import { useLocation } from "@/lib/store";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { AppText, Button, Card, Loading, Screen } from "@/components/ui";
import type { LiveFixParams } from "@/navigation/types";

export default function SelectLocationScreen({
  onBack,
  onAddAddress,
  onLiveLocation,
}: {
  onBack: () => void;
  onAddAddress: () => void;
  /** Opens the delivery-details form for a fresh GPS fix (see LiveFixParams). */
  onLiveLocation: (fix: LiveFixParams) => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();

  const { selectedAddressId, setLocation, selectAddress, liveDestination, location } = useLocation();

  const [detecting, setDetecting] = useState<"gps" | "address" | null>(null);
  const [detectError, setDetectError] = useState<{ status: Exclude<DetectStatus, "OK">; message: string } | null>(null);

  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<AddressDto[]>("/addresses"),
  });

  /**
   * Permission → one fresh GPS fix → reverse geocoding → the delivery
   * details form, prefilled with whatever the geocoder found. A failed fix
   * opens nothing and sets nothing (there is no fallback point); a failed
   * geocode still opens the form, empty, for the customer to fill in.
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
      onLiveLocation({
        latitude: result.latitude,
        longitude: result.longitude,
        accuracyM: result.accuracyM,
        quality: result.quality,
        suggestion,
      });
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
                  : "Deliver to where you are now — no need to save it"}
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
              <AppText variant="caption" color={colors.textPrimary} style={{ marginTop: 2 }}>
                {activeLive.fullName} · {formatIndianMobile(activeLive.mobile)}
              </AppText>
              <AppText variant="body" color={colors.textSecondary} style={{ marginTop: 2 }}>
                {addressDetailLines(activeLive).join(", ")}
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
                        {addressDetailLines(address).join(", ")}
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
