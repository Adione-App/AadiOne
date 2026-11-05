/**
 * LOCAL QA seed for the customer-app variant check — throwaway, run once
 * against the local *_test database only, then deleted:
 *
 *   npx tsx tests/qa-variants-seed.local.ts
 *
 * Not a test (no .test.ts suffix). The env guard runs first, so nothing can
 * load backend/.env (production) before it.
 */

import { approvedSettings, assertSafeTestEnv, loadTestEnv, removeUnapprovedSettings } from './test-env';

loadTestEnv();
assertSafeTestEnv();
const approved = approvedSettings();

interface Size {
  name: string;
  pricePaise: number;
  stockQty?: number;
  isDefault?: boolean;
  status?: 'ACTIVE' | 'INACTIVE' | 'DRAFT';
  approvalStatus?: 'APPROVED' | 'PENDING' | 'REJECTED';
}

async function main() {
  await import('../src/config/env');
  const { prisma } = await import('../src/infra/db/prisma');
  const { truncateAll } = await import('./helpers/db');
  const { STORE_COORDS, sellerLifecycleFields } = await import('./helpers/fixtures');
  const { randomUUID } = await import('node:crypto');
  removeUnapprovedSettings(approved);
  assertSafeTestEnv();
  if (!/localhost:55432\/adione_test/.test(process.env['DATABASE_URL'] ?? '')) throw new Error('refusing: not the local test database');

  await truncateAll();

  const seller = await prisma.seller.create({
    data: {
      code: `QA-${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Aadione QA Store',
      sellerType: 'GROCERY',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: 'Asia/Kolkata',
      isActive: true,
      allowCod: 'ALLOW',
      ...sellerLifecycleFields('APPROVED'),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '00:00', isClosed: false })),
  });
  const category = await prisma.category.create({
    data: { sellerId: seller.id, name: 'Fruits', slug: 'fruits', path: 'fruits', depth: 0 },
  });

  const products: Record<string, { productId: string; variants: Record<string, { id: string; listingId: string; sku: string }> }> = {};
  async function product(name: string, sizes: Size[], description?: string) {
    const created = await prisma.product.create({
      data: {
        name,
        description: description ?? null,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 4)}`,
        categoryId: category.id,
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        searchKeywords: [],
        optionGroups: [{ name: 'Weight', values: sizes.map((size) => size.name) }],
      },
    });
    const variants: Record<string, { id: string; listingId: string; sku: string }> = {};
    for (const [index, size] of sizes.entries()) {
      const sku = `AAD-QA-${name.slice(0, 3).toUpperCase()}-${size.name.replace(/\s+/g, '').toUpperCase()}`;
      const variant = await prisma.productVariant.create({
        data: {
          productId: created.id,
          sku,
          variantName: size.name,
          optionValues: { Weight: size.name },
          unit: 'G',
          unitValue: 1,
          isDefault: size.isDefault ?? index === 0,
          displayOrder: index,
          status: size.status ?? 'ACTIVE',
          approvalStatus: size.approvalStatus ?? 'APPROVED',
        },
      });
      const listing = await prisma.sellerListing.create({
        data: {
          sellerId: seller.id,
          variantId: variant.id,
          pricePaise: size.pricePaise,
          mrpPaise: Math.round(size.pricePaise * 1.15),
          stockQty: size.stockQty ?? 20,
          isAvailable: true,
        },
      });
      variants[size.name] = { id: variant.id, listingId: listing.id, sku };
    }
    products[name] = { productId: created.id, variants };
  }

  // The brief's own Orange: 500g available, 1kg sold out.
  await product('Orange', [
    { name: '500g', pricePaise: 3400, stockQty: 5, isDefault: true },
    { name: '1kg', pricePaise: 6500, stockQty: 0 },
  ], 'Fresh Nagpur oranges.');
  await product('Apple', [
    { name: '500g', pricePaise: 6000, isDefault: true },
    { name: '1kg', pricePaise: 11000, status: 'INACTIVE' },
  ]);
  await product('Grapes', [
    { name: '500g', pricePaise: 5000, isDefault: true, stockQty: 4 },
    { name: '1kg', pricePaise: 9500 },
  ]);
  await product('Guava', [
    { name: '500g', pricePaise: 3000, stockQty: 0, isDefault: true },
    { name: '1kg', pricePaise: 5500, stockQty: 3 },
  ]);
  await product('Mango', [
    { name: '500g', pricePaise: 6000, isDefault: true, status: 'INACTIVE' },
    { name: '1kg', pricePaise: 12000, stockQty: 0 },
  ]);
  await product('Kiwi', [
    { name: '3 pcs', pricePaise: 9900, isDefault: true },
    { name: '6 pcs', pricePaise: 18000, status: 'DRAFT', approvalStatus: 'PENDING' },
    { name: '12 pcs', pricePaise: 34000, status: 'DRAFT', approvalStatus: 'REJECTED' },
  ]);
  await product('Papaya', [{ name: '1 kg', pricePaise: 4500, stockQty: 5 }]);

  console.log(JSON.stringify({ sellerId: seller.id, sellerName: seller.name, categoryId: category.id, products }));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
