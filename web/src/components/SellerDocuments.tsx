/**
 * Seller documents UI shared by the Admin panel and the Seller Panel.
 *
 *   - DocumentUploadFields: Document Type, Document Number, Upload Document
 *     (Choose PDF). PDFs only, 10 MB max — the server re-checks the bytes.
 *   - DocumentNumber: the number MASKED by default; an authorised admin can
 *     Show it (fetched on demand from the audited endpoint, kept only in this
 *     component's state, never logged) and Hide it again.
 *   - ViewPdfButton: fetches the PDF with the caller's own session and opens
 *     it from a short-lived object URL — there is no public document link.
 */

import { useRef, useState } from 'react';
import { SellerDocumentType } from '@shared';
import { documentFileProblem, openPdfBlob } from '@/lib/sellers';
import { Button, Field, Icon, inputClass } from '@/components/ui';

export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  [SellerDocumentType.PAN_CARD]: 'PAN card',
  [SellerDocumentType.AADHAAR_CARD]: 'Aadhaar card',
  [SellerDocumentType.GST_CERTIFICATE]: 'GST certificate',
  [SellerDocumentType.FSSAI_LICENSE]: 'FSSAI licence',
  [SellerDocumentType.BUSINESS_LICENSE]: 'Business licence',
  [SellerDocumentType.BANK_PROOF]: 'Bank proof',
  [SellerDocumentType.OTHER]: 'Other',
};

export const DOCUMENT_TYPES = Object.values(SellerDocumentType);

/** Example + whether a number is required, per type (the server validates the format). */
const NUMBER_HINT: Record<string, { placeholder: string; required: boolean }> = {
  [SellerDocumentType.PAN_CARD]: { placeholder: 'e.g. ABCDE1234F', required: true },
  [SellerDocumentType.AADHAAR_CARD]: { placeholder: 'e.g. 2345 6789 1234', required: true },
  [SellerDocumentType.GST_CERTIFICATE]: { placeholder: 'e.g. 08ABCDE1234F1Z5', required: true },
  [SellerDocumentType.FSSAI_LICENSE]: { placeholder: '14-digit licence number', required: true },
  [SellerDocumentType.BUSINESS_LICENSE]: { placeholder: 'Licence number', required: true },
  [SellerDocumentType.BANK_PROOF]: { placeholder: 'Optional reference', required: false },
  [SellerDocumentType.OTHER]: { placeholder: 'Optional reference', required: false },
};

export function documentNumberRequired(type: string): boolean {
  return NUMBER_HINT[type]?.required ?? false;
}

export interface DocumentUploadValue {
  type: string;
  documentNumber: string;
  file: File | null;
}

export function DocumentUploadFields({
  value,
  onChange,
  errors,
}: {
  value: DocumentUploadValue;
  onChange: (next: DocumentUploadValue) => void;
  errors: Partial<Record<'type' | 'documentNumber' | 'file', string>>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const hint = NUMBER_HINT[value.type];
  const fileProblem = value.file ? documentFileProblem(value.file) : null;
  return (
    <div className="space-y-4">
      <Field label="Document Type" required>
        <select
          aria-label="Document Type"
          value={value.type}
          onChange={(event) => onChange({ ...value, type: event.target.value })}
          className={inputClass}
        >
          <option value="">Select Document Type</option>
          {DOCUMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {DOCUMENT_TYPE_LABEL[type] ?? type}
            </option>
          ))}
        </select>
        {errors.type && <span className="mt-1 block text-xs text-danger-600">{errors.type}</span>}
      </Field>

      <Field label="Document Number" required={hint?.required ?? true}>
        <input
          aria-label="Document Number"
          value={value.documentNumber}
          onChange={(event) => onChange({ ...value, documentNumber: event.target.value })}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
          placeholder={hint?.placeholder ?? 'The number printed on the document'}
          className={inputClass}
        />
        {errors.documentNumber && <span className="mt-1 block text-xs text-danger-600">{errors.documentNumber}</span>}
      </Field>

      <Field label="Upload Document" required hint="PDF only, up to 10 MB.">
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,application/pdf"
          aria-label="Choose PDF file"
          className="sr-only"
          onChange={(event) => {
            onChange({ ...value, file: event.target.files?.[0] ?? null });
            event.target.value = '';
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" className="h-4 w-4" />
            Choose PDF
          </Button>
          {value.file ? (
            <span className="min-w-0 text-sm">
              <span className="block truncate font-medium text-gray-900">{value.file.name}</span>
              {fileProblem ? (
                <span className="text-xs text-danger-600">{fileProblem}</span>
              ) : (
                <span className="text-xs font-semibold text-brand-600">✓ PDF selected</span>
              )}
            </span>
          ) : (
            <span className="text-sm text-gray-500">No file chosen</span>
          )}
        </div>
        {errors.file && <span className="mt-1 block text-xs text-danger-600">{errors.file}</span>}
      </Field>
    </div>
  );
}

/** Validates the form before upload; the server re-validates everything. */
export function validateDocumentUpload(value: DocumentUploadValue): Partial<Record<'type' | 'documentNumber' | 'file', string>> {
  const errors: Partial<Record<'type' | 'documentNumber' | 'file', string>> = {};
  if (!DOCUMENT_TYPES.includes(value.type as SellerDocumentType)) errors.type = 'Select the document type.';
  if (documentNumberRequired(value.type) && !value.documentNumber.trim()) errors.documentNumber = 'Enter the document number.';
  const fileProblem = documentFileProblem(value.file);
  if (fileProblem) errors.file = fileProblem;
  return errors;
}

/** Masked by default; Show/Hide only when `onReveal` is given (authorised admins). */
export function DocumentNumber({
  masked,
  onReveal,
}: {
  masked: string | null;
  onReveal?: () => Promise<string | null>;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!masked) return <span className="text-gray-500">Not provided</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono tracking-wide text-gray-900" aria-live="polite">
        {revealed ?? masked}
      </span>
      {onReveal && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (revealed) return setRevealed(null);
            setBusy(true);
            setFailed(false);
            try {
              setRevealed((await onReveal()) ?? null);
            } catch {
              setFailed(true);
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-60"
        >
          {busy ? '…' : revealed ? 'Hide' : 'Show'}
        </button>
      )}
      {failed && <span className="text-xs text-danger-600">Could not load the number.</span>}
    </span>
  );
}

export function ViewPdfButton({ load, label = 'View PDF' }: { load: () => Promise<Blob>; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(null);
          try {
            openPdfBlob(await load());
          } catch (error) {
            setFailed(error instanceof Error ? error.message : 'Could not open the PDF.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="eye" className="h-4 w-4" />
        {busy ? 'Opening…' : label}
      </Button>
      {failed && <span className="text-xs text-danger-600">{failed}</span>}
    </span>
  );
}

export function formatFileSize(bytes: number | null): string {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
