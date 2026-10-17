/**
 * Report (default) or clear (--apply) the fabricated stock on made-to-order
 * food listings. See src/modules/inventory/food-stock-backfill.ts.
 *
 *   npm run inventory:food-stock:v2                         # report only
 *   npm run inventory:food-stock:v2 -- --apply --actor "Owner name"
 *
 * Run --apply only AFTER the backend with inventory/stock-rules.ts is deployed.
 */

import { prisma } from '../src/infra/db/prisma';
import { applyFoodStockBackfill, planFoodStockBackfill } from '../src/modules/inventory/food-stock-backfill';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const report = await planFoodStockBackfill();
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'APPLY' : 'REPORT', ...report }, null, 2));
  if (!process.argv.includes('--apply')) {
    console.log(`\nNothing changed. ${report.listingsToReset} untracked listing(s) would be reset to stock 0.`);
    return;
  }
  const actor = arg('actor');
  if (!actor) {
    console.error('--apply needs --actor "<your name>"');
    process.exit(2);
  }
  const result = await applyFoodStockBackfill(actor);
  console.log(`reset ${result.reset} untracked food listing(s) to stock 0 (audited).`);
}

main()
  .catch((error: unknown) => {
    console.error('failed:', error instanceof Error ? error.message.split('\n')[0] : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
