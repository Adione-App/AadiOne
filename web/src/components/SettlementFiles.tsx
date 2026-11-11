/**
 * Settlement files, shared by the admin and seller panels:
 *
 *   - the statement PDF   GET  …/settlements/:id/statement.pdf   (download / share)
 *   - the payment proof   GET  …/settlements/:id/payout-proof    (view)
 *
 * Both come through the authorised API as blobs — there is no public URL.
 * "Share" uses the device's own share sheet (Web Share API with files) where
 * the browser supports it, e.g. phones; elsewhere the PDF is downloaded.
 */

import { useState } from 'react';
import { Button } from '@/components/ui';
import { statementFileName } from '@/lib/settlementFiles';

export { MAX_PROOF_BYTES, PROOF_ACCEPT, proofFileProblem, proofFormData, statementFileName } from '@/lib/settlementFiles';

export interface SettlementFileInfo {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED';
  payoutReference?: string | null;
  hasPayoutProof?: boolean;
}

type GetBlob = (path: string) => Promise<Blob>;

/** Saves a blob under `fileName` through a short-lived object URL. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** True when this browser can hand a file to the device's share sheet. */
export function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array([37, 80, 68, 70])], 'probe.pdf', { type: 'application/pdf' });
    return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** Opens a fetched image / PDF in a new tab (object URL; nothing public). */
export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank');
  if (opened) opened.opener = null;
  else saveBlob(blob, 'payment-proof');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Download / Share the statement, and View the payment proof when there is one
 * the viewer may open (`proofVisible`: admins always, sellers once PAID).
 */
export function SettlementFileButtons({
  settlement,
  basePath,
  getBlob,
  proofVisible,
  compact = false,
}: {
  settlement: SettlementFileInfo;
  /** "/admin/settlements" or "/seller/settlements". */
  basePath: string;
  getBlob: GetBlob;
  proofVisible: boolean;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<'download' | 'share' | 'proof' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileName = statementFileName(settlement);
  const size = compact ? 'min-h-9 px-3 text-xs' : '';

  async function run(kind: 'download' | 'share' | 'proof') {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'proof') {
        openBlob(await getBlob(`${basePath}/${settlement.id}/payout-proof`));
        return;
      }
      const blob = await getBlob(`${basePath}/${settlement.id}/statement.pdf`);
      const pdf = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
      if (kind === 'share') {
        const file = new File([pdf], fileName, { type: 'application/pdf' });
        try {
          await navigator.share({ files: [file], title: 'Aadione settlement statement' });
        } catch (shareError) {
          // The person closed the share sheet: nothing to report.
          if ((shareError as Error)?.name !== 'AbortError') saveBlob(pdf, fileName);
        }
        return;
      }
      saveBlob(pdf, fileName);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The file could not be loaded. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        <Button variant="secondary" className={size} disabled={busy !== null} onClick={() => void run('download')}>
          {busy === 'download' ? 'Preparing PDF…' : 'Statement PDF'}
        </Button>
        {canShareFiles() && (
          <Button variant="ghost" className={size} disabled={busy !== null} onClick={() => void run('share')}>
            {busy === 'share' ? 'Preparing…' : 'Share'}
          </Button>
        )}
        {proofVisible && settlement.hasPayoutProof && (
          <Button variant="ghost" className={size} disabled={busy !== null} onClick={() => void run('proof')}>
            {busy === 'proof' ? 'Opening…' : 'Payment proof'}
          </Button>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
