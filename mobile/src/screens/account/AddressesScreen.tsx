import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AddressDto, PublicConfig } from "@shared";
import { formatIndianMobile } from "@shared/phone";
import { colors, radius, spacing } from "@shared/theme";
import { api } from "@/lib/api";
import { AppText, Button, EmptyState, Loading, Screen } from "@/components/ui";

export default function AddressesScreen({
  onBack,
  onAddAddress,
  onEditAddress,
}: {
  onBack: () => void;
  onAddAddress: () => void;
  onEditAddress: (addressId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<AddressDto[]>("/addresses"),
  });

  const config = useQuery({
    queryKey: ["public-config"],
    queryFn: () => api.get<PublicConfig>("/config/public"),
    staleTime: 5 * 60_000,
  });

  const maxAddresses = config.data?.MAX_ADDRESSES_PER_USER ?? 5;
  const list = addresses.data ?? [];
  const atLimit = list.length >= maxAddresses;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["addresses"] });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/addresses/${id}`),
    onSuccess: invalidate,
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.post(`/addresses/${id}/default`),
    onSuccess: invalidate,
  });

  if (addresses.isLoading) {
    return <Loading label="Loading addresses…" />;
  }

  return (
    <Screen>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.sm,
          },
        ]}
      >
        <Pressable onPress={onBack} hitSlop={12} style={styles.backButton}>
          <AppText style={styles.backIcon}>‹</AppText>
        </Pressable>

        <AppText variant="h3" style={styles.headerTitle}>
          My Addresses
        </AppText>

        {!atLimit && (
          <Pressable
            onPress={onAddAddress}
            hitSlop={8}
            style={styles.addNewButton}
          >
            <AppText variant="bodyStrong" color={colors.primary}>
              + Add New
            </AppText>
          </Pressable>
        )}
      </View>

      {list.length === 0 ? (
        <EmptyState
          title="No saved addresses"
          hint="Add an address so we know where to deliver."
          action={{
            label: "Add new address",
            onPress: onAddAddress,
          }}
        />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: spacing.base,
            paddingTop: spacing.base,
            paddingBottom: insets.bottom + spacing.xxl,
          }}
          renderItem={({ item }) => (
            <AddressCard
              address={item}
              onEdit={() => onEditAddress(item.id)}
              onDelete={() => remove.mutate(item.id)}
              onSetDefault={() => setDefault.mutate(item.id)}
            />
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <AppText variant="caption" color={colors.textSecondary}>
                You can add up to {maxAddresses} addresses.
              </AppText>

              <Button
                label="Add new address"
                disabled={atLimit}
                onPress={onAddAddress}
                style={styles.footerButton}
              />
            </View>
          }
        />
      )}
    </Screen>
  );
}

/* -------------------------------------------------------------------------- */
/* Address Card                                                               */
/* -------------------------------------------------------------------------- */

function AddressCard({
  address,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  address: AddressDto;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const addressParts = [address.houseNo, address.street, address.area].filter(
    Boolean,
  );

  const locationLine = [address.city, address.state, address.pincode]
    .filter(Boolean)
    .join(" - ");

  return (
    <View style={styles.card}>
      {/* Top row */}
      <View style={styles.cardHeader}>
        <View style={styles.typeRow}>
          <View style={styles.locationIcon}>
            <AppText style={styles.locationIconText}>
              {address.label === "Home"
                ? "⌂"
                : address.label === "Work"
                  ? "▥"
                  : "⌖"}
            </AppText>
          </View>

          <AppText variant="bodyStrong" style={styles.addressLabel}>
            {address.label}
          </AppText>

          {address.isDefault && (
            <View style={styles.defaultBadge}>
              <AppText
                variant="caption"
                color={colors.primary}
                style={styles.defaultText}
              >
                Default
              </AppText>
            </View>
          )}
        </View>

        <Pressable onPress={onEdit} hitSlop={8} style={styles.editButton}>
          <AppText variant="bodyStrong" color={colors.primary}>
            Edit
          </AppText>
        </Pressable>
      </View>

      {/* Name */}
      <AppText variant="body" style={styles.name}>
        {address.fullName}
      </AppText>

      {/* Address */}
      <AppText
        variant="body"
        color={colors.textSecondary}
        style={styles.addressText}
      >
        {addressParts.join(", ")}
      </AppText>

      {/* Landmark */}
      {address.landmark && (
        <AppText
          variant="body"
          color={colors.textSecondary}
          style={styles.addressText}
        >
          Near {address.landmark}
        </AppText>
      )}

      {/* City / state / pincode */}
      <AppText
        variant="body"
        color={colors.textSecondary}
        style={styles.addressText}
      >
        {locationLine}
      </AppText>

      {/* Mobile */}
      <AppText
        variant="body"
        color={colors.textSecondary}
        style={styles.mobile}
      >
        {formatIndianMobile(address.mobile)}
      </AppText>

      {!address.isServiceable && (
        <AppText
          variant="caption"
          color={colors.danger}
          style={styles.serviceability}
        >
          We don't deliver to this address yet
        </AppText>
      )}

      {/* Bottom actions */}
      <View style={styles.actions}>
        {!address.isDefault ? (
          <Pressable onPress={onSetDefault} hitSlop={8}>
            <AppText variant="bodyStrong" color={colors.primary}>
              Set as default
            </AppText>
          </Pressable>
        ) : null}

        <Pressable onPress={onDelete} hitSlop={8}>
          <AppText variant="bodyStrong" color={colors.danger}>
            Delete
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },

  backButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },

  backIcon: {
    fontSize: 34,
    lineHeight: 34,
    color: colors.textPrimary,
  },

  headerTitle: {
    marginLeft: spacing.sm,
  },

  addNewButton: {
    marginLeft: "auto",
  },

  editButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,

    paddingHorizontal: spacing.base,
    paddingVertical: 12,

    marginBottom: spacing.md,
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  typeRow: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },

  locationIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  locationIconText: {
    fontSize: 19,
    color: colors.primary,
  },

  addressLabel: {
    fontSize: 17,
  },

  defaultBadge: {
    marginLeft: spacing.sm,
    backgroundColor: colors.primarySurface,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },

  defaultText: {
    fontWeight: "600",
  },

  name: {
    marginTop: spacing.sm,
    fontWeight: "600",
  },
  addressText: {
    marginTop: 3,
    lineHeight: 19,
  },

  mobile: {
    marginTop: spacing.xs,
  },

  serviceability: {
    marginTop: spacing.sm,
  },

  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xl,

    marginTop: spacing.md,
    paddingTop: spacing.sm,

    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },

  footer: {
    paddingTop: spacing.sm,
  },

  footerButton: {
    marginTop: spacing.base,
  },
});
