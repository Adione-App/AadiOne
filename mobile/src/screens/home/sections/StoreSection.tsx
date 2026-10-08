/**
 * Stores — live marketplace sellers from GET /stores. With a known location
 * the server returns only sellers that deliver there, nearest first; this
 * component just draws them.
 */

import { memo } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import type { StoreSummaryDto } from "@shared";
import { formatDistance } from "@shared/distance";
import { colors, palette, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import { storeSubtitle } from "../homeEngine";
import { PANEL_PADDING, SectionHeader, SectionPanel } from "./SectionShell";

const CARD_WIDTH = 132;

function StoreCard({ store, onPress }: { store: StoreSummaryDto; onPress: (sellerId: string) => void }) {
  const images = store.previewImageUrls
    .map((url) => resolveImageUrl(url))
    .filter((url): url is string => url !== null);

  return (
    <Pressable
      onPress={() => onPress(store.id)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${store.name}`}
    >
      <View style={styles.avatar}>
        {images[0] ? (
          <Image source={{ uri: images[0] }} style={styles.avatarImage} contentFit="contain" transition={150} cachePolicy="memory-disk" />
        ) : (
          <AppText style={styles.letter}>{store.name.trim().charAt(0).toUpperCase()}</AppText>
        )}
      </View>

      <AppText style={styles.name} numberOfLines={1}>
        {store.name}
      </AppText>
      <AppText style={styles.subtitle} numberOfLines={1}>
        {storeSubtitle(store)}
      </AppText>
      <AppText style={styles.count} numberOfLines={1}>
        {store.productCount} {store.productCount === 1 ? "product" : "products"}
        {store.distanceKm !== null ? ` · ${formatDistance(store.distanceKm)}` : ""}
      </AppText>

      {!store.isOpen && (
        <View style={styles.closed}>
          <AppText style={styles.closedText} numberOfLines={1}>
            {store.nextOpenText ?? "Closed now"}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

function StoreSectionImpl({
  stores,
  nearby,
  onOpenStore,
}: {
  stores: StoreSummaryDto[];
  /** True when the list was filtered to the customer's location. */
  nearby: boolean;
  onOpenStore: (sellerId: string) => void;
}) {
  return (
    <SectionPanel>
      <SectionHeader title={nearby ? "Stores Near You" : "Popular Stores"} />
      <FlatList
        horizontal
        data={stores}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <StoreCard store={item} onPress={onOpenStore} />}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        getItemLayout={(_data, index) => ({
          length: CARD_WIDTH + spacing.sm,
          offset: (CARD_WIDTH + spacing.sm) * index,
          index,
        })}
        initialNumToRender={4}
        windowSize={5}
      />
    </SectionPanel>
  );
}

export const StoreSection = memo(StoreSectionImpl);

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: PANEL_PADDING,
    gap: spacing.sm,
  },
  card: {
    width: CARD_WIDTH,
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: {
    opacity: 0.85,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: palette.green50,
    borderWidth: 1,
    borderColor: palette.green100,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginBottom: spacing.sm,
  },
  avatarImage: {
    width: 44,
    height: 44,
  },
  letter: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "800",
    color: palette.green600,
  },
  name: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
    color: colors.textPrimary,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: 1,
  },
  count: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    color: colors.primary,
    textAlign: "center",
    marginTop: 2,
  },
  closed: {
    marginTop: spacing.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSunken,
    maxWidth: "100%",
  },
  closedText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
});
