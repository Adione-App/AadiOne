/**
 * Correct ONE seller's misspelled display name from the reviewed allow-list in
 * src/modules/sellers/seller-name-correction.ts. Dry run unless --apply.
 *
 *   npm run seller:correct-name:v2 -- --code NEPALIKICHEN
 *   npm run seller:correct-name:v2 -- --code NEPALIKICHEN --apply
 *
 * Takes only the seller code (no free-text names), so Windows shells cannot
 * mangle it. Prints the code, names and category ids (shortened) only.
 */

import { prisma } from '../src/infra/db/prisma';
import { correctSellerName } from '../src/modules/sellers/seller-name-correction';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const code = arg('code');
  if (!code) {
    console.error('--code is required (the exact seller code)');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const outcome = await correctSellerName(code, { apply });
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', ...outcome }, null, 2));
  if (!['WOULD_CHANGE', 'CHANGED', 'ALREADY_DONE'].includes(outcome.status)) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('failed:', error instanceof Error ? error.message.split('\n')[0] : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
