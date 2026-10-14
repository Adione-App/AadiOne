const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function main() {
  const categories = await prisma.category.findMany({
    where: { isActive: true, deletedAt: null },
    select: {
      name: true,
      slug: true,
      path: true,
      depth: true,
      displayOrder: true,
      parentId: true,
    },
    orderBy: [
      { depth: "asc" },
      { displayOrder: "asc" },
      { name: "asc" },
    ],
  });
  console.table(categories);
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
