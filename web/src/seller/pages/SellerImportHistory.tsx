/**
 * Seller Import History — /seller/products/imports. Every bulk import of this
 * seller, newest first (GET /seller/imports, paged), with its status and
 * summary; a row opens the import (preview, progress or results).
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Icon, Pill, Surface } from '@/components/ui';
import { sellerErrorMessage } from '../sellerApi';
import { EmptyPanel, LoadError, SkeletonList, linkClass } from '../sellerUi';
import { STATUS_LABEL, STATUS_TONE, useImportHistory } from '../importApi';

export default function SellerImportHistoryPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const history = useImportHistory(page);
  const pages = Math.max(1, Math.ceil((history.data?.total ?? 0) / 20));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/seller/products" className={linkClass}>
          ← Products
        </Link>
        <Button onClick={() => navigate('/seller/products/import')}>
          <Icon name="upload" className="h-4 w-4" /> New import
        </Button>
      </div>
      <Surface className="p-4">
        <h1 className="mb-3 text-lg font-semibold text-gray-900">Import History</h1>
        {history.isPending ? (
          <SkeletonList rows={4} label="Loading imports…" />
        ) : history.isError ? (
          <LoadError message={sellerErrorMessage(history.error)} onRetry={() => void history.refetch()} />
        ) : history.data.items.length === 0 ? (
          <EmptyPanel title="No imports yet" hint="Upload a product list or photos from Products → Bulk Product Import." />
        ) : (
          <ul className="divide-y divide-gray-100">
            {history.data.items.map((job) => (
              <li key={job.id}>
                <Link to={`/seller/products/import/${job.id}`} className="flex flex-col gap-1 py-3 hover:bg-gray-50 sm:flex-row sm:items-center sm:gap-4 sm:px-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-gray-900">
                      {[job.fileName, job.archiveName].filter(Boolean).join(' + ') || 'Import'}
                    </p>
                    <p className="text-xs text-gray-500">
                      {new Date(job.createdAt).toLocaleString('en-IN')} · {job.kind === 'IMAGES' ? 'Photos only' : job.mode === 'CREATE' ? 'New products' : 'Update existing'}
                      {job.completedAt ? ` · finished ${new Date(job.completedAt).toLocaleString('en-IN')}` : ''}
                    </p>
                  </div>
                  <p className="text-sm text-gray-700">
                    {job.status === 'COMPLETED'
                      ? `${job.kind === 'IMAGES' ? job.updatedCount : job.createdCount + job.updatedCount} done · ${job.failedCount} failed · ${job.skippedCount} skipped`
                      : job.totalRows > 0
                        ? `${job.totalRows} rows`
                        : (job.errorSummary ?? '')}
                  </p>
                  <Pill tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</Pill>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-sm">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span className="text-gray-600">
              Page {page} of {pages}
            </span>
            <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        )}
      </Surface>
    </div>
  );
}
