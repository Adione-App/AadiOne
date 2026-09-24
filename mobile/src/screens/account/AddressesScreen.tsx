import { useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Briefcase,
  Home as HomeIcon,
  MapPin,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react-native";
import type { AddressDto, PublicConfig } from "@shared";
import { formatIndianMobile } from "@shared/phone";
import { colors, radius, shadow, spacing } from "@shared/theme";
import { api } from "@/lib/api";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
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
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();

  // Only one card's menu open at a time — opening another closes the last.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

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
            // The tab bar floats over this screen now (see MainTabs.tsx's
            // `AnimatedTabBar`) rather than reserving its own flex space.
            paddingBottom: tabBarClearance + spacing.xxl,
          }}
          renderItem={({ item }) => (
            <AddressCard
              address={item}
              menuOpen={openMenuId === item.id}
              onToggleMenu={() =>
                setOpenMenuId((current) => (current === item.id ? null : item.id))
              }
              onEdit={() => {
                setOpenMenuId(null);
                onEditAddress(item.id);
              }}
              onDelete={() => {
                setOpenMenuId(null);
                remove.mutate(item.id);
              }}
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

const TYPE_ICON = {
  Home: HomeIcon,
  Work: Briefcase,
} as const;

function AddressCard({
  address,
  menuOpen,
  onToggleMenu,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  address: AddressDto;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const TypeIcon = TYPE_ICON[address.label as keyof typeof TYPE_ICON] ?? MapPin;

  // One compact line instead of five — house/street/area, landmark, city/state/pincode.
  const fullAddress = [
    [address.houseNo, address.street, address.area].filter(Boolean).join(", "),
    address.landmark ? `Near ${address.landmark}` : null,
    [address.city, address.state, address.pincode].filter(Boolean).join(" - "),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <View style={[styles.card, menuOpen && styles.cardRaised]}>
      <View style={styles.cardTop}>
        <View style={styles.typeRow}>
          <View style={styles.typeIcon}>
            <TypeIcon size={14} color={colors.primary} strokeWidth={2.2} />
          </View>

          <AppText variant="bodyStrong" style={styles.addressLabel} numberOfLines={1}>
            {address.label}
          </AppText>

          {address.isDefault && (
            <View style={styles.defaultBadge}>
              <AppText variant="overline" color={colors.primary} style={styles.defaultText}>
                Default
              </AppText>
            </View>
          )}
        </View>

        <View style={styles.menuAnchor}>
          <Pressable
            onPress={onToggleMenu}
            hitSlop={10}
            style={styles.menuButton}
            accessibilityLabel="Address options"
          >
            <MoreVertical size={18} color={colors.textSecondary} />
          </Pressable>

          {menuOpen && (
            <View style={styles.menuDropdown}>
              <Pressable onPress={onEdit} hitSlop={4} style={styles.menuRow}>
                <Pencil size={15} color={colors.textPrimary} />
                <AppText variant="body" style={styles.menuRowText}>
                  Edit
                </AppText>
              </Pressable>

              <View style={styles.menuDivider} />

              <Pressable onPress={onDelete} hitSlop={4} style={styles.menuRow}>
                <Trash2 size={15} color={colors.danger} />
                <AppText variant="body" color={colors.danger} style={styles.menuRowText}>
                  Delete
                </AppText>
              </Pressable>
            </View>
          )}
        </View>
      </View>

      <AppText variant="body" numberOfLines={1} style={styles.name}>
        {address.fullName}
      </AppText>

      <AppText
        variant="caption"
        color={colors.textSecondary}
        numberOfLines={2}
        style={styles.addressText}
      >
        {fullAddress}
      </AppText>

      <AppText variant="caption" color={colors.textSecondary} style={styles.mobile}>
        {formatIndianMobile(address.mobile)}
      </AppText>

      {!address.isServiceable && (
        <AppText variant="caption" color={colors.danger} style={styles.serviceability}>
          We don't deliver to this address yet
        </AppText>
      )}

      {!address.isDefault && (
        <Pressable onPress={onSetDefault} hitSlop={8} style={styles.setDefaultButton}>
          <AppText variant="caption" color={colors.primary} style={styles.setDefaultText}>
            Set as default
          </AppText>
        </Pressable>
      )}
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

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,

    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,

    marginBottom: spacing.sm,
  },

  // Lifted above sibling cards while its menu is open, so the dropdown (which
  // overflows the card's own bounds) doesn't paint underneath the next one.
  cardRaised: {
    zIndex: 20,
    elevation: 8,
  },

  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  typeRow: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    minWidth: 0,
  },

  typeIcon: {
    width: 24,
    height: 24,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.xs,
  },

  addressLabel: {
    fontSize: 14,
    flexShrink: 1,
  },

  defaultBadge: {
    marginLeft: spacing.sm,
    backgroundColor: colors.primarySurface,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },

  defaultText: {
    fontWeight: "700",
  },

  menuAnchor: {
    position: "relative",
  },

  menuButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },

  menuDropdown: {
    position: "absolute",
    top: 32,
    right: 0,
    minWidth: 132,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    zIndex: 30,
    ...shadow.md,
    elevation: 10,
  },

  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },

  menuRowText: {
    fontWeight: "600",
  },

  menuDivider: {
    height: 1,
    backgroundColor: colors.divider,
    marginHorizontal: spacing.xs,
  },

  name: {
    marginTop: spacing.xs,
    fontWeight: "600",
  },

  addressText: {
    marginTop: 2,
    lineHeight: 16,
  },

  mobile: {
    marginTop: 2,
  },

  serviceability: {
    marginTop: spacing.xs,
  },

  setDefaultButton: {
    alignSelf: "flex-start",
    marginTop: spacing.xs,
  },

  setDefaultText: {
    fontWeight: "700",
  },

  footer: {
    paddingTop: spacing.sm,
  },

  footerButton: {
    marginTop: spacing.base,
  },
});
