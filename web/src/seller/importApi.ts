/**
 * Seller panel — bulk product import (backend modules/product-import).
 *
 * Uploads are multipart; everything after that is polling one import while
 * the server works on it in the background (checking the file, then
 * importing). Status, counts and row results always come from the server.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ProductImportDto,
  ProductImportImageDto,
  ProductImportMode,
  ProductImportPageDto,
  ProductImportRowDto,
  ProductImportRowPageDto,
  ProductImportStatus,
} from '@shared';
import { SELLER_QUERY_ROOT, sellerApi } from './sellerApi';

export const importKeys = {
  all: [SELLER_QUERY_ROOT, 'imports'] as const,
  history: (page: number) => [SELLER_QUERY_ROOT, 'imports', 'history', page] as const,
  detail: (id: string) => [SELLER_QUERY_ROOT, 'imports', 'detail', id] as const,
  rows: (id: string, filter: string, page: number) => [SELLER_QUERY_ROOT, 'imports', 'rows', id, filter, page] as const,
  images: (id: string, status: string) => [SELLER_QUERY_ROOT, 'imports', 'images', id, status] as const,
};

/** The server is still working on these. */
export const WORKING: readonly ProductImportStatus[] = ['ANALYZING', 'QUEUED', 'PROCESSING'];

export function useImport(id: string) {
  return useQuery({
    queryKey: importKeys.detail(id),
    queryFn: () => sellerApi.get<ProductImportDto>(`/seller/imports/${id}`),
    refetchInterval: (query) => (query.state.data && WORKING.includes(query.state.data.status) ? 2000 : false),
  });
}

export type RowFilter = 'ALL' | 'READY' | 'ISSUES' | 'WARNINGS' | 'EXCLUDED' | 'DONE' | 'FAILED';

export function useImportRows(id: string, filter: RowFilter, page: number, enabled: boolean) {
  return useQuery({
    queryKey: importKeys.rows(id, filter, page),
    queryFn: () => sellerApi.get<ProductImportRowPageDto>(`/seller/imports/${id}/rows?filter=${filter}&page=${page}&pageSize=25`),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useImportImages(id: string, status: 'UNUSED' | 'INVALID' | 'DUPLICATE_NAME', enabled: boolean) {
  return useQuery({
    queryKey: importKeys.images(id, status),
    queryFn: () => sellerApi.get<ProductImportImageDto[]>(`/seller/imports/${id}/images?status=${status}`),
    enabled,
  });
}

export function useImportHistory(page: number) {
  return useQuery({
    queryKey: importKeys.history(page),
    queryFn: () => sellerApi.get<ProductImportPageDto>(`/seller/imports?page=${page}&pageSize=20`),
    placeholderData: keepPreviousData,
  });
}

export function uploadProductFile(input: { file: File; archive: File | null; mode: ProductImportMode }): Promise<ProductImportDto> {
  const form = new FormData();
  form.append('mode', input.mode);
  form.append('file', input.file);
  if (input.archive) form.append('archive', input.archive);
  return sellerApi.postForm<ProductImportDto>('/seller/imports', form);
}

export function uploadImagesOnly(input: { archive: File | null; images: File[] }): Promise<ProductImportDto> {
  const form = new FormData();
  if (input.archive) form.append('archive', input.archive);
  for (const image of input.images) form.append('images', image);
  return sellerApi.postForm<ProductImportDto>('/seller/imports/images', form);
}

export const changeImportMode = (id: string, mode: ProductImportMode) => sellerApi.post<ProductImportDto>(`/seller/imports/${id}/mode`, { mode });
export const confirmImport = (id: string, mode: ProductImportMode) => sellerApi.post<ProductImportDto>(`/seller/imports/${id}/confirm`, { mode });
export const cancelImport = (id: string) => sellerApi.post<ProductImportDto>(`/seller/imports/${id}/cancel`);
export const retryImport = (id: string) => sellerApi.post<ProductImportDto>(`/seller/imports/${id}/retry`);
export const submitImportForApproval = (id: string) => sellerApi.post<{ id: string }>(`/seller/imports/${id}/submit-for-approval`);
export const decideImportRow = (id: string, rowId: string, body: { excluded?: boolean | null; primaryImage?: string | null; sku?: string | null; makePrimary?: boolean | null }) =>
  sellerApi.patch<ProductImportRowDto>(`/seller/imports/${id}/rows/${rowId}`, body);

/** Saves a server file (template, error report) under `fileName`. */
async function download(path: string, fileName: string): Promise<void> {
  const blob = await sellerApi.getBlob(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadTemplate = () => download('/seller/imports/template.csv', 'aadione-product-import-template.csv');
export const downloadErrorReport = (id: string) => download(`/seller/imports/${id}/error-report.csv`, `import-errors-${id.slice(0, 8)}.csv`);

export const STATUS_LABEL: Record<ProductImportStatus, string> = {
  ANALYZING: 'Checking file',
  READY: 'Waiting for your review',
  QUEUED: 'Starting',
  PROCESSING: 'Importing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

export const STATUS_TONE: Record<ProductImportStatus, 'brand' | 'blue' | 'amber' | 'red' | 'gray'> = {
  ANALYZING: 'blue',
  READY: 'amber',
  QUEUED: 'blue',
  PROCESSING: 'blue',
  COMPLETED: 'brand',
  FAILED: 'red',
  CANCELLED: 'gray',
  EXPIRED: 'gray',
};

export const ROW_LABEL: Record<ProductImportRowDto['status'], string> = {
  READY: 'Ready',
  INVALID: 'Error',
  DUPLICATE: 'Duplicate',
  CONFLICT: 'Needs decision',
  EXCLUDED: 'Left out',
  DONE: 'Done',
  FAILED: 'Failed',
};

export const ROW_TONE: Record<ProductImportRowDto['status'], 'brand' | 'blue' | 'amber' | 'red' | 'gray'> = {
  READY: 'brand',
  INVALID: 'red',
  DUPLICATE: 'amber',
  CONFLICT: 'amber',
  EXCLUDED: 'gray',
  DONE: 'brand',
  FAILED: 'red',
};
