/**
 * Smart Search backfill — builds the search terms of every product.
 * See src/infra/search/backfill.ts.
 *
 *   npm run search:backfill:v2 -- --dry-run          # count + preview, writes nothing
 *   npm run search:backfill:v2                       # rebuild every product's terms
 *   npm run search:backfill:v2 -- --batch-size 100   # smaller transactions
 *
 * Safe to re-run at any time (idempotent) and alongside the live API.
 * Exit code 1 when any batch failed (just re-run it; failed batches are listed).
 */

import { prisma } from '../src/infra/db/prisma';
import { runSearchBackfill } from '../src/infra/search/backfill';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rawBatchSize = arg('batch-size');
  const batchSize = rawBatchSize === undefined ? undefined : Number(rawBatchSize);
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
    console.error('--batch-size must be a positive whole number');
    process.exit(2);
  }

  const started = Date.now();
  console.log(`Smart Search backfill — ${dryRun ? 'DRY RUN (nothing is written)' : 'APPLY'}`);
  const report = await runSearchBackfill({
    dryRun,
    ...(batchSize !== undefined ? { batchSize } : {}),
    onProgress: (p) =>
      console.log(
        `  ${p.processed}/${p.total} products — indexed ${p.indexed}, deleted (terms cleared) ${p.cleared}, terms ${p.terms}` +
          (p.failedBatches ? `, FAILED batches ${p.failedBatches}` : ''),
      ),
  });

  const { preview, ...summary } = report;
  console.log(JSON.stringify({ ...summary, seconds: Math.round((Date.now() - started) / 100) / 10 }, null, 2));
  if (dryRun) {
    for (const item of preview) console.log(`  · ${item.name}: ${item.termCount} terms — ${item.sampleTerms.join(', ')}`);
    console.log('\nNothing changed.');
  }
  if (report.failedBatches > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('failed:', error instanceof Error ? error.message.split('\n')[0] : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
