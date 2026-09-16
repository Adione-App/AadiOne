/**
 * Search (Task 14.7 companion).
 *
 * The server's search handles local names ("cheeni" finds Sugar) and typos
 * ("colgat" finds Colgate), so the app deliberately does no client-side
 * filtering — it would only produce worse results than the database.
 */

import { useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ProductSummaryDto } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { useSearch } from '@/lib/queries';
import { useCartActions } from '@/lib/useCartActions';
import { useGridColumns } from '@/lib/useGridColumns';
import { AppText, EmptyState, Loading, NoticeStrip, Screen } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';

export default function SearchScreen({
  onOpenProduct,
}: {
  onOpenProduct: (productId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [term, setTerm] = useState('');
  const results = useSearch(term);
  const cart = useCartActions();
  const columns = useGridColumns();

  const renderItem = ({ item }: { item: ProductSummaryDto }) => (
    <ProductCard
      product={item}
      qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
      busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
      onPress={() => onOpenProduct(item.id)}
      onAdd={() => item.defaultVariant && void cart.add(item.defaultVariant.id)}
      onIncrement={() => item.defaultVariant && void cart.increment(item.defaultVariant.id)}
      onDecrement={() => item.defaultVariant && void cart.decrement(item.defaultVariant.id)}
    />
  );

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <TextInput
          value={term}
          onChangeText={setTerm}
          placeholder="Search for atta, doodh, cheeni…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoFocus
          returnKeyType="search"
        />
      </View>

      {cart.error && (
        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm }}>
          <NoticeStrip message={cart.error} />
        </View>
      )}

      {term.trim().length < 2 ? (
        <EmptyState title="What are you looking for?" hint="Type at least 2 letters to search." />
      ) : results.isLoading ? (
        <Loading />
      ) : (results.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title={`No results for "${term}"`}
          hint="Try a different spelling or a shorter word."
        />
      ) : (
        <FlatList
          key={`grid-${columns}`}
          data={results.data?.items ?? []}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={columns}
          contentContainerStyle={{ padding: spacing.sm, paddingBottom: spacing.xxl }}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceMuted,
  },
});
