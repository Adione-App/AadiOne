/**
 * READ-ONLY: the accounts a mobile number has — its partner (Seller Panel /
 * staff) account as seller signup classifies it
 * (src/modules/sellers/seller-mobile-conflict.ts), and its separate customer
 * (shopping app) account. Prints the
 * classification, roles and store names/states only — the number is masked,
 * and no other personal data is printed.
 *
 *   npm run seller:mobile-conflict:v2 -- --mobile 8690530973
 *   npm run seller:mobile-conflict:v2 -- --mobile "+91 86905 30973"
 */

import { maskMobile, normalizeIndianMobile } from '../src/shared';
import { prisma } from '../src/infra/db/prisma';
import { findMobileConflict, sellerSignupConflictMessage } from '../src/modules/sellers/seller-mobile-conflict';

async function main(): Promise<void> {
  const index = process.argv.indexOf('--mobile');
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  const mobile = raw ? normalizeIndianMobile(raw) : null;
  if (!mobile) {
    console.error('--mobile <10-digit Indian mobile> is required (+91 / spaces are accepted)');
    process.exit(2);
  }
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const conflict = await findMobileConflict(tx, mobile);
    const user = conflict.userId
      ? await tx.user.findUnique({
          where: { id: conflict.userId },
          select: {
            role: true,
            status: true,
            createdAt: true,
            mobileVerifiedAt: true,
            sellerStaff: {
              select: { role: true, isActive: true, deletedAt: true, seller: { select: { code: true, name: true, lifecycleStatus: true, isActive: true, deletedAt: true } } },
            },
            _count: { select: { orders: true } },
          },
        })
      : null;
    // The number's separate customer (shopping app) account — never a conflict for seller signup.
    const customer = await tx.user.findFirst({
      where: { mobile, role: 'CUSTOMER' },
      select: { status: true, createdAt: true, _count: { select: { orders: true } } },
    });
    return { conflict, user, customer };
  });
  const { conflict, user, customer } = result;
  console.log(
    JSON.stringify(
      {
        mobile: maskMobile(mobile),
        classification: conflict.kind,
        sellerSignupWouldSay: conflict.kind === 'NONE' ? '(no conflict — signup can proceed)' : sellerSignupConflictMessage(conflict),
        account: user
          ? {
              role: user.role,
              status: user.status,
              createdAt: user.createdAt.toISOString(),
              everVerifiedByOtp: user.mobileVerifiedAt !== null,
              customerOrders: user._count.orders,
              sellerMemberships: user.sellerStaff.map((m) => ({
                sellerCode: m.seller.code,
                sellerName: m.seller.name,
                lifecycleStatus: m.seller.lifecycleStatus,
                sellerActive: m.seller.isActive,
                sellerSoftDeleted: m.seller.deletedAt !== null,
                membershipRole: m.role,
                membershipActive: m.isActive && m.deletedAt === null,
              })),
            }
          : null,
        customerAppAccount: customer
          ? { status: customer.status, createdAt: customer.createdAt.toISOString(), orders: customer._count.orders }
          : null,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: unknown) => {
    console.error('failed:', error instanceof Error ? error.message.split('\n')[0] : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
