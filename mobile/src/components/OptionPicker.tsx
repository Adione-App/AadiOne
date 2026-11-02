/**
 * A dropdown field: looks like the form's inputs, opens a list of the allowed
 * choices in a bottom sheet, and never accepts free text — used for the
 * admin-approved village and its PIN codes on the address form.
 */

import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@shared/theme';
import { AppText } from './ui';

export function OptionPicker({
  value,
  options,
  placeholder,
  title,
  onChange,
  disabled,
  emptyText,
}: {
  value: string;
  options: readonly string[];
  placeholder: string;
  /** The sheet's heading, e.g. "Choose your village / town". */
  title: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Shown in the sheet when there is nothing to choose. */
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  return (
    <>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        style={[styles.field, disabled && styles.fieldDisabled]}
        accessibilityRole="button"
        accessibilityLabel={value ? `${title}: ${value}` : title}
        accessibilityState={{ disabled: !!disabled }}
      >
        <AppText variant="body" color={value ? colors.textPrimary : colors.textMuted} style={styles.flex} numberOfLines={1}>
          {value || placeholder}
        </AppText>
        <Ionicons name="chevron-down" size={18} color={disabled ? colors.textMuted : colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]} onPress={() => {}}>
            <View style={styles.header}>
              <AppText variant="h3" style={styles.flex}>
                {title}
              </AppText>
              <Pressable onPress={() => setOpen(false)} hitSlop={10} accessibilityLabel="Close">
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>
            <FlatList
              data={options as string[]}
              keyExtractor={(item) => item}
              ListEmptyComponent={
                <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
                  {emptyText ?? 'Nothing to choose yet.'}
                </AppText>
              }
              renderItem={({ item }) => {
                const selected = item === value;
                return (
                  <Pressable
                    onPress={() => {
                      onChange(item);
                      setOpen(false);
                    }}
                    style={[styles.option, selected && styles.optionSelected]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                  >
                    <AppText variant={selected ? 'bodyStrong' : 'body'} color={selected ? colors.primary : colors.textPrimary} style={styles.flex}>
                      {item}
                    </AppText>
                    {selected && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                  </Pressable>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  fieldDisabled: {
    backgroundColor: colors.surfaceMuted,
  },
  flex: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.overlay,
  },
  sheet: {
    maxHeight: '75%',
    paddingHorizontal: spacing.base,
    paddingTop: spacing.base,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  optionSelected: {
    backgroundColor: colors.primaryLight,
  },
  empty: {
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
});
