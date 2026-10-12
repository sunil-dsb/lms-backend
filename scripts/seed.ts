// ============================================================================
// lms-backend seed
// ============================================================================
// Idempotent setup for a fresh dev environment. Run with:
//
//   pnpm db:seed
//
// What it does:
//   1. Seeds locations (seed-locations.ts).
//   2. Seeds jobs (seed-jobs.ts).
//   3. Seeds stations for loc-main (seed-stations.ts).
//   4. Ensures a super_admin employee exists (idempotent — if one
//      already exists, leaves it alone).
//   5. Ensures the super admin user (admin@yopmail.com, role=super_admin)
//      exists with email verified so they can log in immediately.
//   6. Seeds categories + subcategories (seed-categories.ts).
//
// The seed NEVER sets a password. To log in as the master, open the printed
// URL, enter the code, and choose a password. Better Auth's signUpEmail then
// creates the user row at activation time.
// ============================================================================

import * as dotenv from 'dotenv';
dotenv.config({ path: 'development.env' });
import { closeDb } from '../src/db/client.ts';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { user, SUPER_ADMIN_USER_ROLE } from '../src/db/schema/index.ts';
import { auth } from '../src/config/auth.ts';

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Returns the super admin's user id so seed-categories can use it as the
// creator (categories.created_by references user.id).
async function ensureSuperAdminUser(): Promise<string> {
  const email = 'admin@yopmail.com';
  const password = 'Admin@321';

  const [existingUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existingUser) {
    // Older seeds did not set the role; make sure it is there.
    await db
      .update(user)
      .set({ role: SUPER_ADMIN_USER_ROLE })
      .where(eq(user.id, existingUser.id));
    console.log(`Super admin user already exists: ${email}`);
    return existingUser.id;
  }

  console.log(`\n===========================================`);
  console.log(`Creating super admin user: ${email}...`);
  const created = await auth.api.signUpEmail({
    body: { email, password, name: 'Admin' },
  });
  // Mark as verified so they can login immediately, and grant super admin.
  await db
    .update(user)
    .set({ emailVerified: true, role: SUPER_ADMIN_USER_ROLE })
    .where(eq(user.id, created.user.id));
  console.log(
    `✅ Super admin user created! You can login with:\nEmail: ${email}\nPassword: ${password}`,
  );
  return created.user.id;
}

async function run(): Promise<void> {
  console.log(' Starting master seed...\n');
  const SCRIPTS = ['seed-locations.ts', 'seed-jobs.ts', 'seed-stations.ts'];

  for (const script of SCRIPTS) {
    console.log(`\n===========================================`);
    console.log(`Running ${script}...`);
    console.log(`===========================================\n`);

    const scriptPath = path.join(__dirname, script);
    const result = spawnSync(
      'npx',
      ['tsx', '--env-file=development.env', scriptPath],
      {
        stdio: 'inherit',
        env: process.env,
        shell: true,
      },
    );

    if (result.status !== 0) {
      console.error(`\n❌ Failed executing ${script}`);
      process.exit(1);
    }
  }

  console.log('\n===========================================');
  console.log('Ensuring super admin user (seed.ts)...');
  console.log('===========================================\n');
  const superAdminUserId = await ensureSuperAdminUser();

  console.log('\n===========================================');
  console.log('Running seed-categories.ts...');
  console.log('===========================================\n');
  const catResult = spawnSync(
    'npx',
    ['tsx', path.join(__dirname, 'seed-categories.ts')],
    {
      stdio: 'inherit',
      env: { ...process.env, SEED_CREATOR_USER_ID: superAdminUserId },
      shell: true,
    },
  );
  if (catResult.status !== 0) {
    console.error(`\n❌ Failed executing seed-categories.ts`);
    process.exit(1);
  }

  console.log('\n✅ All seeds completed successfully!');
}

run()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
