import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1, ssl: 'require' });

try {
  await sql.unsafe(`
    ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
    CREATE INDEX IF NOT EXISTS "categories_status_idx" ON "categories" ("status");
  `);
  console.log('Successfully added status column to categories table');
} catch (err) {
  console.error('Failed to alter categories table:', err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
