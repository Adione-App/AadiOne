/**
 * Audit Logs — platform-wide (GET /admin/audit-logs, CONFIG_WRITE: admins,
 * not STAFF). Who changed what and when, newest first. The server redacts
 * identity numbers, bank details and credential-like values before anything
 * reaches the browser; this page only displays what it receives.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { adminErrorMessage, marketplaceKeys, shortDateTime, toQuery, type AuditLogRow, type AuditLogs } from '@/lib/marketplace';
import { Button, Surface, inputClass } from '@/components/ui';
import { Pager } from '@/components/MarketplaceUi';
import { EmptyPanel, FilterSelect, LoadError, SearchBox, SkeletonList } from '@/seller/sellerUi';
import { useDebouncedValue } from '@/seller/sellerQueries';

const PAGE_SIZE = 30;

function Changes({ row }: { row: AuditLogRow }) {
  const show = (value: unknown) => (value === null || value === undefined ? '—' : JSON.stringify(value, null, 1));
  if (row.before == null && row.after == null) return <span className="text-gray-400">—</span>;
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-semibold text-brand-600 outline-none focus-visible:ring-2 focus-visible:ring-brand-400">View change</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-2 text-[11px] text-gray-700">
          <span className="block font-semibold text-gray-500">Before</span>
          {show(row.before)}
        </pre>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-2 text-[11px] text-gray-700">
          <span className="block font-semibold text-gray-500">After</span>
          {show(row.after)}
        </pre>
      </div>
    </details>
  );
}

export default function AuditLogsPage() {
  const [params, setParams] = useSearchParams();
  const [action, setAction] = useState(params.get('action') ?? '');
  const [entityId, setEntityId] = useState(params.get('q') ?? '');
  const debouncedAction = useDebouncedValue(action.trim(), 350);
  const debouncedId = useDebouncedValue(entityId.trim(), 350);
  const entityType = params.get('entityType') ?? 'ALL';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const update = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value && value !== 'ALL') next.set(key, value);
          else next.delete(key);
        }
        if (!('page' in changes)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  useEffect(() => {
    if ((params.get('action') ?? '') !== debouncedAction || (params.get('q') ?? '') !== debouncedId) {
      update({ action: debouncedAction || null, q: debouncedId || null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedAction, debouncedId]);

  // Date inputs are calendar days; the API takes instants ("to" is exclusive).
  const query = toQuery({
    entityType,
    action: debouncedAction,
    q: debouncedId,
    from: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : null,
    to: to ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000).toISOString() : null,
    page,
    pageSize: PAGE_SIZE,
  });
  const logs = useQuery({
    queryKey: marketplaceKeys.auditLogs(query),
    queryFn: () => api.get<AuditLogs>(`/admin/audit-logs?${query}`),
    placeholderData: (previous) => previous,
  });
  const filtered = entityType !== 'ALL' || debouncedAction !== '' || debouncedId !== '' || from !== '' || to !== '';

  return (
    <div className="space-y-5">
      <Surface className="grid gap-3 p-3 md:grid-cols-[repeat(3,minmax(0,1fr))_repeat(2,minmax(0,10rem))_auto] md:items-end">
        <FilterSelect
          label="Record type"
          value={entityType}
          options={[{ value: 'ALL', label: 'Any record' }, ...(logs.data?.entityTypes ?? []).map((e) => ({ value: e.entityType, label: `${e.entityType} (${e.count})` }))]}
          onChange={(next) => update({ entityType: next })}
        />
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Action starts with</span>
          <SearchBox value={action} onChange={setAction} placeholder="e.g. product. / seller." label="Filter by action" />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-500">Record ID</span>
          <SearchBox value={entityId} onChange={setEntityId} placeholder="ID or part of it" label="Filter by record ID" />
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => update({ from: e.target.value || null })} className={`${inputClass} h-11 py-0`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => update({ to: e.target.value || null })} className={`${inputClass} h-11 py-0`} />
        </label>
        <Button
          variant="ghost"
          disabled={!filtered}
          onClick={() => {
            setAction('');
            setEntityId('');
            update({ entityType: null, action: null, q: null, from: null, to: null });
          }}
        >
          Clear filters
        </Button>
      </Surface>

      {logs.isPending ? (
        <SkeletonList rows={6} label="Loading audit logs…" />
      ) : logs.isError ? (
        <LoadError message={adminErrorMessage(logs.error)} onRetry={() => void logs.refetch()} />
      ) : logs.data.items.length === 0 ? (
        <EmptyPanel icon="clipboard" title="No audit entries found" hint={filtered ? 'Try clearing your filters.' : undefined} />
      ) : (
        <>
          <Surface className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <caption className="sr-only">Audit log</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">When</th>
                    <th scope="col" className="px-3 py-3">Who</th>
                    <th scope="col" className="px-3 py-3">Action</th>
                    <th scope="col" className="px-3 py-3">Record</th>
                    <th scope="col" className="px-4 py-3">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {logs.data.items.map((row) => (
                    <tr key={row.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">{shortDateTime.format(new Date(row.at))}</td>
                      <td className="px-3 py-3">
                        {row.actor ? (
                          <>
                            <span className="text-gray-900">{row.actor.name ?? 'Unnamed'}</span>
                            <span className="block text-xs text-gray-500">{row.actor.role}</span>
                          </>
                        ) : (
                          <span className="text-gray-500">System</span>
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-gray-800">{row.action}</td>
                      <td className="px-3 py-3">
                        <span className="text-gray-900">{row.entityType}</span>
                        {row.entityId && <span className="block max-w-[14rem] truncate font-mono text-[11px] text-gray-500" title={row.entityId}>{row.entityId}</span>}
                      </td>
                      <td className="w-[38%] px-4 py-3">
                        <Changes row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
          <Pager page={page} pageSize={PAGE_SIZE} total={logs.data.total} onPage={(next) => update({ page: String(next) })} />
        </>
      )}
    </div>
  );
}
