import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { useQuery } from "@tanstack/react-query";
import type { AddressDto } from "@shared";
import { colors, radius, spacing } from "@shared/theme";
import { addressPrimaryLine } from "@shared/text";
import { api } from "@/lib/api";
import { useLocation } from "@/lib/store";
import { AppText, Button, Card, Loading, Screen } from "@/components/ui";

export default function SelectLocationScreen({
  onBack,
  onAddAddress,
}: {
  onBack: () => void;
  onAddAddress: () => void;
}) {
  const insets = useSafeAreaInsets();

  const { location, selectedAddressId, setLocation, selectAddress, checking } =
    useLocation();

  const [detecting, setDetecting] = useState(false);

  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<AddressDto[]>("/addresses"),
  });

  async function useCurrentLocation(): Promise<void> {
    setDetecting(true);

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== "granted") {
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      let label = "Current location";

      try {
        const [place] = await Location.reverseGeocodeAsync({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });

        if (place) {
          label = [
            place.district ?? place.subregion,
            place.city ?? place.region,
            place.postalCode,
          ]
            .filter(Boolean)
            .join(", ");
        }
      } catch {
        // Coordinates are enough for serviceability.
      }

      selectAddress(null);

      await setLocation({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        label,
      });

      onBack();
    } finally {
      setDetecting(false);
    }
  }

  function selectSavedAddress(address: AddressDto): void {
    selectAddress(address.id);

    void setLocation({
      latitude: address.latitude,
      longitude: address.longitude,
      label: [addressPrimaryLine(address), address.city, address.pincode]
        .filter(Boolean)
        .join(", "),
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
          paddingBottom: insets.bottom + spacing.xxl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Current location */}
        <Pressable
          onPress={() => void useCurrentLocation()}
          disabled={detecting || checking}
          style={styles.currentLocation}
        >
          <View style={styles.locationIcon}>
            {detecting || checking ? (
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
              Detect your location automatically
            </AppText>
          </View>

          <AppText variant="h3" color={colors.primary}>
            ›
          </AppText>
        </Pressable>

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
                        numberOfLines={2}
                        style={{ marginTop: 2 }}
                      >
                        {[
                          address.houseNo,
                          address.street,
                          address.area,
                          address.city,
                          address.pincode,
                        ]
                          .filter(Boolean)
                          .join(", ")}
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
