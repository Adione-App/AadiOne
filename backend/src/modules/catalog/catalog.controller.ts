import type { Request, Response } from 'express';
import { noContent, ok, okCursorPage } from '../../common/response';
import { validatedQuery } from '../../middleware/validate';
import { requireUser } from '../../middleware/auth';
import * as catalogService from './catalog.service';
import * as storeDirectory from './store-directory.service';
import type {
  ListCategoriesQuery,
  ListProductsQuery,
  ListStoresQuery,
  RailParams,
  RailQuery,
  SearchQuery,
} from './catalog.validation';

/** GET /categories */
export async function listCategories(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListCategoriesQuery>(req);
  ok(
    res,
    await catalogService.listCategories({
      parentId: query.parentId ?? null,
      includeChildren: query.includeChildren ?? false,
      withCounts: query.withCounts ?? false,
    }),
  );
}

/** GET /categories/:id/subcategories */
export async function listSubcategories(req: Request, res: Response): Promise<void> {
  ok(res, await catalogService.listSubcategories(req.params['id'] as string));
}

/** GET /products */
export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListProductsQuery>(req);
  okCursorPage(
    res,
    await catalogService.listProducts({
      categoryId: query.categoryId,
      subcategoryId: query.subcategoryId,
      brandId: query.brandId,
      sellerId: query.sellerId,
      inStock: query.inStock,
      sort: query.sort,
      cursor: query.cursor ?? null,
      limit: query.limit,
    }),
  );
}

/** GET /products/search */
export async function searchProducts(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<SearchQuery>(req);
  okCursorPage(
    res,
    await catalogService.searchProducts({
      term: query.q,
      limit: query.limit,
      cursor: query.cursor ?? null,
      inStock: query.inStock ?? false,
    }),
  );
}

/** GET /products/rail/:key — the full contents behind a Home "See All". */
export async function listRailProducts(req: Request, res: Response): Promise<void> {
  const { key } = req.params as unknown as RailParams;
  const { limit } = validatedQuery<RailQuery>(req);
  ok(res, await catalogService.listRailProducts(key, limit));
}

/** GET /products/:id */
export async function getProduct(req: Request, res: Response): Promise<void> {
  ok(res, await catalogService.getProductDetail(req.params['id'] as string));
}

/** GET /products/:id/related */
export async function getRelated(req: Request, res: Response): Promise<void> {
  ok(res, await catalogService.getRelatedProducts(req.params['id'] as string));
}

/** GET /home */
export async function getHomeFeed(_req: Request, res: Response): Promise<void> {
  ok(res, await catalogService.getHomeFeed());
}

function locationOf(query: ListStoresQuery): storeDirectory.CustomerLocation | null {
  return query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : null;
}

/** GET /stores?lat=&lng= — live marketplace stores (that deliver here, nearest first). */
export async function listStores(req: Request, res: Response): Promise<void> {
  ok(res, await storeDirectory.listStores(locationOf(validatedQuery<ListStoresQuery>(req))));
}

/** GET /stores/:sellerId — a store page's header. */
export async function getStore(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await storeDirectory.getStore(req.params['sellerId'] as string, locationOf(validatedQuery<ListStoresQuery>(req))),
  );
}

/** POST /products/:variantId/notify-me */
export async function notifyMe(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  await catalogService.subscribeBackInStock(user.id, req.params['variantId'] as string);
  noContent(res);
}
