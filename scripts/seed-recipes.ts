import * as dotenv from 'dotenv';
dotenv.config({ path: 'development.env' });
import { db, closeDb } from '../src/db/client.js';
import {
  procedures,
  quiz,
  user,
  stations,
  categories,
  subcategories,
} from '../src/db/index.js';
import { eq } from 'drizzle-orm';
let idCounter = 1;
function genId() {
  return 'id-' + idCounter++;
}

async function seedRecipes() {
  console.log('Seeding recipes...');

  const [admin] = await db
    .select()
    .from(user)
    .where(eq(user.email, 'admin@yopmail.com'))
    .limit(1);
  if (!admin) throw new Error('Admin not found');

  const [grillStation] = await db
    .select()
    .from(stations)
    .where(eq(stations.name, 'Grill station'))
    .limit(1);
  if (!grillStation)
    throw new Error('Grill station not found. Ensure stations are seeded.');

  const [recipeCategory] = await db
    .select()
    .from(categories)
    .where(eq(categories.nameEn, 'Recipes'))
    .limit(1);
  if (!recipeCategory)
    throw new Error(
      'Recipes category not found. Ensure categories are seeded.',
    );

  const [cookingSub] = await db
    .select()
    .from(subcategories)
    .where(eq(subcategories.categoryId, recipeCategory.id))
    .limit(1);
  if (!cookingSub) throw new Error('Cooking subcategory not found');

  const recipesData = [
    {
      titleEn: 'Shrimp Ceviche Verde / Roja',
      titleEs: 'Ceviche de Camarón Verde / Roja',
      purposeEn: 'Preparation and plating of Shrimp Ceviche',
      purposeEs: 'Preparación y emplatado del Ceviche de Camarón',
      slug: 'shrimp-ceviche-verde-roja',
      stepsEn: [
        'Prepare the mixing bowl. Use a large bowl to prepare the ceviche.',
        'Add the shrimp. Transfer 1 prepared container of shrimp from Prep into the bowl.',
        'Add the cucumber. Add 1 handful of sliced cucumber.',
        'Add the onion. Add 2½ spoonfuls of diced white onion.',
        'Add the tomatillo. Add 3–4 pieces of cut tomatillo.',
        'Add the lime. Add approximately 4–5 tablespoons of lime juice.',
        'Add the Ceviche Verde sauce. Coat ingredients evenly.',
        'Season with salt. Add approximately ½ tablespoon of salt.',
        'Mix thoroughly.',
      ],
    },
    {
      titleEn: 'Beet Ceviche',
      titleEs: 'Ceviche de Remolacha',
      purposeEn: 'Preparation of Beet Ceviche',
      purposeEs: 'Preparación del Ceviche de Remolacha',
      slug: 'beet-ceviche',
      stepsEn: [
        'Prepare the mixing bowl.',
        'Add 3 scoops of cubed beets to the bowl.',
        'Add 3–4 pieces of diced tomatillo.',
        'Add 2½ spoonfuls of diced white onion.',
        'Add enough poblano marinade to evenly coat.',
        'Add approximately 4–5 tablespoons of lime juice.',
      ],
    },
    {
      titleEn: 'Hamachi Crudo',
      titleEs: 'Crudo de Hamachi',
      purposeEn: 'Preparation of Hamachi Crudo',
      purposeEs: 'Preparación del Crudo de Hamachi',
      slug: 'hamachi-crudo',
      stepsEn: [
        'Use a large mixing bowl.',
        'Add 1 handful of sliced cucumber.',
        'Add 1 handful of sliced red onion.',
        'Pour jícama aguachile into the bowl.',
        'Add approximately 4–5 tablespoons of lime juice.',
        'Season with salt. Add approximately ⅓ spoonful of salt.',
      ],
    },
    {
      titleEn: 'Halloumi Tostada',
      titleEs: 'Tostada de Halloumi',
      purposeEn: 'Preparation and assembly of Halloumi Tostada',
      purposeEs: 'Preparación y ensamblaje de la Tostada de Halloumi',
      slug: 'halloumi-tostada',
      stepsEn: [
        'Remove 5–6 slices of halloumi from the designated container.',
        'Fry the halloumi in the first two fryers. Do not use the third fryer (fish only).',
        'Cook until golden brown.',
        'Take 1 tostada and place it on the working surface.',
        'Spread 1 spoonful of hummus.',
        'Arrange halloumi slices over the hummus.',
        'Sprinkle pumpkin and edamame seed mixture.',
      ],
    },
    {
      titleEn: 'House-Made Corn Chips',
      titleEs: 'Totopos Caseros',
      purposeEn: 'Frying and storing House-Made Corn Chips',
      purposeEs: 'Fritura y almacenamiento de Totopos Caseros',
      slug: 'house-made-corn-chips',
      stepsEn: [
        'Remove the required corn tortillas from their package.',
        'Split each tortilla into 2 halves, then cut each half down the middle.',
        'Separate the pieces.',
        'Gently place approximately 20–25 tortilla pieces into Fryer 1 or 2.',
        'Regularly turn and rotate.',
        'Fry for approximately 2–3 minutes.',
      ],
    },
    {
      titleEn: 'Tostadas',
      titleEs: 'Tostadas',
      purposeEn: 'Preparation of whole tostadas',
      purposeEs: 'Preparación de tostadas enteras',
      slug: 'tostadas-recipe',
      stepsEn: [
        'Keep the tortillas whole.',
        'Separate the tortillas.',
        'Gently place 5–6 whole tortillas at a time into Fryer 1 or 2.',
        'Fry evenly until golden brown.',
      ],
    },
    {
      titleEn: 'Papas for Bavette',
      titleEs: 'Papas para Bavette',
      purposeEn: 'Cooking potatoes for Bavette',
      purposeEs: 'Cocción de papas para Bavette',
      slug: 'papas-for-bavette',
      stepsEn: [
        'Wait for the call from Expo.',
        'Use 10 potatoes for 1 order of Bavette.',
        'Place the potatoes into the fryer and cook for 1m30s to 2m.',
      ],
    },
  ];

  for (const r of recipesData) {
    // 1. Create Quiz for the recipe
    const [insertedQuiz] = await db
      .insert(quiz)
      .values({
        nameEn: `${r.titleEn} Knowledge Check`,
        nameEs: `Prueba de ${r.titleEs}`,
        quizType: 'procedure',
        createdBy: admin.id,
        questions: [
          {
            id: genId(),
            question: {
              en: `What is the first step for ${r.titleEn}?`,
              es: `¿Cuál es el primer paso para ${r.titleEs}?`,
            },
            choices: [
              { id: '1', label: { en: r.stepsEn[0], es: 'Paso correcto' } },
              {
                id: '2',
                label: { en: 'Serve immediately', es: 'Servir inmediatamente' },
              },
            ],
            correctChoiceId: '1',
          },
        ],
      })
      .returning();

    // 2. Build blocks featuring EVERY block type to satisfy the prompt requirements
    const blocks = [
      {
        id: genId(),
        kind: 'heading',
        level: 1,
        text: { en: 'Overview', es: 'Resumen' },
      },
      {
        id: genId(),
        kind: 'text',
        body: {
          en: `Follow the recipe for ${r.titleEn} carefully.`,
          es: `Siga la receta de ${r.titleEs} con cuidado.`,
        },
      },
      {
        id: genId(),
        kind: 'warning',
        severity: 'warn',
        body: {
          en: 'Always taste before plating!',
          es: '¡Siempre pruebe antes de emplatar!',
        },
      },
      {
        id: genId(),
        kind: 'ingredients',
        ingredients: [{ name: 'Primary Ingredient', amounts: ['1 portion'] }],
      },
      {
        id: genId(),
        kind: 'table',
        headers: [
          { en: 'Tool', es: 'Herramienta' },
          { en: 'Usage', es: 'Uso' },
        ],
        rows: [
          [
            { en: 'Mixing Bowl', es: 'Tazón' },
            { en: 'Preparation', es: 'Preparación' },
          ],
        ],
      },
      {
        id: genId(),
        kind: 'image',
        src: 'https://via.placeholder.com/800x400.png?text=Recipe+Image',
        alt: { en: 'Recipe Image', es: 'Imagen de receta' },
        hint: 'photo',
      },
      {
        id: genId(),
        kind: 'video',
        src: 'https://www.w3schools.com/html/mov_bbb.mp4',
        caption: { en: 'Instructional Video', es: 'Video instructivo' },
      },
      {
        id: genId(),
        kind: 'checklist',
        title: { en: 'Prep Checklist', es: 'Lista de Preparación' },
        items: [
          {
            id: genId(),
            text: { en: 'Station clean?', es: '¿Estación limpia?' },
          },
        ],
      },
      {
        id: genId(),
        kind: 'attachment',
        title: { en: 'Printable Recipe Card', es: 'Tarjeta de Receta' },
        href: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
      },
      {
        id: genId(),
        kind: 'method',
        steps: [
          ...r.stepsEn.map((step) => ({
            id: genId(),
            body: { en: step, es: `(ES) ${step}` },
          })),
          {
            id: genId(),
            body: {
              en: 'Final Handoff: Send to Expo',
              es: 'Entrega Final: Enviar a Expo',
            },
          },
        ],
      },
    ];

    await db
      .insert(procedures)
      .values({
        slug: r.slug,
        titleEn: r.titleEn,
        titleEs: r.titleEs,
        purposeEn: r.purposeEn,
        purposeEs: r.purposeEs,
        subcategoryId: cookingSub.id,
        stationIds: [grillStation.id],
        quizId: insertedQuiz.id,
        status: 'published',
        blocksEn: blocks,
        blocksEs: blocks,
        createdBy: admin.id,
      })
      .onConflictDoNothing();

    console.log(`Seeded procedure: ${r.titleEn}`);
  }

  console.log(
    'All recipes successfully seeded with all block types, quizzes, and station assignments!',
  );
}

seedRecipes()
  .then(() => closeDb())
  .catch((err) => {
    console.error('Seed failed:', err);
    closeDb();
    process.exit(1);
  });
