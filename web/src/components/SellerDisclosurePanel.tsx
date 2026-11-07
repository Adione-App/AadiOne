/**
 * "Shown to customers" — the seller disclosure customers see from a product,
 * a restaurant or an order (shared/seller-disclosure.ts), the details still
 * missing, and the customer-care contact the seller publishes.
 *
 * Used twice with different clients: the Admin Panel's seller page
 * (GET/PATCH /admin/sellers/:id/disclosure) and the Seller Panel's profile
 * (GET/PATCH /seller/disclosure). The contact is opt-in and separate from the
 * business phone / owner mobile, which customers never see.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SellerDetailsDto } from '@shared';
import { Button, ErrorBanner, Field, Panel, Pill, Spinner, inputClass } from '@/components/ui';

export interface SellerDisclosureData {
  sellerId: string;
  customerCarePhone: string | null;
  customerCareEmail: string | null;
  preview: SellerDetailsDto | null;
  gaps: string[];
}

interface Client {
  get: <T>(path: string) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
}

const errorText = (error: unknown): string | null => (error instanceof Error ? error.message : error ? 'Something went wrong.' : null);

export function SellerDisclosurePanel({
  client,
  path,
  queryKey,
  canEdit,
  audience,
}: {
  client: Client;
  /** "/admin/sellers/<id>/disclosure" or "/seller/disclosure". */
  path: string;
  queryKey: readonly unknown[];
  canEdit: boolean;
  audience: 'admin' | 'seller';
}) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => client.get<SellerDisclosureData>(path) });
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    setPhone(query.data?.customerCarePhone ?? '');
    setEmail(query.data?.customerCareEmail ?? '');
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => client.patch<SellerDisclosureData>(path, { customerCarePhone: phone.trim() || null, customerCareEmail: email.trim() || null }),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });

  if (query.isLoading) return <Panel title="Shown to customers"><Spinner /></Panel>;
  if (query.isError || !query.data) return <Panel title="Shown to customers"><ErrorBanner message={errorText(query.error) ?? 'Could not load.'} /></Panel>;
  const data = query.data;
  const dirty = phone.trim() !== (data.customerCarePhone ?? '') || email.trim() !== (data.customerCareEmail ?? '');

  return (
    <Panel
      title="Shown to customers"
      action={data.gaps.length === 0 ? <Pill tone="brand">Complete</Pill> : <Pill tone="amber">{data.gaps.length} missing</Pill>}
    >
      <p className="mb-3 text-xs text-gray-500">
        Customers see these seller details on the restaurant menu and in their order (Consumer Protection (E-Commerce) Rules, 2020).
        The business phone and owner mobile are never shown.
      </p>
      {data.gaps.length > 0 ? (
        <div className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="font-semibold">Missing:</p>
          <ul className="list-disc pl-5">
            {data.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
          {audience === 'seller' ? (
            <p className="mt-1 text-xs">Business name and FSSAI number come from your onboarding details; ask Aadione support to correct them.</p>
          ) : (
            <p className="mt-1 text-xs">Business name and FSSAI come from the seller's onboarding profile.</p>
          )}
        </div>
      ) : null}

      {data.preview ? (
        <dl className="mb-4 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-500">Seller</dt>
          <dd>{data.preview.displayName}</dd>
          {data.preview.businessName ? (
            <>
              <dt className="text-gray-500">Business name</dt>
              <dd>{data.preview.businessName}</dd>
            </>
          ) : null}
          <dt className="text-gray-500">Address</dt>
          <dd>{data.preview.address}</dd>
          {data.preview.fssaiNumber ? (
            <>
              <dt className="text-gray-500">FSSAI</dt>
              <dd>{data.preview.fssaiNumber}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="mb-4 text-sm text-gray-500">Not shown to customers until the seller is approved.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer-care phone" hint="Shown to customers. Leave empty to show none.">
          <input className={inputClass} value={phone} maxLength={15} disabled={!canEdit} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Customer-care email" hint="Shown to customers. Leave empty to show none.">
          <input className={inputClass} type="email" value={email} maxLength={160} disabled={!canEdit} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        {canEdit ? (
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save contact'}
          </Button>
        ) : null}
        <ErrorBanner message={errorText(save.error)} />
      </div>
    </Panel>
  );
}
