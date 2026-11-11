/**
 * Pure helpers for settlement files (no React) — used by
 * components/SettlementFiles.tsx and the settlement screens.
 */

/** "Aadione-Statement-2026-10-01-to-2026-10-31-1a2b3c4d.pdf" — dates in Indian time. */
export function statementFileName(s: { id: string; periodStart: string; periodEnd: string }): string {
  const day = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return `Aadione-Statement-${day(s.periodStart)}-to-${day(s.periodEnd)}-${s.id.slice(0, 8)}.pdf`;
}

/** Proof files the API accepts: an image (JPEG / PNG / WebP) or a PDF, at most 5 MB. */
export const PROOF_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

/** Why a chosen proof file would be refused, or null when it is fine (or none is chosen). */
export function proofFileProblem(file: { type: string; size: number } | null): string | null {
  if (!file) return null;
  if (!PROOF_ACCEPT.split(',').includes(file.type)) return 'Choose a JPEG, PNG or WebP image, or a PDF.';
  if (file.size > MAX_PROOF_BYTES) return 'The file must be 5 MB or smaller.';
  return null;
}

/** multipart body for POST …/payout-proof. */
export function proofFormData(file: File): FormData {
  const data = new FormData();
  data.append('file', file, file.name);
  return data;
}
