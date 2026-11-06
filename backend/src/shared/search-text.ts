/**
 * Smart Search — text normalisation, Hindi transliteration and the Hinglish
 * phonetic key.
 *
 * The ONE implementation every search in Aadione uses: the backend indexer
 * (product_search_terms), the backend query builder, and the in-memory
 * matcher the web panels and the mobile app run over lists they already hold
 * (search-match.ts). Because the index and every query go through the same
 * functions, "Kelaa", "keela", "केला" and "kela" reduce to the same keys no
 * matter which side wrote them.
 *
 * Three layers, each lossier than the one before — the original text is never
 * modified, only these derived forms are compared:
 *
 *   normalizeSearchText   lower case, NFKC, accents/punctuation removed,
 *                         whitespace collapsed. "Okra - Lady's Finger (भिंडी)"
 *                         -> "okra ladys finger भिंडी".
 *   devanagariToRoman     Hindi script -> Roman Hindi, with schwa deletion:
 *                         "टमाटर" -> "tamaatar", "नमकीन" -> "namkeen".
 *   phoneticKey           a spelling-insensitive key over Roman text: vowel
 *                         lengths, aspirates and doubled letters fold
 *                         together, so "aloo"/"alu"/"आलू" -> "alu" and
 *                         "pyaaz"/"pyaj"/"प्याज" -> "pyaj".
 *
 * Dependency-free (shared/ runs in Node, browsers and Hermes).
 */

const DEVANAGARI = /[ऀ-ॿ]/;
const DEVANAGARI_RUN = /[ऀ-ॿ]+/g;
const COMBINING_MARKS = /[̀-ͯ]/g;
const ZERO_WIDTH = /[​-‍﻿]/g;

/** True when the text contains any Hindi (Devanagari) character. */
export function hasDevanagari(text: string): boolean {
  return DEVANAGARI.test(text);
}

/**
 * Case-, accent-, punctuation- and spacing-insensitive form of `input`.
 *
 * Keeps letters (Latin and Devanagari, including vowel signs) and digits;
 * every other run of characters becomes one space. Apostrophes are dropped
 * rather than split on ("lady's" -> "ladys"). Latin accents are stripped
 * (NFKD) but Devanagari is recomposed (NFC) so its nukta forms stay stable.
 */
export function normalizeSearchText(input: string | null | undefined): string {
  if (!input) return '';
  const latinFolded = input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase();
  return latinFolded
    .replace(/['’‘`´]/g, '')
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .trim();
}

/** Normalised words of `input` ("Banana (केला)" -> ["banana", "केला"]). */
export function searchTokens(input: string | null | undefined): string[] {
  const normalized = normalizeSearchText(input);
  return normalized ? normalized.split(' ') : [];
}

/* -------------------------------------------------------------------------- */
/* Devanagari -> Roman Hindi                                                  */
/* -------------------------------------------------------------------------- */

const INDEPENDENT_VOWELS: Readonly<Record<string, string>> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e', 'ऎ': 'e', 'ऒ': 'o',
};

const VOWEL_SIGNS: Readonly<Record<string, string>> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e', 'ॆ': 'e', 'ॊ': 'o',
};

const CONSONANTS: Readonly<Record<string, string>> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'ळ': 'l',
};

/** A consonant followed by a nukta (़). Input is NFC, which always spells these as two characters. */
const NUKTA_FORMS: Readonly<Record<string, string>> = {
  'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y',
};

const VIRAMA = '्';
const NUKTA = '़';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';
const DEVANAGARI_DIGITS = '०१२३४५६७८९';

interface Syllable {
  /** Consonant cluster ('' for a word-initial vowel). */
  onset: string;
  /** The vowel; null = the consonant's inherent 'a' (the schwa). */
  vowel: string | null;
  /** Explicit virama: no vowel at all. */
  dead: boolean;
  /** Nasal / visarga suffix (anusvara -> 'n'). */
  coda: string;
}

function romanizeWord(word: string): string {
  const syllables: Syllable[] = [];
  const chars = Array.from(word);
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

    if (CONSONANTS[ch] !== undefined) {
      let roman = CONSONANTS[ch]!;
      i += 1;
      if (chars[i] === NUKTA) {
        roman = NUKTA_FORMS[ch] ?? roman;
        i += 1;
      }
      const syllable: Syllable = { onset: roman, vowel: null, dead: false, coda: '' };
      if (chars[i] === VIRAMA) {
        syllable.dead = true;
        i += 1;
      } else if (chars[i] !== undefined && VOWEL_SIGNS[chars[i]!] !== undefined) {
        syllable.vowel = VOWEL_SIGNS[chars[i]!]!;
        i += 1;
      }
      while (chars[i] === ANUSVARA || chars[i] === CHANDRABINDU || chars[i] === VISARGA) {
        syllable.coda += chars[i] === VISARGA ? 'h' : 'n';
        i += 1;
      }
      // A dead consonant joins the next consonant's onset (conjunct: स्क -> sk).
      const previous = syllables[syllables.length - 1];
      if (previous && previous.dead && previous.coda === '') {
        previous.onset += syllable.onset;
        previous.vowel = syllable.vowel;
        previous.dead = syllable.dead;
        previous.coda = syllable.coda;
      } else {
        syllables.push(syllable);
      }
      continue;
    }

    if (INDEPENDENT_VOWELS[ch] !== undefined) {
      const syllable: Syllable = { onset: '', vowel: INDEPENDENT_VOWELS[ch]!, dead: false, coda: '' };
      i += 1;
      while (chars[i] === ANUSVARA || chars[i] === CHANDRABINDU || chars[i] === VISARGA) {
        syllable.coda += chars[i] === VISARGA ? 'h' : 'n';
        i += 1;
      }
      syllables.push(syllable);
      continue;
    }

    const digit = DEVANAGARI_DIGITS.indexOf(ch);
    if (digit >= 0) {
      syllables.push({ onset: String(digit), vowel: '', dead: false, coda: '' });
      i += 1;
      continue;
    }

    // A stray sign (vowel sign / nasal with nothing before it): keep its sound.
    if (VOWEL_SIGNS[ch] !== undefined) syllables.push({ onset: '', vowel: VOWEL_SIGNS[ch]!, dead: false, coda: '' });
    else if (ch === ANUSVARA || ch === CHANDRABINDU) syllables.push({ onset: '', vowel: '', dead: false, coda: 'n' });
    i += 1;
  }

  // Schwa deletion (Hindi pronunciation, simplified Ohala rule):
  //  1. a word-final inherent 'a' is silent — "टमाटर" is "tamaatar", not
  //     "tamaatara" — unless the word is one syllable ("न" stays "na");
  //  2. a medial inherent 'a' is silent between a vowel-bearing syllable and
  //     a consonant + vowel ("नमकीन" -> "namkeen", "अदरक" -> "adrak"), never
  //     twice in a row.
  const deleted = new Array<boolean>(syllables.length).fill(false);
  const last = syllables.length - 1;
  if (last > 0 && syllables[last]!.vowel === null && !syllables[last]!.dead && syllables[last]!.coda === '') {
    deleted[last] = true;
  }
  for (let s = 1; s < last; s += 1) {
    const current = syllables[s]!;
    if (current.vowel !== null || current.dead || current.coda !== '' || deleted[s - 1]) continue;
    const before = syllables[s - 1]!;
    const after = syllables[s + 1]!;
    const beforeHasVowel = !before.dead;
    const afterIsConsonantVowel = after.onset !== '' && !after.dead && !deleted[s + 1];
    if (beforeHasVowel && afterIsConsonantVowel) deleted[s] = true;
  }

  return syllables
    .map((syllable, index) => {
      const vowel = syllable.dead || deleted[index] ? '' : (syllable.vowel ?? 'a');
      return `${syllable.onset}${vowel}${syllable.coda}`;
    })
    .join('');
}

/**
 * Roman Hindi for every Devanagari run in `text`; other characters pass
 * through untouched. "Banana (केला)" -> "Banana (kelaa)", "प्याज" -> "pyaaj".
 */
export function devanagariToRoman(text: string): string {
  if (!hasDevanagari(text)) return text;
  return text.normalize('NFC').replace(DEVANAGARI_RUN, (run) => romanizeWord(run));
}

/* -------------------------------------------------------------------------- */
/* Phonetic key                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Spelling-insensitive key of `text` (any script), with spaces removed.
 *
 * Both sides of every comparison go through this, so only the RELATIVE
 * folding matters: long/short vowels (ee~i, oo~u, aa~a), ai/ay~e (saib~seb,
 * kayla~kela), aspirates (dh~d, bh~b, kh~k…), w~v, z~j (pyaaz~pyaj), ph~f,
 * q~k, c~k (except "ch"), n~m before b/p (नींबू~nimbu), a final y~i, and
 * every doubled letter collapsed
 * (bananna~banana). `foldLongVowels: false` skips the ee/oo step — a second
 * query-side key that keeps "keela" -> "kela" (a typo of kela, not "kila").
 */
export function phoneticKey(text: string, options: { foldLongVowels?: boolean } = {}): string {
  const foldLongVowels = options.foldLongVowels ?? true;
  let s = normalizeSearchText(devanagariToRoman(text)).replace(/ /g, '');
  if (!s) return '';
  if (foldLongVowels) s = s.replace(/ee/g, 'i').replace(/oo/g, 'u');
  s = s
    .replace(/ph/g, 'f')
    .replace(/chh/g, 'ch')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/jh/g, 'j')
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/bh/g, 'b')
    .replace(/sh/g, 's')
    .replace(/ck/g, 'k')
    .replace(/c(?!h)/g, 'k')
    .replace(/q/g, 'k')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/x/g, 'ks')
    .replace(/n(?=[bp])/g, 'm')
    .replace(/a[iy]/g, 'e')
    .replace(/ey/g, 'e')
    .replace(/y$/, 'i')
    .replace(/(.)\1+/g, '$1');
  return s;
}

/** Bounded Levenshtein distance; returns `max + 1` as soon as it is exceeded. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Typo budget for a word of `length` letters: none below 4 (too many short
 * words are one letter apart — "seb"/"sev", "dal"/"daal" is handled by the
 * key), 1 up to 6 letters, 2 beyond.
 */
export function typoBudget(length: number): number {
  if (length < 4) return 0;
  return length <= 6 ? 1 : 2;
}

/**
 * Identifier form for order numbers, SKUs and codes: upper case, every
 * space, dash, slash, dot and '#' removed ("# ad-2611 06" -> "AD261106").
 */
export function normalizeIdentifier(input: string): string {
  return input.normalize('NFKC').toUpperCase().replace(/[\s\-_/.#]+/g, '');
}
