/**
 * Read-only report: every ACTIVE, non-deleted PRODUCT that has no image.
 *
 * The catalog (and therefore product cards, search, and order thumbnails)
 * reads `product.images[0]` as the picture for every variant of that
 * product — see catalog.service.ts's `toSummaryDto`. A variant almost never
 * has its own override image, so "missing image" is a product-level
 * question, not a per-variant one.
 *
 * Run with:  npx tsx scripts/report-missing-images.ts
 */
import { PrismaClient, ProductStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    where: {
      status: ProductStatus.ACTIVE,
      images: { none: {} },
    },
    select: { name: true, variants: { select: { sku: true }, take: 1 } },
    orderBy: { name: "asc" },
  });

  if (products.length === 0) {
    console.log("Every active product has at least one image. Nothing to fix.");
    return;
  }

  console.log(`${products.length} active product(s) with NO image:\n`);

  for (const p of products) {
    console.log(`- ${p.name}  (e.g. SKU: ${p.variants[0]?.sku ?? "n/a"})`);
  }
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
