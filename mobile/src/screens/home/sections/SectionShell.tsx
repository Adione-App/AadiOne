
import { memo, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ChevronRight } from "lucide-react-native";
import { colors, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";

/** One consistent background for the complete Home page. */
export const HOME_BACKGROUND = "#FFFFFF";

/** Kept for compatibility with existing section imports. */
export const PANEL_INSET = spacing.sm;
export const PANEL_PADDING = spacing.md;

export const SectionHeader = memo(function SectionHeader({
  title,
  subtitle,
  onViewAll,
}: {
  title: string;
  subtitle?: string | null;
  onViewAll?: (() => void) | undefined;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.titleWrap}>
        <AppText style={styles.title} numberOfLines={1}>
          {title}
        </AppText>

        {subtitle ? (
          <AppText
            variant="caption"
            color={colors.textSecondary}
            numberOfLines={1}
          >
            {subtitle}
          </AppText>
        ) : null}
      </View>

      {onViewAll && (
        <Pressable
          onPress={onViewAll}
          hitSlop={10}
          style={styles.viewAll}
          accessibilityRole="button"
          accessibilityLabel={`View all ${title}`}
        >
          <AppText style={styles.viewAllText} color={colors.primary}>
            View All
          </AppText>

          <ChevronRight size={14} color={colors.primary} strokeWidth={2.5} />
        </Pressable>
      )}
    </View>
  );
});

export function SectionPanel({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 0,
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    backgroundColor: HOME_BACKGROUND,
    overflow: "hidden",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: PANEL_PADDING,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },

  titleWrap: {
    flex: 1,
    minWidth: 0,
  },

  title: {
    fontSize: 17,
    lineHeight: 23,
    fontWeight: "800",
    color: colors.textPrimary,
  },

  viewAll: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
  },

  viewAllText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
});
