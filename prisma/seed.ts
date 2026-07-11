/**
 * Seed: ProducerCategory catalog (O-2 LOCKED — 15 slugs, never add/remove without spec update)
 *       Category catalog (Cycle 2 — product taxonomy, 8 canonical slugs)
 *
 * Idempotent: uses upsert keyed on slug so re-runs never duplicate rows.
 * Run via: npm run db:seed  (or `prisma db seed` with the config below wired in package.json)
 *
 * ---------------------------------------------------------------------------
 * NAMING CLARIFICATION: ProducerCategory vs Category
 *
 * ProducerCategory (O-2 LOCKED, table: producer_categories)
 *   Classifies the PRODUCER'S BUSINESS TYPE (e.g., "Quesos y lácteos").
 *   Managed by the producer on-boarding form. NEVER touch these rows without
 *   a spec update — they are locked.
 *
 * Category (Cycle 2, table: categories)
 *   Classifies individual PRODUCTS in the public catalog.
 *   Used as a FK on Product. Seeds 8 representative product categories.
 *   These slugs intentionally differ from ProducerCategory slugs to minimize
 *   confusion, but coexistence with the same slug in both tables is allowed
 *   and tested (see Coexistence scenario in spec product-taxonomy).
 *
 * SUGGESTION: the spec product-taxonomy §"Category entity" does not enumerate
 * a canonical slug list. The 8 slugs below are a representative set chosen to
 * cover the main artisan food product types in the Spanish market. Confirm
 * or expand this list via a spec update before production launch.
 * ---------------------------------------------------------------------------
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** O-2 LOCKED — 15 slugs, never add/remove/rename without spec update. */
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

/**
 * Product category seed — Cycle 2 (product-taxonomy).
 *
 * 8 representative slugs for the public product catalog.
 * Spec product-taxonomy §"Category entity" does not specify a canonical list;
 * this set is a SUGGESTION — confirm before production launch.
 *
 * All rows default to isActive=true (spec default).
 */
const PRODUCT_CATEGORIES: Array<{ slug: string; name: string; description: string }> = [
  { slug: "aceites", name: "Aceites", description: "Aceites de oliva y otros aceites artesanales" },
  { slug: "conservas", name: "Conservas", description: "Conservas vegetales, de pescado y encurtidos" },
  { slug: "embutidos-y-charcuteria", name: "Embutidos y charcutería", description: "Embutidos artesanales y productos cárnicos curados" },
  { slug: "lacteos-y-quesos", name: "Lácteos y quesos", description: "Quesos artesanales, mantequillas y otros lácteos" },
  { slug: "mieles-y-mermeladas", name: "Mieles y mermeladas", description: "Mieles, mermeladas y productos apícolas" },
  { slug: "panaderia", name: "Panadería", description: "Pan artesanal, bollería y repostería tradicional" },
  { slug: "vinos-y-bebidas", name: "Vinos y bebidas", description: "Vinos, cervezas artesanales y licores" },
  { slug: "especias-y-condimentos", name: "Especias y condimentos", description: "Especias, hierbas aromáticas y salsas artesanales" },
];

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Seed ProducerCategory (O-2 LOCKED — do not touch)
  // ---------------------------------------------------------------------------
  console.log("Seeding ProducerCategory catalog...");

  for (const category of PRODUCER_CATEGORIES) {
    await prisma.producerCategory.upsert({
      where: { slug: category.slug },
      update: { name: category.name },
      create: { slug: category.slug, name: category.name },
    });
  }

  const producerCategoryCount = await prisma.producerCategory.count();
  console.log(`ProducerCategory seed complete — ${producerCategoryCount} entries.`);

  // ---------------------------------------------------------------------------
  // Seed Category (Cycle 2 — product taxonomy)
  // ---------------------------------------------------------------------------
  console.log("Seeding Category catalog (product taxonomy)...");

  for (const category of PRODUCT_CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name, description: category.description },
      create: {
        slug: category.slug,
        name: category.name,
        description: category.description,
        isActive: true,
      },
    });
  }

  const productCategoryCount = await prisma.category.count();
  console.log(`Category seed complete — ${productCategoryCount} entries.`);
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
