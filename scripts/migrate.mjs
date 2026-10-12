import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Applies pending migrations from drizzle/migrations. This is what runs in
// the production image at deploy time: `pnpm db:migrate` needs drizzle-kit,
// which is a dev dependency and is not installed there. Both record applied
// migrations in the same drizzle.__drizzle_migrations table.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1, ssl: 'require', onnotice: () => {} });

try {
  await migrate(drizzle(sql), { migrationsFolder: './drizzle/migrations' });
  console.log('Migrations applied');
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
