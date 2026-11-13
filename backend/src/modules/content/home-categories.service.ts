/**
 * Home page main categories (Admin Panel → Banners & Cards → Home page main
 * categories) — which top-level categories the customer Home page shows, in
 * what order, and which are featured. Stored as ONE configuration value
 * (HOME_MAIN_CATEGORIES, rules in shared/home-categories.ts); GET /home
 * applies it (catalog.service getHomeFeed). Nothing here touches a category,
 * product, seller or search: hiding is presentation only.
 *
 *   GET /admin/content/home-categories  every live main category (empty ones
 *       too) in Home order with its visibility — discovered from the
 *       catalogue on every read, so a category a seller creates tomorrow is
 *       listed without anyone registering it;
 *   PUT /admin/content/home-categories  saves the whole arrangement at once.
 *
 * A save is one transaction under an advisory lock: the screen's
 * `basedOnUpdatedAt` must still be the saved version (two admins never
 * silently overwrite each other — CONTENT_CHANGED), every path must be a live
 * main category or one already saved, the legacy HOME_CATEGORY_ORDER is
 * rewritten in step (its featured categories, in order — what an older
 * server would read), and the change is audited. Reading never writes:
 * discovering a new category never changes what an admin saved.
 */

import { Prisma } from '@prisma/client';
import {
  CONFIG_DESCRIPTIONS,
  ConfigKey,
  ErrorCode,
  arrangeMainCategories,
  homeMainCategoriesProblem,
  readHomeMainCategories,
  type AdminHomeMainCategoriesDto,
  type HomeMainCategoriesConfig,
  type SaveHomeMainCategoriesInput,
} from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import * as configRepository from '../configuration/configuration.repository';
import * as configService from '../configuration/configuration.service';
import { findMarketplaceCategories } from '../catalog/catalog.repository';
import { listCategoryOptions } from './home-layout.service';

const log = moduleLogger('home-categories');

const KEY = ConfigKey.HOME_MAIN_CATEGORIES;

interface LiveMainCategory {
  id: string;
  path: string;
  name: string;
  nameHi: string | null;
  imageUrl: string | null;
  sellerCount: number;
  productCount: number;
}

/**
 * Every live main category (live seller, active, not deleted), merged by
 * path, in the catalogue's own order — the same representative row, name and
 * order GET /home uses — with or without products. Two queries, whatever the
 * number of categories.
 */
async function liveMainCategories(): Promise<LiveMainCategory[]> {
  const [rows, options] = await Promise.all([findMarketplaceCategories(), listCategoryOptions()]);
  const counts = new Map(options.filter((option) => option.depth === 0).map((option) => [option.path, option]));
  const byPath = new Map<string, LiveMainCategory>();
  for (const row of rows) {
    if (row.depth !== 0) continue;
    const existing = byPath.get(row.path);
    if (existing) {
      existing.imageUrl ??= row.imageUrl;
      continue;
    }
    byPath.set(row.path, {
      id: row.id,
      path: row.path,
      name: row.name,
      nameHi: row.nameHi,
      imageUrl: row.imageUrl,
      sellerCount: counts.get(row.path)?.sellerCount ?? 0,
      productCount: counts.get(row.path)?.productCount ?? 0,
    });
  }
  return [...byPath.values()];
}

/** The saved row, read from the database (never the cache: the admin must see what is really saved). */
async function savedRow(client: Prisma.TransactionClient | typeof prisma = prisma) {
  const row = await client.configuration.findFirst({
    where: { key: KEY, sellerId: null },
    select: { value: true, updatedAt: true, updatedBy: { select: { fullName: true, email: true } } },
  });
  const config = row ? readHomeMainCategories(row.value) : null;
  return {
    config,
    // A row still holding the seeded `{}` counts as never saved.
    updatedAt: row && config ? row.updatedAt.toISOString() : null,
    updatedBy: row && config ? row.updatedBy?.fullName ?? row.updatedBy?.email ?? null : null,
  };
}

/** GET /admin/content/home-categories. */
export async function getAdminHomeMainCategories(): Promise<AdminHomeMainCategoriesDto> {
  const [live, saved, legacyOrder] = await Promise.all([
    liveMainCategories(),
    savedRow(),
    configService.get(ConfigKey.HOME_CATEGORY_ORDER),
  ]);
  const arranged = arrangeMainCategories(live, (category) => category.path, saved.config, legacyOrder ?? []);
  const livePaths = new Set(live.map((category) => category.path));
  const hidden = new Set(saved.config?.hidden ?? []);
  const featured = new Set(saved.config?.featured ?? []);
  return {
    categories: arranged.map(({ item, visible, featured: isFeatured, isNew }) => ({ ...item, visible, featured: isFeatured, isNew })),
    unavailable: (saved.config?.order ?? [])
      .filter((path) => !livePaths.has(path))
      .map((path) => ({ path, visible: !hidden.has(path), featured: featured.has(path) })),
    newCategoriesVisible: saved.config?.newCategoriesVisible ?? true,
    updatedAt: saved.updatedAt,
    updatedBy: saved.updatedBy,
  };
}

/** PUT /admin/content/home-categories — the whole arrangement, in one transaction. */
export async function saveHomeMainCategories(input: SaveHomeMainCategoriesInput, actorUserId: string): Promise<AdminHomeMainCategoriesDto> {
  const next: HomeMainCategoriesConfig = {
    order: input.order,
    hidden: input.hidden,
    featured: input.featured,
    newCategoriesVisible: input.newCategoriesVisible,
  };
  const problem = homeMainCategoriesProblem(next);
  if (problem) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `Home page main categories: ${problem}.` });

  const livePaths = new Set((await liveMainCategories()).map((category) => category.path));

  await prisma.$transaction(async (tx) => {
    // Two admins saving at once queue here; the second then sees the first's version.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`configurations:${KEY}`}))`;
    const current = await savedRow(tx);
    if (current.updatedAt !== input.basedOnUpdatedAt) {
      throw new AppError(ErrorCode.CONTENT_CHANGED, {
        message: 'Someone saved the Home page main categories meanwhile. Reload to see their changes, then make yours again.',
      });
    }

    // A path must be a live main category now, or one already saved (kept while its category is away).
    const known = new Set([...livePaths, ...(current.config?.order ?? [])]);
    const unknown = next.order.filter((path) => !known.has(path));
    if (unknown.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `These are not main categories in the catalogue: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}. Reload and try again.`,
        details: unknown.map((path) => ({ field: 'order', message: path })),
      });
    }

    const featured = new Set(next.featured);
    await configRepository.upsert(
      { key: KEY, sellerId: null, value: next as unknown as Prisma.InputJsonValue, description: CONFIG_DESCRIPTIONS[KEY], isPublic: false, updatedByUserId: actorUserId },
      tx,
    );
    await configRepository.upsert(
      {
        key: ConfigKey.HOME_CATEGORY_ORDER,
        sellerId: null,
        value: next.order.filter((path) => featured.has(path)),
        description: CONFIG_DESCRIPTIONS[ConfigKey.HOME_CATEGORY_ORDER],
        isPublic: false,
        updatedByUserId: actorUserId,
      },
      tx,
    );
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'home_main_categories.update',
        entityType: 'Configuration',
        entityId: KEY,
        before: (current.config ?? Prisma.JsonNull) as never,
        after: next as never,
      },
    });
  });

  await configService.invalidate(null);
  log.info({ actorUserId, shown: next.order.length - next.hidden.length, hidden: next.hidden.length, featured: next.featured.length }, 'home main categories saved');
  return getAdminHomeMainCategories();
}
