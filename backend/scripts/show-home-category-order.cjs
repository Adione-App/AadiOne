const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function main() {
  const rows = await prisma.configuration.findMany({
    where: { key: "HOME_CATEGORY_ORDER" },
    select: {
      key: true,
      sellerId: true,
      value: true,
    },
  });
  console.dir(rows, { depth: null });
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
