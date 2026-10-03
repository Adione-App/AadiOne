/**
 * Seller document rules — PDF recognition by bytes, safe display names,
 * per-type document-number validation and masking. DB-free.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_BYTES,
  hasPdfSignature,
  isPdfMimeType,
  maskDocumentNumber,
  normaliseDocumentNumber,
  safeDocumentFileName,
} from '../../src/modules/sellers/seller-document-rules';
import { buildDocumentKey } from '../../src/infra/storage/private-documents';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');

describe('PDF recognition', () => {
  it('accepts real PDF bytes, with or without leading junk inside the first KB', () => {
    expect(hasPdfSignature(PDF)).toBe(true);
    expect(hasPdfSignature(Buffer.concat([Buffer.from('\n\n  '), PDF]))).toBe(true);
  });

  it('rejects a JPG, a PNG, text renamed to .pdf, and an empty file', () => {
    expect(hasPdfSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]))).toBe(false);
    expect(hasPdfSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(false);
    expect(hasPdfSignature(Buffer.from('hello, this is not a pdf'))).toBe(false);
    expect(hasPdfSignature(Buffer.alloc(0))).toBe(false);
    expect(hasPdfSignature(Buffer.from('%PDF-'))).toBe(false);
  });

  it('only PDF content types pass the first filter', () => {
    expect(isPdfMimeType('application/pdf')).toBe(true);
    expect(isPdfMimeType('application/x-pdf')).toBe(true);
    expect(isPdfMimeType('image/jpeg')).toBe(false);
    expect(isPdfMimeType('image/png')).toBe(false);
    expect(isPdfMimeType(undefined)).toBe(false);
  });

  it('the limit is 10 MB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('safe display file name', () => {
  it('keeps a normal name and forces .pdf', () => {
    expect(safeDocumentFileName('PAN_Card.pdf')).toBe('PAN_Card.pdf');
    expect(safeDocumentFileName('GST Certificate')).toBe('GST Certificate.pdf');
  });

  it('drops directories and dangerous characters — it is never a path', () => {
    expect(safeDocumentFileName('../../etc/passwd')).toBe('passwd.pdf');
    expect(safeDocumentFileName('C:\\Users\\x\\aadhaar.PDF')).toBe('aadhaar.pdf');
    expect(safeDocumentFileName('a"<b>|c.pdf')).toBe('abc.pdf');
    expect(safeDocumentFileName('')).toBe('document.pdf');
  });
});

describe('private storage keys', () => {
  it('are server-generated under the seller and never contain a client name', () => {
    const key = buildDocumentKey('0e7c835c-3f3e-4e58-b018-f4f5e6647c1a');
    expect(key).toMatch(/^seller-documents\/0e7c835c-3f3e-4e58-b018-f4f5e6647c1a\/[0-9a-f-]{36}\.pdf$/);
    expect(() => buildDocumentKey('../../evil')).toThrow();
  });
});

describe('document numbers', () => {
  it('PAN: normalised to upper case, validated, required', () => {
    expect(normaliseDocumentNumber('PAN_CARD', ' abcde1234f ')).toEqual({ ok: true, value: 'ABCDE1234F' });
    expect(normaliseDocumentNumber('PAN_CARD', 'ABCD1234F').ok).toBe(false);
    expect(normaliseDocumentNumber('PAN_CARD', '').ok).toBe(false);
  });

  it('Aadhaar: 12 digits, spaces/hyphens removed', () => {
    expect(normaliseDocumentNumber('AADHAAR_CARD', '2345-6789-1234')).toEqual({ ok: true, value: '234567891234' });
    expect(normaliseDocumentNumber('AADHAAR_CARD', '1234 5678 9012').ok).toBe(false);
    expect(normaliseDocumentNumber('AADHAAR_CARD', '23456789').ok).toBe(false);
  });

  it('GSTIN: the 15-character format', () => {
    expect(normaliseDocumentNumber('GST_CERTIFICATE', '08abcde1234f1z5')).toEqual({ ok: true, value: '08ABCDE1234F1Z5' });
    expect(normaliseDocumentNumber('GST_CERTIFICATE', '08ABCDE1234F1X5').ok).toBe(false);
  });

  it('FSSAI: 14 digits', () => {
    expect(normaliseDocumentNumber('FSSAI_LICENSE', '12345678901234')).toEqual({ ok: true, value: '12345678901234' });
    expect(normaliseDocumentNumber('FSSAI_LICENSE', '1234').ok).toBe(false);
  });

  it('bank proof and other documents: number optional', () => {
    expect(normaliseDocumentNumber('BANK_PROOF', '')).toEqual({ ok: true, value: null });
    expect(normaliseDocumentNumber('OTHER', 'ref 42/a')).toEqual({ ok: true, value: 'REF 42/A' });
    expect(normaliseDocumentNumber('OTHER', '<script>').ok).toBe(false);
  });

  it('masks by default: PAN keeps 1, Aadhaar keeps 4, GSTIN keeps none', () => {
    expect(maskDocumentNumber('PAN_CARD', 'ABCDE1234F')).toBe('•••••••••F');
    expect(maskDocumentNumber('AADHAAR_CARD', '234567891234')).toBe('••••••••1234');
    expect(maskDocumentNumber('GST_CERTIFICATE', '08ABCDE1234F1Z5')).toBe('•••••••••••••••');
    expect(maskDocumentNumber('PAN_CARD', null)).toBeNull();
  });
});
