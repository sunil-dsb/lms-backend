import 'dotenv/config';
import { asc } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.ts';
import { categories, subcategories, user } from '../src/db/schema/index.ts';

// categories.created_by references user.id, so the creator must be a real
// Better Auth user. seed.ts passes the super admin's id; when this script runs
// on its own we fall back to the oldest user in the database.
async function resolveCreatorId(): Promise<string> {
  const fromEnv = process.env.SEED_CREATOR_USER_ID;
  if (fromEnv) return fromEnv;

  const [first] = await db
    .select({ id: user.id })
    .from(user)
    .orderBy(asc(user.createdAt))
    .limit(1);
  if (!first) {
    throw new Error(
      'No user found to own the seeded categories. Run `pnpm db:seed` (creates the super admin) or set SEED_CREATOR_USER_ID.',
    );
  }
  return first.id;
}

async function seedCategories() {
  console.log('Seeding categories and subcategories...');

  const creatorId = await resolveCreatorId();
  console.log(`Using User ID for creator: ${creatorId}`);

  console.log('Clearing old categories and subcategories...');
  await db.delete(subcategories);
  await db.delete(categories);

  // --- GENERAL CATEGORIES ---
  const generalData = [
    {
      nameEn: 'Onboarding',
      nameEs: 'Inducción',
      categoryType: 'general' as const,
      categoryIcon: 'user',
      subcats: [
        { en: 'Culture', es: 'Cultura' },
        { en: 'Uniform', es: 'Uniforme' },
        { en: 'Conduct', es: 'Conducta' },
      ],
    },
    {
      nameEn: 'Food Safety',
      nameEs: 'Seguridad Alimentaria',
      categoryType: 'general' as const,
      categoryIcon: 'shield-check',
      subcats: [
        { en: 'Hygiene', es: 'Higiene' },
        { en: 'Cross Contamination', es: 'Contaminación Cruzada' },
        { en: 'Labeling & Dating', es: 'Etiquetado y Fechado' },
        { en: 'Allergy', es: 'Alergias' },
      ],
    },
    {
      nameEn: 'Cleaning',
      nameEs: 'Limpieza',
      categoryType: 'general' as const,
      categoryIcon: 'sparkles',
      subcats: [
        { en: 'Dishwashing', es: 'Lavado de Platos' },
        { en: 'Chemical Handling', es: 'Manejo de Productos Químicos' },
        { en: 'Waste Disposal', es: 'Eliminación de Residuos' },
      ],
    },
  ];

  // --- STATION-BASED CATEGORIES ---
  const stationData = [
    {
      nameEn: 'Kitchen Operations',
      nameEs: 'Operaciones de Cocina',
      categoryType: 'station_based' as const,
      categoryIcon: 'pot',
      subcats: [
        { en: 'Station Setup', es: 'Configuración de Estación' },
        { en: 'Kitchen Communication', es: 'Comunicación en Cocina' },
      ],
    },
    {
      nameEn: 'Opening and Closing',
      nameEs: 'Apertura y Cierre',
      categoryType: 'station_based' as const,
      categoryIcon: 'door',
      subcats: [
        { en: 'Opening Procedures', es: 'Procedimientos de Apertura' },
        { en: 'Closing Procedures', es: 'Procedimientos de Cierre' },
        { en: 'End of Day Checks', es: 'Revisiones de Fin de Día' },
      ],
    },
    {
      nameEn: 'Equipment',
      nameEs: 'Equipo',
      categoryType: 'station_based' as const,
      categoryIcon: 'briefcase',
      subcats: [
        { en: 'Operation', es: 'Operación' },
        { en: 'Equipment Safety', es: 'Seguridad del Equipo' },
        { en: 'Equipment Cleaning', es: 'Limpieza del Equipo' },
      ],
    },
    {
      nameEn: 'Recipes',
      nameEs: 'Recetas',
      categoryType: 'station_based' as const,
      categoryIcon: 'book-open',
      subcats: [{ en: 'Cooking', es: 'Cocción' }],
    },
  ];

  const allData = [...generalData, ...stationData];

  for (const data of allData) {
    // 1. Insert Category
    const [insertedCategory] = await db
      .insert(categories)
      .values({
        id: crypto.randomUUID(),
        nameEn: data.nameEn,
        nameEs: data.nameEs,
        categoryType: data.categoryType,
        categoryIcon: data.nameEn,
        createdBy: creatorId,
      })
      .returning();

    console.log(`Seeded category: ${data.nameEn}`);

    // 2. Insert Subcategories
    if (data.subcats.length > 0) {
      const subcatsToInsert = data.subcats.map((subcat) => ({
        id: crypto.randomUUID(),
        categoryId: insertedCategory.id,
        nameEn: subcat.en,
        nameEs: subcat.es,
        subcategoryIcon: subcat.en, // Use subcategory name for the icon
        createdBy: creatorId,
      }));

      await db.insert(subcategories).values(subcatsToInsert);
      console.log(`  -> Seeded ${data.subcats.length} subcategories`);
    }
  }

  console.log('Done seeding categories.');
}

// Run the script
seedCategories()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
