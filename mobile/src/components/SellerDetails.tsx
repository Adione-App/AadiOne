/**
 * "Sold by …  ·  Seller details" and the sheet it opens: the seller's
 * business name, store address, customer-care contact and (food sellers)
 * FSSAI number, from GET /stores/:sellerId/details
 * (backend store-directory.service getSellerDetails).
 *
 * Marketplace sellers must be identifiable to customers before and after
 * purchase (Consumer Protection (E-Commerce) Rules, 2020). Every value is the
 * seller's own record; a contact the seller has not published is simply not
 * shown — never replaced by a made-up one — and the customer is pointed to
 * Aadione support instead. Fetched only when the sheet opens.
 */

import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, X } from 'lucide-react-native';
import { telHref, type SellerDetailsDto } from '@shared';
import { colors, palette, radius, spacing } from '@shared/theme';
import { api } from '@/lib/api';
import { AppText, ErrorState, Loading } from './ui';

export function useSellerDetails(sellerId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['seller-details', sellerId],
    queryFn: () => api.get<SellerDetailsDto>(`/stores/${sellerId}/details`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** One tappable line: "Sold by Kirana Store  Seller details ›". */
export function SoldBy({ sellerId, sellerName, label = 'Sold by' }: { sellerId: string; sellerName: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={styles.soldBy}
        accessibilityRole="button"
        accessibilityLabel={`${label} ${sellerName}. Seller details`}
        hitSlop={6}
      >
        <AppText variant="body" color={colors.textSecondary} style={styles.soldByText} numberOfLines={1}>
          {label}{' '}
          <AppText variant="bodyStrong" color={colors.textPrimary}>
            {sellerName}
          </AppText>
        </AppText>
        <AppText variant="caption" color={colors.primaryDark}>
          Seller details
        </AppText>
        <ChevronRight size={16} color={colors.primaryDark} />
      </Pressable>
      {open ? <SellerDetailsSheet sellerId={sellerId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function open(href: string) {
  void Linking.openURL(href).catch(() => undefined);
}

export function SellerDetailsSheet({ sellerId, onClose }: { sellerId: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const details = useSellerDetails(sellerId, true);
  const data = details.data;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close seller details" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.base }]} accessibilityViewIsModal>
        <View style={styles.header}>
          <AppText variant="h3" style={styles.headerTitle}>
            Seller details
          </AppText>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <X size={22} color={colors.textPrimary} />
          </Pressable>
        </View>

        {details.isLoading ? (
          <Loading />
        ) : details.isError || !data ? (
          <ErrorState message="We could not load the seller's details." onRetry={() => void details.refetch()} />
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            <Row label="Seller" value={data.displayName} />
            {data.businessName ? <Row label="Business name" value={data.businessName} /> : null}
            <Row label="Address" value={data.address} />
            {data.customerCare.phone ? (
              <Row label="Customer care" value={data.customerCare.phone} onPress={() => open(telHref(data.customerCare.phone!))} />
            ) : null}
            {data.customerCare.email ? (
              <Row label="Customer care email" value={data.customerCare.email} onPress={() => open(`mailto:${data.customerCare.email}`)} />
            ) : null}
            {data.fssaiNumber ? <Row label="FSSAI licence no." value={data.fssaiNumber} /> : null}
            {!data.customerCare.phone && !data.customerCare.email ? (
              <AppText variant="body" color={colors.textSecondary} style={styles.note}>
                For help with an order from this seller, contact Aadione support from Account → Help & Support.
              </AppText>
            ) : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function Row({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const content = (
    <View style={styles.row}>
      <AppText variant="caption" color={colors.textSecondary}>
        {label}
      </AppText>
      <AppText variant="bodyLarge" color={onPress ? colors.primaryDark : palette.grey800} style={styles.rowValue}>
        {value}
      </AppText>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={`${label}: ${value}`}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  soldBy: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
  soldByText: { flexShrink: 1, flexGrow: 1 },
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '80%',
    minHeight: 220,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerTitle: { flex: 1 },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  row: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  rowValue: { marginTop: 2 },
  note: { marginTop: spacing.base },
});
