import * as dotenv from 'dotenv';
dotenv.config({ path: 'development.env' });
import crypto from 'node:crypto';
import { sql, closeDb } from '../src/db/client.ts';

const LOCATIONS = ['Alimentaria Mexicana'];

async function seedLocations() {
  console.log('Seeding locations...');
  for (const name of LOCATIONS) {
    const existing = await sql`SELECT id FROM locations WHERE name = ${name}`;
    if (existing.length === 0) {
      const locId = crypto.randomUUID();
      await sql`
        INSERT INTO locations (id, name)
        VALUES (${locId}, ${name})
      `;
      console.log(`location: ${locId} (${name}) - created`);
    } else {
      const locId = existing[0].id;
      console.log(`location: ${locId} (${name}) - exists`);
    }
  }
  console.log('Locations seeded successfully.');
}

seedLocations()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
