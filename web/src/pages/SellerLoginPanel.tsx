/**
 * Seller Detail → Overview → Seller login (admins with SELLER_MANAGE).
 *
 * VIEW ONLY: the owner's login EMAIL and last sign-in
 * (GET /admin/sellers/:id/login-credentials). A seller signs in with its email
 * and password, and the password is the seller's alone — chosen at signup,
 * changed in the Seller Panel, or reset by the seller with "Forgot Password?"
 * on the seller sign-in page. Admin never sees, issues, resets or changes it
 * (the server has no such route).
 *
 * The one admin action: a seller AdiOne created without an email gets its
 * login email set ONCE here (PUT /admin/sellers/:id/login-email); the seller
 * then uses "Forgot Password?" to choose its own password. An email that is
 * already set is the seller's and cannot be changed from here.
 */

import { useState, type FormEvent } from 'react';
import { Button, ErrorBanner, Field, Panel, Pill, inputClass } from '@/components/ui';
import { useSellerLoginAccount, useSetSellerLoginEmail } from '@/lib/sellers';

const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function SellerLoginPanel({ sellerId, suggestedEmail }: { sellerId: string; suggestedEmail: string | null }) {
  const account = useSellerLoginAccount(sellerId);
  const setLoginEmail = useSetSellerLoginEmail(sellerId);
  const [email, setEmail] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const current = account.data;
  const emailValue = email ?? suggestedEmail ?? '';

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaved(false);
    const result = await setLoginEmail.mutateAsync(emailValue.trim()).catch(() => null);
    if (result) {
      setEmail(null);
      setSaved(true);
    }
  }

  return (
    <Panel
      title="Seller login"
      action={current ? <Pill tone={current.email ? 'brand' : 'gray'}>{current.email ? 'Email + password' : 'No login email'}</Pill> : undefined}
    >
      {account.isPending ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : account.isError ? (
        <ErrorBanner message={account.error instanceof Error ? account.error.message : 'Could not load the seller login.'} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            The owner{current?.ownerName ? ` (${current.ownerName})` : ''} signs in to the Seller Panel with this email and their own
            password. Aadione never sees or sets seller passwords — a seller who forgot theirs uses “Forgot Password?” on the seller
            sign-in page.
          </p>
          <dl className="divide-y divide-gray-100 text-sm">
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-gray-500">Login email</dt>
              <dd className="font-medium text-gray-900">{current?.email ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-gray-500">Last sign-in</dt>
              <dd className="font-medium text-gray-900">{current?.lastLoginAt ? formatDateTime(current.lastLoginAt) : 'Never'}</dd>
            </div>
          </dl>

          {saved && current?.email && (
            <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700">
              Login email set. Ask the seller to open the seller sign-in page and use “Forgot Password?” with {current.email} to
              choose their password.
            </div>
          )}

          {current && !current.email && (
            <form onSubmit={(event) => void submit(event)} className="space-y-3">
              <ErrorBanner
                message={setLoginEmail.isError ? (setLoginEmail.error instanceof Error ? setLoginEmail.error.message : 'Could not set the login email.') : null}
              />
              <Field label="Login email" hint="Set once. The seller then chooses their own password with “Forgot Password?”.">
                <input
                  type="email"
                  value={emailValue}
                  onChange={(event) => setEmail(event.target.value)}
                  className={inputClass}
                  placeholder="owner@theirstore.in"
                  autoComplete="off"
                  required
                />
              </Field>
              <Button type="submit" disabled={setLoginEmail.isPending || !emailValue.trim()}>
                {setLoginEmail.isPending ? 'Saving…' : 'Set login email'}
              </Button>
            </form>
          )}
        </div>
      )}
    </Panel>
  );
}
