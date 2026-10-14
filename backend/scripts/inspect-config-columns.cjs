const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function main() {
  const columns = await prisma.$queryRaw`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'configurations'
    ORDER BY ordinal_position
  `;
  console.table(columns);
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
