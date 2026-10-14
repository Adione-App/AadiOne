const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function main() {
  console.log("Database identity:");
  const identity = await prisma.$queryRawUnsafe(`
    SELECT
      current_database() AS database_name,
      current_schema() AS schema_name,
      to_regclass('_prisma_migrations')::text AS migrations_table,
      to_regclass('sellers')::text AS sellers_table,
      to_regclass('stores')::text AS stores_table
  `);
  console.table(identity);
  console.log("Recent migrations:");
  const migrations = await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at
    FROM _prisma_migrations
    WHERE finished_at IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 10
  `);
  console.table(migrations);
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
