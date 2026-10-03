/**
 * Activate / Deactivate a seller — the ADMIN switch (`isActive`) only, via
 * PATCH /admin/sellers/:id/status with a required reason (audited). Shared by
 * the Sellers list and the Seller detail page so both behave identically.
 * The seller's own Store Open/Closed switch is never touched.
 */

import { useState } from 'react';
import { sellerErrorMessage, useSetSellerStatus } from '@/lib/sellers';
import { Button, ErrorBanner, Field, Modal, inputClass } from '@/components/ui';

/** Reasons are stored in the audit log (backend: 2–300 characters). */
export const STATUS_REASON_MIN = 2;
export const STATUS_REASON_MAX = 300;

export function SellerStatusModal({
  seller,
  onClose,
  onDone,
}: {
  seller: { id: string; name: string; isActive: boolean };
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const setStatus = useSetSellerStatus();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const deactivating = seller.isActive;
  const verb = deactivating ? 'Deactivate' : 'Activate';

  const confirm = () => {
    const trimmed = reason.trim();
    if (trimmed.length < STATUS_REASON_MIN) {
      setError('A reason is required.');
      return;
    }
    setError(null);
    setStatus.mutate(
      { sellerId: seller.id, isActive: !deactivating, reason: trimmed },
      {
        onSuccess: (detail) =>
          onDone(
            detail.isActive
              ? `${detail.name} is active again. Its own Store Open/Closed switch was not changed.`
              : `${detail.name} is deactivated and cannot take orders.`,
          ),
      },
    );
  };

  return (
    <Modal
      title={`${verb} seller`}
      subtitle={seller.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={setStatus.isPending}>
            Cancel
          </Button>
          <Button variant={deactivating ? 'danger' : 'primary'} onClick={confirm} disabled={setStatus.isPending}>
            {setStatus.isPending ? `${verb.slice(0, -1)}ing…` : verb}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          {deactivating
            ? 'The seller stops taking orders immediately. Its own Store Open/Closed switch, hours and onboarding are left unchanged.'
            : 'The seller goes back to its own Store Open/Closed switch and hours. Onboarding approval is still required before it can take orders.'}
        </p>
        {setStatus.isError && (
          <ErrorBanner message={sellerErrorMessage(setStatus.error, `Could not ${verb.toLowerCase()} the seller.`)} />
        )}
        <Field label="Reason" required hint={`Recorded in the audit log. ${reason.trim().length}/${STATUS_REASON_MAX}`}>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value.slice(0, STATUS_REASON_MAX))}
            rows={3}
            className={inputClass}
            aria-invalid={error ? true : undefined}
          />
          {error && <span className="mt-1 block text-xs text-danger-600">{error}</span>}
        </Field>
      </div>
    </Modal>
  );
}
