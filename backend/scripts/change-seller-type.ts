/**
 * Change ONE existing seller's type, by exact code, only from the expected
 * current type. Dry run unless --apply. See src/modules/sellers/seller-type-change.ts.
 *
 *   npm run seller:change-type:v2 -- --code NEPALIKICHEN --from CAFE --to RESTAURANT
 *   npm run seller:change-type:v2 -- --code NEPALIKICHEN --from CAFE --to RESTAURANT --apply
 *
 * Prints only the code, types and counts — never a credential or customer data.
 */

import { SellerType } from '../src/shared';
import { prisma } from '../src/infra/db/prisma';
import { changeSellerType } from '../src/modules/sellers/seller-type-change';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sellerType(value: string | undefined, flag: string): SellerType {
  if (!value || !(Object.values(SellerType) as string[]).includes(value)) {
    console.error(`--${flag} must be one of: ${Object.values(SellerType).join(', ')}`);
    process.exit(2);
  }
  return value as SellerType;
}

async function main(): Promise<void> {
  const code = arg('code');
  if (!code) {
    console.error('--code is required (the exact seller code)');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const outcome = await changeSellerType(
    { code, from: sellerType(arg('from'), 'from'), to: sellerType(arg('to'), 'to') },
    { apply, reason: arg('reason') ?? 'Requested seller type correction' },
  );
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', ...outcome }, null, 2));
  if (!['WOULD_CHANGE', 'CHANGED', 'ALREADY_DONE'].includes(outcome.status)) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('failed:', error instanceof Error ? error.message.split('\n')[0] : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
