/**
 * Seed: ProducerCategory catalog (O-2 LOCKED — 15 slugs, never add/remove without spec update)
 *
 * Idempotent: uses upsert keyed on slug so re-runs never duplicate rows.
 * Run via: npm run db:seed  (or `prisma db seed` with the config below wired in package.json)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PRODUCER_CATEGORIES: Array<{ slug: string; name: string }> = [
  { slug: "aceite-de-oliva", name: "Aceite de oliva" },
  { slug: "panaderia-y-bolleria", name: "Panadería y bollería" },
  { slug: "queso", name: "Queso" },
  { slug: "embutidos", name: "Embutidos" },
  { slug: "miel", name: "Miel" },
  { slug: "conservas-y-encurtidos", name: "Conservas y encurtidos" },
  { slug: "dulces-y-turrones", name: "Dulces y turrones" },
  { slug: "vino", name: "Vino" },
  { slug: "cerveza-artesanal", name: "Cerveza artesanal" },
  { slug: "licores-y-vermut", name: "Licores y vermut" },
  { slug: "frutas-y-verduras", name: "Frutas y verduras" },
  { slug: "frutos-secos", name: "Frutos secos" },
  { slug: "especias-y-hierbas", name: "Especias y hierbas" },
  { slug: "salsas-y-condimentos", name: "Salsas y condimentos" },
  { slug: "otros", name: "Otros" },
];

async function main(): Promise<void> {
  console.log("Seeding ProducerCategory catalog...");

  for (const category of PRODUCER_CATEGORIES) {
    await prisma.producerCategory.upsert({
      where: { slug: category.slug },
      update: { name: category.name },
      create: { slug: category.slug, name: category.name },
    });
  }

  const count = await prisma.producerCategory.count();
  console.log(`Seed complete — ${count} categories in the catalog.`);
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
