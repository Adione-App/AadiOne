/**
 * One information page (Privacy Policy, Terms & Conditions, About Aadione),
 * drawn natively from the server's structured blocks: headings, paragraphs
 * and bullet lists. Plain text only — nothing in a page is ever treated as
 * markup or a link.
 */

import { StyleSheet, View } from 'react-native';
import type { InfoPageDto } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { infoPageMeta, sectionBlocks } from '@/lib/infoPageFormat';
import { AppText } from './ui';

export function InfoPageMeta({ page }: { page: Pick<InfoPageDto, 'version' | 'effectiveDate' | 'updatedAt'> }) {
  const meta = infoPageMeta(page);
  if (!meta) return null;
  return (
    <AppText variant="caption" color={colors.textSecondary}>
      {meta}
    </AppText>
  );
}

export function InfoPageSections({ page }: { page: Pick<InfoPageDto, 'sections'> }) {
  return (
    <>
      {page.sections.map((section, s) => (
        <View key={`${s}-${section.heading}`} style={styles.section}>
          <AppText variant="h3" color={colors.textPrimary}>
            {section.heading}
          </AppText>
          {sectionBlocks(section).map((block, b) =>
            block.type === 'paragraph' ? (
              <AppText key={b} variant="body" color={colors.textSecondary} style={styles.paragraph}>
                {block.text}
              </AppText>
            ) : (
              <View key={b} style={styles.list}>
                {block.items.map((item, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <View style={styles.bullet} />
                    <AppText variant="body" color={colors.textSecondary} style={styles.bulletText}>
                      {item}
                    </AppText>
                  </View>
                ))}
              </View>
            ),
          )}
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg },
  paragraph: { marginTop: spacing.sm },
  list: { marginTop: spacing.sm, gap: spacing.xs },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  // Aadione green, centred on the first line of body text.
  bullet: { width: 6, height: 6, borderRadius: radius.circle, backgroundColor: colors.primary, marginTop: 9 },
  bulletText: { flex: 1 },
});
