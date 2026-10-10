/**
 * A linear-time, bounded XML tokenizer for the parts of an .xlsx file.
 *
 * Why not regexes: patterns like `<row>([\s\S]*?)</row>` rescan the rest of
 * the document for every unclosed tag, so a few KB of malformed XML can pin a
 * CPU for minutes. Here the read position only ever moves forward: each tag,
 * comment or text run is found with one forward search from the current
 * position, and the scan STOPS (throws) at the first construct that is
 * malformed or over a limit. Total work is O(document length).
 *
 * Deliberately minimal: no DTDs or entity definitions (refused — no entity
 * expansion), no namespaces beyond keeping the prefixed name, no validation
 * beyond well-formed nesting: every closing tag must match the innermost
 * open element, and the document must end with every element closed.
 */

import { SheetError } from './csv';

export interface XmlLimits {
  /** Characters in the whole part. */
  maxLength: number;
  /** Characters inside one `<…>`. */
  maxTagLength: number;
  /** Open elements at once. */
  maxDepth: number;
  /** Characters in one text run between tags. */
  maxTextLength: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxLength: 20 * 1024 * 1024,
  maxTagLength: 8 * 1024,
  maxDepth: 64,
  maxTextLength: 64 * 1024,
};

export interface XmlHandler {
  open?(name: string, attrs: string, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const damaged = (what: string) => new SheetError('The Excel file is damaged or not a normal workbook. Save it again as .xlsx (or CSV) and upload it.', `xlsx xml: ${what}`);

const NAME = /^[A-Za-z_][\w.:-]*/;

export function scanXml(xml: string, handler: XmlHandler, limits: XmlLimits = DEFAULT_XML_LIMITS): void {
  if (xml.length > limits.maxLength) throw damaged(`part too large (${xml.length})`);
  const n = xml.length;
  let pos = 0;
  /** Open element names, innermost last (bounded by maxDepth). */
  const open: string[] = [];

  const emitText = (from: number, to: number) => {
    if (to <= from) return;
    if (to - from > limits.maxTextLength) throw damaged('text run too long');
    handler.text?.(xml.slice(from, to));
  };

  while (pos < n) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      emitText(pos, n);
      break;
    }
    emitText(pos, lt);

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw damaged('unclosed comment');
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw damaged('unclosed CDATA');
      if (end - (lt + 9) > limits.maxTextLength) throw damaged('CDATA too long');
      handler.text?.(xml.slice(lt + 9, end));
      pos = end + 3;
      continue;
    }
    // DOCTYPE / ENTITY declarations: refused outright (no entity expansion, ever).
    if (xml.startsWith('<!', lt)) throw damaged('declarations are not allowed');
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1 || end - lt > limits.maxTagLength) throw damaged('bad processing instruction');
      pos = end + 2;
      continue;
    }

    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1 || gt - lt > limits.maxTagLength) throw damaged('unclosed or oversized tag');
    const body = xml.slice(lt + 1, gt);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (!NAME.test(name)) throw damaged('bad closing tag');
      // Structure is verified, not just counted: </b> must close the innermost <b>.
      if (open.pop() !== name) throw damaged('mismatched closing tag');
      handler.close?.(name);
    } else {
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const name = NAME.exec(inner)?.[0];
      if (!name) throw damaged('bad tag');
      if (!selfClosing) {
        if (open.length >= limits.maxDepth) throw damaged('nesting too deep');
        open.push(name);
      }
      handler.open?.(name, inner.slice(name.length), selfClosing);
    }
    pos = gt + 1;
  }
  if (open.length > 0) throw damaged('unclosed element');
}

export function decodeXml(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_m, ref: string) => {
      if (ref === 'amp') return '&';
      if (ref === 'lt') return '<';
      if (ref === 'gt') return '>';
      if (ref === 'quot') return '"';
      if (ref === 'apos') return "'";
      const code = ref.startsWith('#x') ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

/** One attribute value from a tag's attribute text (bounded by maxTagLength). */
export function attr(attrs: string, name: string): string | null {
  // Linear walk, no regex backtracking: find ` name="` then the closing quote.
  let from = 0;
  for (;;) {
    const at = attrs.indexOf(`${name}="`, from);
    if (at === -1) return null;
    const before = at === 0 ? ' ' : attrs[at - 1]!;
    const end = attrs.indexOf('"', at + name.length + 2);
    if (end === -1) return null;
    if (/\s/.test(before)) return decodeXml(attrs.slice(at + name.length + 2, end));
    from = end + 1;
  }
}
