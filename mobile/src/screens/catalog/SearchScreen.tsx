/**
 * Search (Task 14.7 companion).
 *
 * The server's search handles local names ("cheeni" finds Sugar) and typos
 * ("colgat" finds Colgate), so the app deliberately does no client-side
 * filtering — it would only produce worse results than the database.
 *
 * The query term sent to the server is DEBOUNCED (see `debouncedTerm`) —
 * typing fired a brand-new network request (and, without
 * `placeholderData: keepPreviousData` in `useSearch`, a full-screen blank
 * loading state) on every single keystroke, which is what made the whole
 * screen feel like it was flickering/broken while typing normally. The
 * TextInput itself is never debounced — only the term handed to the query —
 * so typing itself stays instantly responsive.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Clock, Search as SearchIcon, X } from 'lucide-react-native';
import type { ProductSummaryDto } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { useRailProducts, useSearch } from '@/lib/queries';
import { useCartActions } from '@/lib/useCartActions';
import { useGridColumns } from '@/lib/useGridColumns';
import { useRecentSearches } from '@/lib/recentSearches';
import { suggestSearchTerms } from '@/lib/searchSuggestions';
import { AppText, EmptyState, Loading, NoticeStrip, Screen } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { ProductGridSkeleton } from '@/components/ProductCardSkeleton';

/** Long enough that normal typing never fires a request per letter, short
 * enough that the results still feel immediate once you pause. */
const SEARCH_DEBOUNCE_MS = 350;

export default function SearchScreen({
  onOpenProduct,
}: {
  onOpenProduct: (productId: string) => void;
}) {
  const insets = useSafeAreaInsets();

  // What the TextInput shows — updates on every keystroke, never debounced.
  const [text, setText] = useState('');
  // What actually gets searched for — settles `SEARCH_DEBOUNCE_MS` after
  // typing pauses, so a burst of keystrokes fires one request, not N.
  const [debouncedTerm, setDebouncedTerm] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTerm(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const results = useSearch(debouncedTerm);
  const popular = useRailProducts('POPULAR');
  const cart = useCartActions();
  const columns = useGridColumns();

  const recentTerms = useRecentSearches((state) => state.terms);
  const addRecentSearch = useRecentSearches((state) => state.add);
  const removeRecentSearch = useRecentSearches((state) => state.remove);
  const clearRecentSearches = useRecentSearches((state) => state.clear);

  const hasQuery = debouncedTerm.trim().length >= 2;
  const items = results.data?.items ?? [];
  const popularItems = (popular.data?.products ?? []).slice(0, 10);

  // Instant (no network) completions across English/Hinglish/Hindi — see
  // searchSuggestions.ts. Shown the moment ANY text is typed, not gated
  // behind the 2-character/debounce threshold the real search query uses.
  const suggestions = text.trim().length > 0 ? suggestSearchTerms(text) : [];
  // True only while there is NOTHING on screen to show yet — once a first
  // page has landed, `keepPreviousData` keeps `items` populated across term
  // changes, so this stays false for every later keystroke (see `useSearch`).
  const firstLoad = hasQuery && results.isLoading && items.length === 0;

  const renderItem = ({ item }: { item: ProductSummaryDto }) => (
    <ProductCard
      product={item}
      qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
      busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
      onPress={onOpenProduct}
      onAdd={cart.add}
      onIncrement={cart.increment}
      onDecrement={cart.decrement}
    />
  );

  // A non-virtualized wrapping grid (not FlatList) — reused for both the
  // "Popular Products" section and the "You may also like" fallback below,
  // neither of which is more than ~10 items, so a real VirtualizedList would
  // be pure overhead (and one nested inside this screen's ScrollView would
  // print RN's "VirtualizedLists should never be nested" warning). Every
  // cell uses the SAME `ProductCard` at the SAME width — never a special
  // larger "first result" card.
  const renderProductGrid = (products: ProductSummaryDto[]) => (
    <View style={styles.popularGrid}>
      {products.map((item) => (
        <View key={item.id} style={[styles.popularCell, { width: `${100 / columns}%` }]}>
          <ProductCard
            product={item}
            qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
            busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
            onPress={onOpenProduct}
            onAdd={cart.add}
            onIncrement={cart.increment}
            onDecrement={cart.decrement}
          />
        </View>
      ))}
    </View>
  );

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.inputRow}>
          <SearchIcon size={18} color={colors.textSecondary} strokeWidth={2.2} />

          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Search for atta, doodh, cheeni…"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            autoFocus
            returnKeyType="search"
            autoCorrect={false}
            onSubmitEditing={() => addRecentSearch(text)}
          />

          {text.length > 0 && (
            <Pressable
              onPress={() => setText('')}
              hitSlop={10}
              style={styles.clearButton}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <X size={15} color={colors.onPrimary} strokeWidth={2.4} />
            </Pressable>
          )}
        </View>
      </View>

      {suggestions.length > 0 && (
        <View style={styles.suggestionsRow}>
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.term}
              style={styles.suggestionChip}
              onPress={() => setText(suggestion.term)}
              accessibilityRole="button"
              accessibilityLabel={`Search for ${suggestion.label}`}
            >
              <SearchIcon size={12} color={colors.textSecondary} strokeWidth={2.2} />
              <AppText variant="caption" style={styles.chipText}>
                {suggestion.label}
              </AppText>
            </Pressable>
          ))}
        </View>
      )}

      {cart.error && (
        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm }}>
          <NoticeStrip message={cart.error} />
        </View>
      )}

      {!hasQuery ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: spacing.xxl }}
          showsVerticalScrollIndicator={false}
        >
          {recentTerms.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <AppText variant="h3">Recent Searches</AppText>
                <Pressable onPress={clearRecentSearches} hitSlop={8}>
                  <AppText variant="caption" color={colors.primary}>
                    Clear all
                  </AppText>
                </Pressable>
              </View>

              <View style={styles.chipsRow}>
                {recentTerms.map((term) => (
                  <Pressable
                    key={term}
                    style={styles.chip}
                    onPress={() => setText(term)}
                    accessibilityRole="button"
                    accessibilityLabel={`Search again for ${term}`}
                  >
                    <Clock size={13} color={colors.textSecondary} strokeWidth={2.2} />
                    <AppText variant="caption" style={styles.chipText}>
                      {term}
                    </AppText>
                    <Pressable
                      hitSlop={10}
                      onPress={() => removeRecentSearch(term)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${term} from recent searches`}
                    >
                      <X size={12} color={colors.textMuted} strokeWidth={2.4} />
                    </Pressable>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          <View style={styles.section}>
            <AppText variant="h3" style={styles.sectionTitleOnly}>
              Popular Products
            </AppText>

            {popular.isLoading ? (
              <ProductGridSkeleton columns={columns} count={columns * 2} />
            ) : popularItems.length === 0 ? null : (
              renderProductGrid(popularItems)
            )}
          </View>
        </ScrollView>
      ) : firstLoad ? (
        <Loading />
      ) : items.length === 0 ? (
        results.isFetching ? (
          <Loading />
        ) : (
          <ScrollView
            contentContainerStyle={{ paddingBottom: spacing.xxl }}
            showsVerticalScrollIndicator={false}
          >
            <EmptyState
              title={`No products found for "${debouncedTerm}"`}
              hint="Try a different spelling or a shorter word."
            />

            {/* Only shown when there's something real to show — never a
                random fallback grid just to fill the screen. */}
            {popularItems.length > 0 && (
              <View style={styles.section}>
                <AppText variant="h3" style={styles.sectionTitleOnly}>
                  You may also like
                </AppText>
                {renderProductGrid(popularItems)}
              </View>
            )}
          </ScrollView>
        )
      ) : (
        <>
          <View style={styles.resultsHeader}>
            <AppText variant="caption" color={colors.textSecondary}>
              {results.data?.hasMore ? `${items.length}+` : items.length} result
              {items.length === 1 ? '' : 's'} for "{debouncedTerm}"
            </AppText>

            {/* A small inline spinner while a NEWER term is fetching, instead
                of blanking the grid that's still showing the last term's
                (still-visible-on-screen, still relevant-looking) results. */}
            {results.isFetching && <ActivityIndicator size="small" color={colors.primary} />}
          </View>

          <FlatList
            key={`grid-${columns}`}
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            numColumns={columns}
            contentContainerStyle={{
              paddingHorizontal: spacing.sm,
              paddingBottom: spacing.xxl,
            }}
            keyboardShouldPersistTaps="handled"
          />
        </>
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base,
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  clearButton: {
    width: 20,
    height: 20,
    borderRadius: radius.circle,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.textMuted,
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
  },
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySurface,
  },
  resultsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
  },
  section: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.base,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitleOnly: {
    marginBottom: spacing.xs,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  chipText: {
    color: colors.textPrimary,
  },
  popularGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing.xs,
  },
  popularCell: {
    padding: spacing.xs,
  },
});
