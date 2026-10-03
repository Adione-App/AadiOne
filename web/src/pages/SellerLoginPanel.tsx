/**
 * Seller Detail → Overview → Seller login (admins with SELLER_MANAGE).
 *
 * Sellers do not register themselves: AdiOne creates the seller, then issues
 * the owner's panel login here — an email and a server-generated temporary
 * password. The password is shown ONCE (it is stored only as a hash and is
 * never returned again); the admin hands it to the seller, who signs in at
 * the web login (Seller) and is asked to change it. Issuing again resets it
 * and signs the seller out everywhere.
 */

import { useState, type FormEvent } from 'react';
import { Button, ErrorBanner, Field, Panel, Pill, inputClass } from '@/components/ui';
import { useIssueSellerLogin, useSellerLoginAccount } from '@/lib/sellers';

const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function SellerLoginPanel({ sellerId, suggestedEmail }: { sellerId: string; suggestedEmail: string | null }) {
  const account = useSellerLoginAccount(sellerId);
  const issue = useIssueSellerLogin(sellerId);
  const [email, setEmail] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const current = account.data;
  const emailValue = email ?? current?.email ?? suggestedEmail ?? '';
  const isReset = Boolean(current?.hasPassword);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (
      isReset &&
      !window.confirm(
        'Reset this seller’s password?\n\nA new temporary password replaces the current one, and the seller is signed out on every device.',
      )
    ) {
      return;
    }
    setIssued(null);
    setCopied(false);
    const result = await issue.mutateAsync(emailValue.trim()).catch(() => null);
    if (result) {
      setIssued({ email: result.email ?? emailValue.trim(), password: result.temporaryPassword });
      setEmail(null);
    }
  }

  const status = !current
    ? null
    : !current.hasPassword
      ? { tone: 'gray' as const, label: 'No login issued' }
      : current.passwordChangeRequired
        ? { tone: 'amber' as const, label: 'Temporary password' }
        : { tone: 'brand' as const, label: 'Password set by seller' };

  return (
    <Panel title="Seller login" action={status ? <Pill tone={status.tone}>{status.label}</Pill> : undefined}>
      {account.isPending ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : account.isError ? (
        <ErrorBanner message={account.error instanceof Error ? account.error.message : 'Could not load the seller login.'} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            The owner{current?.ownerName ? ` (${current.ownerName})` : ''} signs in to the Seller Panel with this email and a
            password Aadione issues. Sellers cannot create their own login.
          </p>
          {current?.hasPassword && (
            <dl className="divide-y divide-gray-100 text-sm">
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-gray-500">Login email</dt>
                <dd className="font-medium text-gray-900">{current.email ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-gray-500">Last sign-in</dt>
                <dd className="font-medium text-gray-900">{current.lastLoginAt ? formatDateTime(current.lastLoginAt) : 'Never'}</dd>
              </div>
            </dl>
          )}

          {issued && (
            <div role="status" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-sm">
              <p className="font-semibold text-amber-800">Temporary password — copy it now; it will not be shown again.</p>
              <p className="text-gray-700">
                Email: <span className="font-medium">{issued.email}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-lg bg-white px-2.5 py-1.5 font-mono text-base tracking-wide text-gray-900">{issued.password}</code>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(issued.password).then(() => setCopied(true));
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setIssued(null)}>
                  Done
                </Button>
              </div>
              <p className="text-gray-600">Give it to the seller privately. They will be asked to choose their own password after signing in.</p>
            </div>
          )}

          <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <ErrorBanner message={issue.isError ? (issue.error instanceof Error ? issue.error.message : 'Could not issue the login.') : null} />
            <Field label="Login email">
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
            <Button type="submit" disabled={issue.isPending || !emailValue.trim()}>
              {issue.isPending ? 'Issuing…' : isReset ? 'Reset password' : 'Create seller login'}
            </Button>
          </form>
        </div>
      )}
    </Panel>
  );
}
