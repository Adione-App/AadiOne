import { z } from 'zod';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '../../shared';

const uuid = z.string().uuid('Invalid id');

const limitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(PAGINATION_MAX_LIMIT)
  .default(PAGINATION_DEFAULT_LIMIT);

/** Query strings arrive as text; `"true"` must become `true`. */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1')
  .optional();

export const listCategoriesQuerySchema = z.object({
  parentId: uuid.optional(),
  includeChildren: booleanish,
  withCounts: booleanish,
});

export const categoryParamsSchema = z.object({ id: uuid });

export const listProductsQuerySchema = z.object({
  categoryId: uuid.optional(),
  subcategoryId: uuid.optional(),
  brandId: uuid.optional(),
  inStock: booleanish,
  sort: z
    .enum(['RELEVANCE', 'PRICE_ASC', 'PRICE_DESC', 'NEWEST', 'POPULAR', 'DISCOUNT'])
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: limitSchema,
});

export const productParamsSchema = z.object({ id: uuid });

export const railParamsSchema = z.object({
  key: z.enum(['POPULAR', 'DAILY_ESSENTIALS', 'BEST_SELLERS', 'RECENTLY_ADDED', 'OFFERS']),
});

export const railQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(PAGINATION_MAX_LIMIT).default(60),
});

export const variantParamsSchema = z.object({ variantId: uuid });

export const searchQuerySchema = z.object({
  // Bounded because the term reaches a tsquery and a trigram scan; an
  // unbounded string is an easy way to make the database work hard for free.
  q: z.string().trim().min(1, 'Enter something to search for').max(80),
  inStock: booleanish,
  cursor: z.string().max(200).optional(),
  limit: limitSchema,
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
export type RailParams = z.infer<typeof railParamsSchema>;
export type RailQuery = z.infer<typeof railQuerySchema>;
