/**
 * One information page (Privacy Policy, Terms & Conditions, About Aadione),
 * drawn natively from the server's structured blocks: headings, sub-headings,
 * paragraphs, bullet and numbered lists, with the bold / italic / underline
 * and links an admin added. Text only — nothing in a page is ever treated as
 * markup; links are only ever mailto:, tel: and https: (shared infoRichSegments). Email addresses, phone numbers and web addresses in the text are
 * tappable (shared infoTextSegments: only mailto:, tel:, wa.me and https:
 * links are ever made).
 *
 * Reading-first layout for small Android screens: 16 pt body at a relaxed
 * line height, clear section headings, no decorative blocks.
 */

import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { infoRichSegments, infoTextSegments, type InfoPageBlock, type InfoPageDto, type InfoTextRun } from '@shared';
import { colors, palette, radius, spacing } from '@shared/theme';
import { infoPageEffectiveNotice, infoPageMeta, sectionBlocks, type ContactRow } from '@/lib/infoPageFormat';
import { Bone, SkeletonGroup, useSkeletonPulse } from './Skeleton';
import { AppText } from './ui';

const BODY = { fontSize: 16, lineHeight: 26, color: palette.grey700 } as const;

/** Opens a page link; a phone without a mail / dialer app just does nothing. */
function openLink(href: string) {
  void Linking.openURL(href).catch(() => undefined);
}

/** Text whose email addresses, phone numbers and web addresses are links. */
export function LinkedText({ text, style }: { text: string; style?: object }) {
  const segments = infoTextSegments(text);
  return (
    <Text style={[BODY, style]}>
      {segments.map((segment, i) =>
        segment.href ? (
          <Text key={i} style={styles.link} accessibilityRole="link" onPress={() => openLink(segment.href!)} suppressHighlighting={false}>
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

/** Formatted wording: bold, italic, underline, the admin's links and the addresses found in the text. */
export function RichText({ text, runs, style }: { text: string; runs?: InfoTextRun[]; style?: object }) {
  return (
    <Text style={[BODY, style]}>
      {infoRichSegments(text, runs).map((segment, i) => {
        const format = [segment.bold && styles.bold, segment.italic && styles.italic, segment.underline && styles.underline];
        return segment.href ? (
          <Text key={i} style={[...format, styles.link]} accessibilityRole="link" onPress={() => openLink(segment.href!)} suppressHighlighting={false}>
            {segment.text}
          </Text>
        ) : (
          <Text key={i} style={format}>
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

function Block({ block }: { block: InfoPageBlock }) {
  switch (block.type) {
    case 'paragraph':
      return <RichText text={block.text} runs={block.runs} style={styles.paragraph} />;
    case 'subheading':
      return (
        <Text style={block.level === 2 ? styles.subheading : styles.minorHeading} accessibilityRole="header">
          {block.text}
        </Text>
      );
    case 'bullets':
    case 'numbered':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.bulletRow}>
              {block.type === 'numbered' ? <Text style={[BODY, styles.number]}>{i + 1}.</Text> : <View style={styles.bullet} />}
              <RichText text={item} runs={block.itemRuns?.[i]} style={styles.bulletText} />
            </View>
          ))}
        </View>
      );
  }
}

/** Title, "Last updated … · Version …" and, for wording published in advance, when it takes effect. */
export function InfoPageHeading({ title, page }: { title: string; page: Pick<InfoPageDto, 'version' | 'updatedAt'> & Partial<InfoPageDto> }) {
  const meta = infoPageMeta(page);
  const effective = infoPageEffectiveNotice(page);
  return (
    <View style={styles.heading}>
      <AppText variant="h1" style={styles.title}>
        {title}
      </AppText>
      {meta ? (
        <AppText variant="caption" color={colors.textSecondary} style={styles.meta}>
          {meta}
        </AppText>
      ) : null}
      {effective ? (
        <View style={styles.effective}>
          <AppText variant="body" color={palette.grey800}>
            {effective}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

export function InfoPageSections({ page }: { page: Pick<InfoPageDto, 'sections'> }) {
  return (
    <>
      {page.sections.map((section, s) => (
        <View key={`${s}-${section.heading}`} style={styles.section}>
          <Text style={styles.sectionHeading} accessibilityRole="header">
            {section.heading}
          </Text>
          {sectionBlocks(section).map((block, b) => (
            <Block key={b} block={block} />
          ))}
        </View>
      ))}
    </>
  );
}

/** Contact rows (label + tappable value); rows without a value never reach here. */
export function ContactRows({ rows }: { rows: ContactRow[] }) {
  return (
    <View style={styles.contactCard}>
      {rows.map((row, i) => {
        const content = (
          <View style={[styles.contactRow, i === rows.length - 1 && styles.contactRowLast]}>
            <AppText variant="caption" color={colors.textSecondary}>
              {row.label}
            </AppText>
            <AppText variant="bodyLarge" color={row.href ? colors.primaryDark : colors.textPrimary} style={styles.contactValue}>
              {row.value}
            </AppText>
          </View>
        );
        return row.href ? (
          <Pressable key={row.key} onPress={() => openLink(row.href!)} accessibilityRole="link" accessibilityLabel={`${row.label}: ${row.value}`}>
            {content}
          </Pressable>
        ) : (
          <View key={row.key}>{content}</View>
        );
      })}
    </View>
  );
}

/** What a page looks like while it loads: title, date line and a few paragraphs. */
export function InfoPageSkeleton() {
  const progress = useSkeletonPulse();
  return (
    <SkeletonGroup label="Loading page" style={styles.heading}>
      <Bone progress={progress} width="70%" height={28} />
      <Bone progress={progress} width="45%" height={12} style={{ marginTop: spacing.sm }} />
      {[0, 1, 2].map((s) => (
        <View key={s} style={{ marginTop: spacing.xl }}>
          <Bone progress={progress} width="55%" height={18} />
          <Bone progress={progress} width="100%" height={14} style={{ marginTop: spacing.md }} />
          <Bone progress={progress} width="96%" height={14} style={{ marginTop: spacing.sm }} />
          <Bone progress={progress} width="80%" height={14} style={{ marginTop: spacing.sm }} />
        </View>
      ))}
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  heading: { paddingTop: spacing.sm },
  title: { color: colors.textPrimary },
  meta: { marginTop: spacing.xs },
  effective: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.sm,
  },
  section: { marginTop: spacing.xl },
  sectionHeading: { fontSize: 18, lineHeight: 25, fontWeight: '600', color: colors.textPrimary },
  paragraph: { marginTop: spacing.sm },
  list: { marginTop: spacing.sm, gap: spacing.sm },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  // Centred on the first line of body text (line height 26).
  bullet: { width: 5, height: 5, borderRadius: radius.circle, backgroundColor: palette.grey500, marginTop: 11 },
  bulletText: { flex: 1, flexShrink: 1 },
  number: { minWidth: 22, color: palette.grey600 },
  subheading: { marginTop: spacing.lg, fontSize: 17, lineHeight: 24, fontWeight: '600', color: colors.textPrimary },
  minorHeading: { marginTop: spacing.md, fontSize: 16, lineHeight: 23, fontWeight: '600', color: palette.grey700 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  underline: { textDecorationLine: 'underline' },
  link: { color: colors.primaryDark, textDecorationLine: 'underline' },
  contactCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.base },
  contactRow: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  contactRowLast: { borderBottomWidth: 0 },
  contactValue: { marginTop: 2 },
});
