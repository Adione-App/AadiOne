/**
 * Seller document rules — pure, no I/O.
 *
 *   - document NUMBER: normalised and validated per document type; masked for
 *     every read except an authorised, audited admin reveal.
 *   - document FILE: PDF only, at most 10 MB, recognised by its bytes (the
 *     `%PDF-` signature), never by its name or the browser's claimed type.
 */

import type { SellerDocumentType } from '../../shared';

/** 10 MB — the upload limit for one document PDF. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const PDF_CONTENT_TYPE = 'application/pdf';

/** Content types browsers/OSes report for a PDF (the bytes are checked separately). */
const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf']);

export function isPdfMimeType(mimeType: string | undefined): boolean {
  return !!mimeType && PDF_MIME_TYPES.has(mimeType.toLowerCase().split(';')[0]!.trim());
}

/**
 * True when the bytes are a PDF: the `%PDF-` header must appear within the
 * first 1024 bytes (the PDF spec's allowance), followed by a version digit.
 */
export function hasPdfSignature(body: Buffer): boolean {
  if (body.length < 8) return false;
  const head = body.subarray(0, Math.min(body.length, 1024)).toString('latin1');
  const at = head.indexOf('%PDF-');
  return at !== -1 && /^%PDF-\d/.test(head.slice(at, at + 6));
}

/**
 * A display name for the uploaded file: the base name only (no directories),
 * printable characters, at most 120 characters, always ending in `.pdf`. It
 * is shown and used as the download name — never as a storage path.
 */
export function safeDocumentFileName(originalName: string | undefined): string {
  const base = (originalName ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stem = cleaned.replace(/\.pdf$/i, '').slice(0, 115).trim();
  return `${stem || 'document'}.pdf`;
}

/* -------------------------------------------------------------------------- */
/* Document numbers                                                           */
/* -------------------------------------------------------------------------- */

interface NumberRule {
  required: boolean;
  normalise: (raw: string) => string;
  valid: (value: string) => boolean;
  message: string;
  /** Characters left visible at the end of a masked number. */
  keep: number;
}

const upperCompact = (raw: string) => raw.toUpperCase().replace(/[\s-]/g, '');
const digitsOnly = (raw: string) => raw.replace(/[\s-]/g, '');
const generic = (raw: string) => raw.trim().replace(/\s+/g, ' ').toUpperCase();
const GENERIC_VALID = (value: string) => /^[A-Z0-9][A-Z0-9 /.-]{2,39}$/.test(value);

const RULES: Record<SellerDocumentType, NumberRule> = {
  PAN_CARD: {
    required: true,
    normalise: upperCompact,
    valid: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v),
    message: 'Enter a valid PAN, e.g. ABCDE1234F.',
    keep: 1,
  },
  AADHAAR_CARD: {
    required: true,
    normalise: digitsOnly,
    valid: (v) => /^[2-9][0-9]{11}$/.test(v),
    message: 'Enter the 12-digit Aadhaar number.',
    keep: 4,
  },
  GST_CERTIFICATE: {
    required: true,
    normalise: upperCompact,
    valid: (v) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v),
    message: 'Enter a valid 15-character GSTIN, e.g. 08ABCDE1234F1Z5.',
    keep: 0,
  },
  FSSAI_LICENSE: {
    required: true,
    normalise: digitsOnly,
    valid: (v) => /^[0-9]{14}$/.test(v),
    message: 'Enter the 14-digit FSSAI licence number.',
    keep: 4,
  },
  BUSINESS_LICENSE: {
    required: true,
    normalise: generic,
    valid: GENERIC_VALID,
    message: 'Enter the licence number (3–40 letters, digits, spaces, / . -).',
    keep: 2,
  },
  BANK_PROOF: {
    required: false,
    normalise: generic,
    valid: GENERIC_VALID,
    message: 'Enter a reference number of 3–40 letters, digits, spaces, / . -.',
    keep: 2,
  },
  OTHER: {
    required: false,
    normalise: generic,
    valid: GENERIC_VALID,
    message: 'Enter a reference number of 3–40 letters, digits, spaces, / . -.',
    keep: 2,
  },
};

export type DocumentNumberResult = { ok: true; value: string | null } | { ok: false; message: string };

/** Normalises and validates the number for `type`. Empty means "none" — allowed only where not required. */
export function normaliseDocumentNumber(type: SellerDocumentType, raw: string | null | undefined): DocumentNumberResult {
  const rule = RULES[type];
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return rule.required ? { ok: false, message: 'Enter the document number.' } : { ok: true, value: null };
  }
  const value = rule.normalise(trimmed);
  return rule.valid(value) ? { ok: true, value } : { ok: false, message: rule.message };
}

/** `ABCDE1234F` → `•••••••••F`; Aadhaar keeps the last 4; GSTIN is fully masked. */
export function maskDocumentNumber(type: SellerDocumentType, value: string | null): string | null {
  if (!value) return null;
  const keep = Math.min(RULES[type].keep, Math.max(0, value.length - 4));
  return '•'.repeat(value.length - keep) + value.slice(value.length - keep);
}
