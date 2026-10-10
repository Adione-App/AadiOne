/**
 * Seller Bulk Import — /seller/products/import (upload) and
 * /seller/products/import/:id (one import: checking → preview → importing →
 * results). The server does the work in the background; this page uploads,
 * polls, and shows exactly what the server reports — a success message only
 * once the server says the import is COMPLETED.
 *
 *   Products file   CSV / Excel (+ optional ZIP of images named in the file)
 *   Images only     a ZIP (or up to 50 images) matched to existing products
 *                   by SKU or barcode in the file name; unmatched ones are
 *                   assigned by hand
 */

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PRODUCT_IMPORT_COLUMNS, PRODUCT_IMPORT_LIMITS, type ProductImportDto, type ProductImportMode, type ProductImportRowDto } from '@shared';
import { Button, ErrorBanner, Icon, Modal, Pill, Surface, inputClass } from '@/components/ui';
import { imageSrc } from '@/lib/image';
import { sellerErrorMessage } from '../sellerApi';
import { sellerKeys } from '../sellerQueries';
import { ChipTabs, LoadError, SkeletonBlock, linkClass, toast } from '../sellerUi';
import {
  ROW_LABEL,
  ROW_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  WORKING,
  cancelImport,
  changeImportMode,
  confirmImport,
  decideImportRow,
  downloadErrorReport,
  downloadTemplate,
  importKeys,
  retryImport,
  submitImportForApproval,
  uploadImagesOnly,
  uploadProductFile,
  useImport,
  useImportImages,
  useImportRows,
  type RowFilter,
} from '../importApi';

const MB = 1024 * 1024;

export default function SellerBulkImportPage() {
  const { id } = useParams();
  return id ? <ImportDetail id={id} /> : <ImportUpload />;
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

function DropZone({
  label,
  hint,
  accept,
  multiple = false,
  files,
  onFiles,
  disabled,
}: {
  label: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  files: File[];
  onFiles: (files: File[]) => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (!disabled) onFiles(Array.from(event.dataTransfer.files).slice(0, multiple ? PRODUCT_IMPORT_LIMITS.maxLooseImages : 1));
  };
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={`rounded-xl border-2 border-dashed p-4 text-sm ${over ? 'border-brand-500 bg-brand-50' : 'border-gray-300 bg-white'}`}
    >
      <p className="font-semibold text-gray-900">{label}</p>
      <p className="mt-0.5 text-gray-600">{hint}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={disabled} onClick={() => input.current?.click()}>
          <Icon name="upload" className="h-4 w-4" /> {files.length ? 'Choose again' : 'Choose file'}
        </Button>
        <span className="text-gray-500">or drag {multiple ? 'files' : 'a file'} here</span>
        <input
          ref={input}
          type="file"
          className="sr-only"
          accept={accept}
          multiple={multiple}
          aria-label={label}
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <ul className="mt-3 space-y-1 text-gray-800">
          {files.slice(0, 5).map((f) => (
            <li key={f.name} className="flex items-center gap-2">
              <Icon name="check" className="h-4 w-4 text-brand-600" /> {f.name} <span className="text-gray-500">({(f.size / MB).toFixed(1)} MB)</span>
            </li>
          ))}
          {files.length > 5 && <li className="text-gray-500">…and {files.length - 5} more</li>}
          <li>
            <button type="button" className="text-xs font-semibold text-danger-600 hover:underline" onClick={() => onFiles([])} disabled={disabled}>
              Remove
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function ImportUpload() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'PRODUCTS' | 'IMAGES'>('PRODUCTS');
  const [mode, setMode] = useState<ProductImportMode>('CREATE');
  const [sheet, setSheet] = useState<File[]>([]);
  const [archive, setArchive] = useState<File[]>([]);
  const [images, setImages] = useState<File[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(0);

  const upload = useMutation({
    mutationFn: () => {
      setSent(0);
      return kind === 'PRODUCTS'
        ? uploadProductFile({ file: sheet[0]!, archive: archive[0] ?? null, mode }, setSent)
        : uploadImagesOnly({ archive: archive[0] ?? null, images }, setSent);
    },
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: importKeys.all });
      navigate(`/seller/products/import/${job.id}`);
    },
    onError: (error) => setProblem(sellerErrorMessage(error)),
  });

  const start = () => {
    setProblem(null);
    if (kind === 'PRODUCTS') {
      if (!sheet[0]) return setProblem('Choose your product file (.csv or .xlsx).');
      if (sheet[0].size > PRODUCT_IMPORT_LIMITS.maxSheetBytes) return setProblem('The product file must be 10 MB or smaller. Split it into several files.');
    } else if (!archive[0] && images.length === 0) {
      return setProblem('Choose a ZIP of images, or the image files.');
    }
    if (images.some((f) => f.size > PRODUCT_IMPORT_LIMITS.maxImageBytes)) return setProblem('Each image must be 5 MB or smaller.');
    upload.mutate();
  };

  const busy = upload.isPending;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/seller/products" className={linkClass}>
          ← Products
        </Link>
        <Link to="/seller/products/imports" className={linkClass}>
          Import History
        </Link>
      </div>

      <Surface className="space-y-4 p-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Bulk Product Import</h1>
          <p className="text-sm text-gray-600">
            Add or update many products at once. Nothing is saved until you have checked the preview and pressed Import. New products go to
            Aadione for approval, exactly like products added one by one.
          </p>
        </div>
        <ChipTabs
          label="What are you uploading?"
          value={kind}
          onChange={(next) => setKind(next)}
          options={[
            { value: 'PRODUCTS', label: 'Product list (+ photos)' },
            { value: 'IMAGES', label: 'Photos only' },
          ]}
        />

        {kind === 'PRODUCTS' ? (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
              <li>
                Download the template, fill one row per product (prices in rupees), and save it as <b>CSV UTF-8</b> or <b>.xlsx</b>.
              </li>
              <li>Optional: put the product photos in one ZIP and write each photo's file name in the image columns.</li>
              <li>Upload both files below, check the preview, then press Import.</li>
            </ol>
            <Button variant="soft" onClick={() => void downloadTemplate().catch((e) => toast(sellerErrorMessage(e), false))}>
              <Icon name="clipboard" className="h-4 w-4" /> Download CSV template
            </Button>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-gray-900">Import mode</legend>
              {(
                [
                  ['CREATE', 'Add new products', 'Rows whose SKU you already have are not touched (shown as “needs decision”).'],
                  ['UPDATE', 'Update my existing products', 'Matched by SKU (or barcode). Only filled-in cells change; empty cells keep the current value.'],
                ] as const
              ).map(([value, title, text]) => (
                <label key={value} className="flex cursor-pointer items-start gap-2 rounded-xl border border-gray-200 p-3 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                  <input type="radio" name="mode" className="mt-1" checked={mode === value} onChange={() => setMode(value)} disabled={busy} />
                  <span>
                    <span className="font-semibold text-gray-900">{title}</span>
                    <span className="block text-gray-600">{text}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="grid gap-3 md:grid-cols-2">
              <DropZone label="Product file" hint=".csv or .xlsx, up to 10 MB and 5000 rows" accept=".csv,.xlsx" files={sheet} onFiles={(f) => setSheet(f.slice(0, 1))} disabled={busy} />
              <DropZone label="Photos ZIP (optional)" hint="One .zip with the files named in the image columns" accept=".zip" files={archive} onFiles={(f) => setArchive(f.slice(0, 1))} disabled={busy} />
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-700">
              Name each photo after the product's <b>SKU</b> or <b>barcode</b> — e.g. <code>RB-250.jpg</code>, <code>OIL-1L-front.webp</code>,{' '}
              <code>OIL-1L-back.webp</code>. Photos are added to the matching product; ones that match nothing (or more than one product) are listed
              for you to assign. Nothing is saved until you press Import.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <DropZone
                label="Photos ZIP"
                hint="Up to the ZIP size limit; each photo ≤ 5 MB"
                accept=".zip"
                files={archive}
                onFiles={(f) => {
                  setArchive(f.slice(0, 1));
                  if (f.length) setImages([]);
                }}
                disabled={busy}
              />
              <DropZone
                label="…or photo files"
                hint={`Up to ${PRODUCT_IMPORT_LIMITS.maxLooseImages} JPG, PNG, WebP or AVIF files`}
                accept=".jpg,.jpeg,.png,.webp,.avif"
                multiple
                files={images}
                onFiles={(f) => {
                  setImages(f.slice(0, PRODUCT_IMPORT_LIMITS.maxLooseImages));
                  if (f.length) setArchive([]);
                }}
                disabled={busy}
              />
            </div>
          </>
        )}

        <ErrorBanner message={problem} />
        {busy && <Progress value={Math.round(sent * 100)} max={100} label={sent >= 1 ? 'Uploaded — starting the check…' : 'Uploading…'} />}
        <div className="flex justify-end">
          <Button onClick={start} disabled={busy}>
            {busy ? 'Uploading…' : 'Upload and check'}
          </Button>
        </div>
      </Surface>

      {kind === 'PRODUCTS' && <ColumnGuide />}
    </div>
  );
}

function ColumnGuide() {
  return (
    <Surface className="p-4">
      <h2 className="text-base font-semibold text-gray-900">Columns</h2>
      <p className="mb-3 text-sm text-gray-600">
        Required for new products are marked. Column names are matched loosely (“SKU”, “seller sku” and “seller_sku” all work); unknown columns are
        ignored.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="text-xs uppercase text-gray-500">
            <tr>
              <th className="py-1.5 pr-3">Column</th>
              <th className="py-1.5 pr-3">Required</th>
              <th className="py-1.5">What to write</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {PRODUCT_IMPORT_COLUMNS.map((c) => (
              <tr key={c.key}>
                <td className="py-1.5 pr-3 font-mono text-xs text-gray-900">{c.key}</td>
                <td className="py-1.5 pr-3">{c.requiredForCreate ? <Pill tone="amber">Required</Pill> : <span className="text-gray-500">Optional</span>}</td>
                <td className="py-1.5 text-gray-700">{c.help}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}

/* -------------------------------------------------------------------------- */
/* One import                                                                 */
/* -------------------------------------------------------------------------- */

function Tile({ label, value, tone = 'text-gray-900' }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm text-gray-700">
        <span>{label}</span>
        <span>{max > 0 ? `${pct}%` : ''}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ImportDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const job = useImport(id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...importKeys.all] });

  if (job.isPending) return <SkeletonBlock lines={6} label="Loading import…" />;
  if (job.isError) return <LoadError message={sellerErrorMessage(job.error)} onRetry={() => void job.refetch()} />;
  const data = job.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/seller/products/imports" className={linkClass}>
          ← Import History
        </Link>
        <Link to="/seller/products/import" className={linkClass}>
          New import
        </Link>
      </div>
      <Surface className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{data.kind === 'IMAGES' ? 'Photos import' : data.mode === 'CREATE' ? 'New products import' : 'Product update import'}</h1>
            <p className="text-sm text-gray-600">
              {[data.fileName, data.archiveName].filter(Boolean).join(' + ')} · {new Date(data.createdAt).toLocaleString('en-IN')}
            </p>
          </div>
          <Pill tone={STATUS_TONE[data.status]}>{STATUS_LABEL[data.status]}</Pill>
        </div>
        <StatusPanel job={data} onChanged={refresh} />
      </Surface>
      {(data.status === 'READY' || data.status === 'COMPLETED' || WORKING.includes(data.status)) && data.totalRows > 0 && <RowsPanel job={data} onChanged={refresh} />}
      {data.status === 'READY' && data.kind === 'PRODUCTS' && data.archiveName && <UnusedImages id={data.id} />}
    </div>
  );
}

function StatusPanel({ job, onChanged }: { job: ProductImportDto; onChanged: () => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setProblem(null);
      setConfirming(false);
      await onChanged();
    },
    onError: (error) => {
      setProblem(sellerErrorMessage(error));
      setConfirming(false);
      // e.g. "your catalogue changed since this preview": show the re-checked preview.
      void onChanged();
    },
  });
  const submit = useMutation({
    mutationFn: () => submitImportForApproval(job.id),
    onSuccess: () => {
      toast('Submitted to Aadione for approval.');
      void queryClient.invalidateQueries({ queryKey: sellerKeys.products });
    },
    onError: (error) => toast(sellerErrorMessage(error), false),
  });
  const report = () => void downloadErrorReport(job.id).catch((e) => toast(sellerErrorMessage(e), false));
  const issues = job.invalidRows + job.duplicateRows + job.conflictRows;
  const noun = job.kind === 'IMAGES' ? 'photo' : 'product';

  if (job.status === 'ANALYZING') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-gray-700">Checking your file{job.archiveName ? ' and photos' : ''}. You can leave this page; the check continues.</p>
        <Progress value={job.analyzedImages} max={0} label={job.analyzedImages ? `${job.analyzedImages} photo${job.analyzedImages === 1 ? '' : 's'} checked` : 'Reading the file…'} />
      </div>
    );
  }
  if (job.status === 'FAILED') {
    return (
      <div className="space-y-3">
        <ErrorBanner message={job.errorSummary ?? 'The file could not be used.'} />
        {job.totalRows > 0 && (
          <p className="text-sm text-gray-700">
            {job.createdCount + job.updatedCount} {noun}
            {job.createdCount + job.updatedCount === 1 ? '' : 's'} were imported before it stopped; {job.failedCount} were not.
          </p>
        )}
        <ErrorBanner message={problem} />
        <div className="flex flex-wrap gap-2">
          {/* Stopped while importing (rows kept): it can continue once the cause is fixed. */}
          {(job.retryableRows ?? 0) > 0 && (
            <Button onClick={() => act.mutate(() => retryImport(job.id))} disabled={act.isPending}>
              Retry the rows not imported
            </Button>
          )}
          <Button variant="secondary" onClick={() => navigate('/seller/products/import')}>
            Upload a corrected file
          </Button>
        </div>
      </div>
    );
  }
  if (job.status === 'CANCELLED' || job.status === 'EXPIRED') {
    return <p className="text-sm text-gray-700">{job.status === 'CANCELLED' ? 'You cancelled this import. Nothing was saved.' : 'This preview expired before it was imported. Nothing was saved.'}</p>;
  }
  if (job.status === 'QUEUED' || job.status === 'PROCESSING') {
    return (
      <div className="space-y-3">
        <Progress value={job.processedRows} max={job.readyRows} label={`${job.processedRows} of ${job.readyRows} ${noun}s processed`} />
        <p className="text-sm text-gray-600">Importing in the background — you can leave this page and come back from Import History.</p>
      </div>
    );
  }
  if (job.status === 'COMPLETED') {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label={job.kind === 'IMAGES' ? 'Photos added' : 'Created'} value={job.kind === 'IMAGES' ? job.updatedCount : job.createdCount} tone="text-brand-700" />
          {job.kind === 'PRODUCTS' && <Tile label="Updated" value={job.updatedCount} tone="text-brand-700" />}
          <Tile label="Failed / errors" value={job.failedCount} tone={job.failedCount ? 'text-danger-600' : undefined} />
          <Tile label="Skipped" value={job.skippedCount} />
        </div>
        {job.kind === 'PRODUCTS' && job.createdCount > 0 && (
          <p className="text-sm text-gray-700">New products are saved as <b>pending approval</b> — customers see them once Aadione approves them.</p>
        )}
        <ErrorBanner message={problem} />
        <div className="flex flex-wrap gap-2">
          {job.kind === 'PRODUCTS' && job.mode === 'CREATE' && job.createdCount > 0 && (
            <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
              {submit.isPending ? 'Submitting…' : 'Submit new products for approval'}
            </Button>
          )}
          {(job.retryableRows ?? 0) > 0 && (
            <Button variant="secondary" onClick={() => act.mutate(() => retryImport(job.id))} disabled={act.isPending}>
              Retry failed rows
            </Button>
          )}
          {job.failedCount + job.skippedCount > 0 && (
            <Button variant="secondary" onClick={report}>
              Download error report
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate('/seller/products')}>
            Go to Products
          </Button>
        </div>
      </div>
    );
  }

  // READY — the preview.
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Rows" value={job.totalRows} />
        <Tile label="Ready" value={job.readyRows} tone="text-brand-700" />
        <Tile label="Errors" value={job.invalidRows} tone={job.invalidRows ? 'text-danger-600' : undefined} />
        <Tile label="Duplicates" value={job.duplicateRows} tone={job.duplicateRows ? 'text-amber-600' : undefined} />
        <Tile label="Need decision" value={job.conflictRows} tone={job.conflictRows ? 'text-amber-600' : undefined} />
        <Tile label="With warnings" value={job.warningRows} />
      </div>
      {job.ignoredColumns.length > 0 && <p className="text-sm text-gray-600">Ignored columns (not recognised): {job.ignoredColumns.join(', ')}</p>}
      {job.kind === 'PRODUCTS' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-gray-900">Mode:</span>
          <ChipTabs
            label="Import mode"
            value={job.mode}
            onChange={(next) => act.mutate(() => changeImportMode(job.id, next))}
            options={[
              { value: 'CREATE', label: 'Add new products' },
              { value: 'UPDATE', label: 'Update existing' },
            ]}
          />
          {act.isPending && <span className="text-gray-500">Re-checking…</span>}
        </div>
      )}
      <ErrorBanner message={problem} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setConfirming(true)} disabled={job.readyRows === 0 || act.isPending}>
          Import {job.readyRows} {noun}
          {job.readyRows === 1 ? '' : 's'}
        </Button>
        {issues > 0 && (
          <Button variant="secondary" onClick={report}>
            Download error report
          </Button>
        )}
        <Button variant="ghost" onClick={() => act.mutate(() => cancelImport(job.id))} disabled={act.isPending}>
          Cancel import
        </Button>
      </div>
      {confirming && (
        <Modal
          title="Start the import?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={act.isPending}>
                Back
              </Button>
              <Button onClick={() => act.mutate(() => confirmImport(job.id, job.mode))} disabled={act.isPending}>
                {act.isPending ? 'Starting…' : 'Yes, import'}
              </Button>
            </>
          }
        >
          <div className="space-y-2 text-sm text-gray-700">
            <p>
              {job.kind === 'IMAGES'
                ? `${job.readyRows} photo${job.readyRows === 1 ? '' : 's'} will be added to the matching products.`
                : job.mode === 'CREATE'
                  ? `${job.readyRows} new product${job.readyRows === 1 ? '' : 's'} will be created as pending approval.`
                  : `${job.readyRows} product${job.readyRows === 1 ? '' : 's'} will be updated. Only filled-in cells change.`}
            </p>
            {issues > 0 && <p>{issues} row{issues === 1 ? '' : 's'} with problems will be skipped — download the error report to fix them.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function RowsPanel({ job, onChanged }: { job: ProductImportDto; onChanged: () => Promise<unknown> }) {
  const finished = job.status === 'COMPLETED';
  const [filter, setFilter] = useState<RowFilter>(finished ? 'ALL' : job.invalidRows + job.duplicateRows + job.conflictRows > 0 ? 'ISSUES' : 'ALL');
  const [page, setPage] = useState(1);
  const rows = useImportRows(
    job.id,
    filter,
    page,
    !WORKING.includes(job.status) || job.status === 'PROCESSING',
    WORKING.includes(job.status),
    `${job.status}:${job.processedRows}:${job.updatedAt}`,
  );
  const editable = job.status === 'READY';
  const filters: { value: RowFilter; label: string }[] = finished
    ? [
        { value: 'ALL', label: 'All' },
        { value: 'DONE', label: 'Done' },
        { value: 'FAILED', label: 'Failed' },
        { value: 'ISSUES', label: 'Problems' },
      ]
    : [
        { value: 'ALL', label: 'All' },
        { value: 'READY', label: 'Ready' },
        { value: 'ISSUES', label: 'Problems' },
        { value: 'WARNINGS', label: 'Warnings' },
        { value: 'EXCLUDED', label: 'Left out' },
      ];
  const total = rows.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <Surface className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">{finished ? 'Results' : 'Preview'}</h2>
        <ChipTabs
          label="Show rows"
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setPage(1);
          }}
          options={filters}
        />
      </div>
      {rows.isPending ? (
        <SkeletonBlock lines={5} label="Loading rows…" />
      ) : rows.isError ? (
        <LoadError message={sellerErrorMessage(rows.error)} onRetry={() => void rows.refetch()} />
      ) : total === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500">No rows here.</p>
      ) : (
        <ul className="divide-y divide-gray-100" aria-label="Import rows">
          {rows.data.items.map((row) => (
            <RowItem key={row.id} job={job} row={row} editable={editable} onChanged={onChanged} />
          ))}
        </ul>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-gray-600">
            Page {page} of {pages} · {total} rows
          </span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </Surface>
  );
}

function RowItem({ job, row, editable, onChanged }: { job: ProductImportDto; row: ProductImportRowDto; editable: boolean; onChanged: () => Promise<unknown> }) {
  const [sku, setSku] = useState('');
  const decide = useMutation({
    mutationFn: (body: Parameters<typeof decideImportRow>[2]) => decideImportRow(job.id, row.id, body),
    onSuccess: () => onChanged(),
    onError: (error) => toast(sellerErrorMessage(error), false),
  });
  const values = row.values;
  const detail: ReactNode[] = [];
  if (job.kind === 'PRODUCTS') {
    const price = values['selling_price'] || values['price'];
    if (price) detail.push(`₹${price}${values['mrp'] ? ` (MRP ₹${values['mrp']})` : ''}`);
    if (values['stock_quantity']) detail.push(`stock ${values['stock_quantity']}`);
    if (values['category']) detail.push([values['category'], values['subcategory']].filter(Boolean).join(' › '));
  }

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
      <div className="flex shrink-0 items-center gap-2 sm:w-40">
        <span className="w-12 text-xs text-gray-500">Row {row.rowNumber}</span>
        <Pill tone={ROW_TONE[row.status]}>{ROW_LABEL[row.status]}</Pill>
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-gray-900">
          {row.name ?? (job.kind === 'IMAGES' ? row.images[0]?.fileName : '—')}
          {row.sku && <span className="ml-2 font-mono text-xs font-normal text-gray-500">{row.sku}</span>}
        </p>
        {detail.length > 0 && <p className="text-gray-600">{detail.join(' · ')}</p>}
        {row.errors.map((e, i) => (
          <p key={`e${i}`} className="text-danger-600">
            Row {row.rowNumber}: {e.message}
          </p>
        ))}
        {row.warnings.map((w, i) => (
          <p key={`w${i}`} className="text-amber-700">
            {w.message}
          </p>
        ))}
        {row.images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {row.images.map((image, i) => (
              <figure key={image.fileName} className="w-20 text-center">
                {image.thumbUrl ? (
                  <img src={imageSrc(image.thumbUrl)} alt={image.fileName} className={`h-20 w-20 rounded-lg border object-cover ${i === 0 ? 'border-brand-500' : 'border-gray-200'}`} />
                ) : (
                  <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-danger-500 text-[10px] text-danger-600">
                    {image.status === 'MISSING' ? 'Not in ZIP' : 'Unusable'}
                  </span>
                )}
                <figcaption className="truncate text-[10px] text-gray-600" title={image.fileName}>
                  {i === 0 && job.kind === 'PRODUCTS' ? 'Main · ' : ''}
                  {image.fileName}
                </figcaption>
                {editable && job.kind === 'PRODUCTS' && i > 0 && image.thumbUrl && (
                  <button type="button" className="text-[10px] font-semibold text-brand-700 hover:underline" disabled={decide.isPending} onClick={() => decide.mutate({ primaryImage: image.fileName })}>
                    Make main
                  </button>
                )}
              </figure>
            ))}
          </div>
        )}
        {editable && job.kind === 'IMAGES' && row.status !== 'EXCLUDED' && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* Only a photo that matched no product (or several) needs a SKU — not one whose product is, say, under review. */}
            {row.status !== 'READY' && (row.status === 'CONFLICT' || !row.sku) && (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (sku.trim()) decide.mutate({ sku: sku.trim() });
                }}
              >
                <label className="sr-only" htmlFor={`sku-${row.id}`}>
                  SKU for {row.images[0]?.fileName}
                </label>
                <input id={`sku-${row.id}`} className={`${inputClass} h-9 w-40`} placeholder="Product SKU" value={sku} onChange={(event) => setSku(event.target.value)} />
                <Button type="submit" variant="secondary" disabled={decide.isPending || !sku.trim()} className="min-h-9">
                  Assign
                </Button>
              </form>
            )}
            {row.status === 'READY' && (
              <label className="flex items-center gap-1.5 text-xs text-gray-700">
                <input type="checkbox" checked={row.makePrimary} disabled={decide.isPending} onChange={(event) => decide.mutate({ makePrimary: event.target.checked })} />
                Make it the main photo
              </label>
            )}
          </div>
        )}
      </div>
      {editable && (
        <div className="shrink-0">
          <Button variant="ghost" className="min-h-9" disabled={decide.isPending} onClick={() => decide.mutate({ excluded: row.status === 'EXCLUDED' ? null : true })}>
            {row.status === 'EXCLUDED' ? 'Include' : 'Leave out'}
          </Button>
        </div>
      )}
    </li>
  );
}

function UnusedImages({ id }: { id: string }) {
  const unused = useImportImages(id, 'UNUSED', true);
  if (!unused.data || unused.data.length === 0) return null;
  return (
    <Surface className="p-4">
      <h2 className="text-base font-semibold text-gray-900">Photos no row uses ({unused.data.length})</h2>
      <p className="mb-2 text-sm text-gray-600">These files are in the ZIP but no row names them, so they will not be added. Check the image file names in your sheet.</p>
      <p className="text-sm text-gray-800">{unused.data.map((i) => i.fileName).join(', ')}</p>
    </Surface>
  );
}
