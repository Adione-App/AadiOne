import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
const env = config({ path: ".env.v2", override: true });
if (env.error) throw env.error;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL missing");
const url = new URL(databaseUrl);
console.log("Database host:", url.hostname);
console.log("Database:", url.pathname);
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});
try {
  const rows = await prisma.$queryRaw`
    SELECT migration_name, started_at, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    WHERE migration_name IN (
      '20261111120000_v2_settlement_payout_proof',
      '20261112120000_v2_legal_acceptances'
    )
    ORDER BY migration_name
  `;
  console.table(rows);
} catch (error) {
  console.error(error.message);
} finally {
  await prisma.$disconnect();
}
