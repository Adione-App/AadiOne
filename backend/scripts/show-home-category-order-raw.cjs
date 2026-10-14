const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function main() {
  const rows = await prisma.$queryRaw`
    SELECT key, store_id, value
    FROM configurations
    WHERE key = 'HOME_CATEGORY_ORDER'
  `;
  console.dir(rows, { depth: null });
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
