/**
 * Seed: ProducerCategory catalog (O-2 LOCKED — 15 slugs, never add/remove without spec update)
 *       Category catalog (Cycle 2 — product taxonomy, 9 canonical slugs)
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
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getS3Client } from "@/shared/s3/s3-client";

const prisma = new PrismaClient();

/** S3 bucket name — same env-read pattern as src/modules/images/services/images.service.ts. */
const S3_BUCKET = process.env["AWS_BUCKET_NAME"] ?? "mercado-artesanal-images";

/** Directory holding the committed seed sample images (prisma/seed-assets/images/). */
const SEED_IMAGE_ASSETS_DIR = path.join(__dirname, "seed-assets", "images");

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
 * 9 representative slugs for the public product catalog.
 * Spec product-taxonomy §"Category entity" does not specify a canonical list;
 * this set is a SUGGESTION — confirm before production launch.
 * Includes "queso" to prove coexistence with ProducerCategory.slug="queso"
 * (O-2 LOCKED) — both slugs live in separate tables without collision.
 *
 * All rows default to isActive=true (spec default).
 */
const PRODUCT_CATEGORIES: Array<{ slug: string; name: string; description: string }> = [
  { slug: "aceites", name: "Aceites", description: "Aceites de oliva y otros aceites artesanales" },
  { slug: "conservas", name: "Conservas", description: "Conservas vegetales, de pescado y encurtidos" },
  { slug: "embutidos-y-charcuteria", name: "Embutidos y charcutería", description: "Embutidos artesanales y productos cárnicos curados" },
  { slug: "lacteos-y-quesos", name: "Lácteos y quesos", description: "Quesos artesanales, mantequillas y otros lácteos" },
  { slug: "mieles-y-mermeladas", name: "Mieles y mermeladas", description: "Mieles, mermeladas y productos apícolas" },
  { slug: "queso", name: "Queso", description: "Quesos artesanales y curados" },
  { slug: "panaderia", name: "Panadería", description: "Pan artesanal, bollería y repostería tradicional" },
  { slug: "vinos-y-bebidas", name: "Vinos y bebidas", description: "Vinos, cervezas artesanales y licores" },
  { slug: "especias-y-condimentos", name: "Especias y condimentos", description: "Especias, hierbas aromáticas y salsas artesanales" },
];

/**
 * Demo/guest-environment world data — WU4.
 *
 * Gated by DEMO_PRODUCER_AUTH0_SUB + DEMO_ADMIN_AUTH0_SUB. Without both set,
 * `db:seed` behaves exactly as it does today (no demo rows at all).
 *
 * Scope is deliberately MINIMUM: zero Order/Payment/SubOrder/OrderLine/Incident
 * rows. Those are hand-created by the repo owner after this seed runs (see
 * Engram topic_key plan/demo-guest-environment-wu4-seed for the full rationale).
 *
 * Idempotency: User upserts on auth0Sub (natural unique key). Producer upserts
 * on userId (natural unique key). DeliveryMode/Product/Address/Notification
 * have no natural unique key in the schema, so each row is assigned a fixed
 * deterministic literal `id` and upserted on `id` — safe to re-run on every
 * Railway redeploy without creating duplicates.
 *
 * IMPORTANT (upsert-key gotcha): DEMO_PRODUCER_AUTH0_SUB / DEMO_ADMIN_AUTH0_SUB
 * MUST already hold the real Auth0 `user_id` (the JWT `sub`) before this seed
 * ever runs with intent to serve real traffic. Seeding once with a placeholder
 * value and later swapping the env var creates an ORPHAN row instead of
 * updating the existing one, because upsert matches on the OLD auth0Sub.
 */
/**
 * Product image seed spec — one real, license-verified JPEG per demo-world
 * product (see prisma/seed-assets/images/ATTRIBUTION.md for sources/licenses).
 * `producerOwner` selects which already-created Producer record owns the
 * upload path; actual producerId is resolved at call time in seedProductImages().
 */
const SEED_PRODUCT_IMAGES: ReadonlyArray<{
  productId: string;
  producerOwner: "demo" | "background";
  fileName: string;
  mimeType: string;
}> = [
  { productId: "seed-demo-product-1", producerOwner: "demo", fileName: "seed-demo-product-1.jpg", mimeType: "image/jpeg" },
  { productId: "seed-demo-product-2", producerOwner: "demo", fileName: "seed-demo-product-2.jpg", mimeType: "image/jpeg" },
  { productId: "seed-demo-product-3", producerOwner: "demo", fileName: "seed-demo-product-3.jpg", mimeType: "image/jpeg" },
  { productId: "seed-background-product-1", producerOwner: "background", fileName: "seed-background-product-1.jpg", mimeType: "image/jpeg" },
  { productId: "seed-background-product-2", producerOwner: "background", fileName: "seed-background-product-2.jpg", mimeType: "image/jpeg" },
  { productId: "seed-background-product-3", producerOwner: "background", fileName: "seed-background-product-3.jpg", mimeType: "image/jpeg" },
];

/**
 * Uploads each seed sample image to the real S3 bucket and upserts the
 * matching ProductImage row — bypasses the HTTP presign/confirm API
 * entirely (direct S3 PutObject + Prisma write), since the background
 * producer has no real Auth0 identity to drive the live route (see
 * Engram topic_key plan/demo-guest-environment-wu4-seed for rationale).
 *
 * Idempotent: deterministic S3 key (no UUID) + upsert on (productId, position)
 * — safe to re-run, overwrites rather than duplicating.
 */
async function seedProductImages(demoProducerId: string, backgroundProducerId: string): Promise<void> {
  const s3 = getS3Client();

  for (const { productId, producerOwner, fileName, mimeType } of SEED_PRODUCT_IMAGES) {
    const producerId = producerOwner === "demo" ? demoProducerId : backgroundProducerId;
    const filePath = path.join(SEED_IMAGE_ASSETS_DIR, fileName);
    const body = readFileSync(filePath);
    const s3Key = `producers/${producerId}/products/${productId}/img/seed-0`;

    await s3.send(
      new PutObjectCommand({ Bucket: S3_BUCKET, Key: s3Key, Body: body, ContentType: mimeType }),
    );

    await prisma.productImage.upsert({
      where: { productId_position: { productId, position: 0 } },
      update: { s3Key, mimeType },
      create: { productId, s3Key, mimeType, position: 0 },
    });
  }

  console.log(`Demo world product images seeded — ${SEED_PRODUCT_IMAGES.length} images uploaded to S3 and confirmed.`);
}

async function seedDemoWorld(): Promise<void> {
  const demoProducerAuth0Sub = process.env.DEMO_PRODUCER_AUTH0_SUB;
  const demoAdminAuth0Sub = process.env.DEMO_ADMIN_AUTH0_SUB;

  if (!demoProducerAuth0Sub || !demoAdminAuth0Sub) {
    console.log("DEMO_PRODUCER_AUTH0_SUB / DEMO_ADMIN_AUTH0_SUB not set — skipping demo world seed.");
    return;
  }

  console.log("Seeding demo world (WU4)...");

  // ---------------------------------------------------------------------------
  // Users — 2 demo (real Auth0 identities) + 2 background (never log in)
  // ---------------------------------------------------------------------------
  const demoProducerUser = await prisma.user.upsert({
    where: { auth0Sub: demoProducerAuth0Sub },
    update: { role: "PRODUCER", isDemo: true, emailVerified: true },
    create: {
      auth0Sub: demoProducerAuth0Sub,
      email: "demo-producer@mercado-artesanal.demo",
      emailVerified: true,
      firstName: "Productor",
      lastName: "Demo",
      name: "Productor Demo",
      role: "PRODUCER",
      isDemo: true,
    },
  });

  await prisma.user.upsert({
    where: { auth0Sub: demoAdminAuth0Sub },
    update: { role: "ADMIN", isDemo: true, emailVerified: true },
    create: {
      auth0Sub: demoAdminAuth0Sub,
      email: "demo-admin@mercado-artesanal.demo",
      emailVerified: true,
      firstName: "Admin",
      lastName: "Demo",
      name: "Admin Demo",
      role: "ADMIN",
      isDemo: true,
    },
  });

  const backgroundProducerUser = await prisma.user.upsert({
    where: { auth0Sub: "seed|background-producer-1" },
    update: { role: "PRODUCER", isDemo: false, emailVerified: true },
    create: {
      auth0Sub: "seed|background-producer-1",
      email: "background-producer@mercado-artesanal.demo",
      emailVerified: true,
      firstName: "Productor",
      lastName: "Fondo",
      name: "Productor de Fondo",
      role: "PRODUCER",
      isDemo: false,
    },
  });

  await prisma.user.upsert({
    where: { auth0Sub: "seed|background-consumer-1" },
    update: { role: "CONSUMER", isDemo: false, emailVerified: true },
    create: {
      auth0Sub: "seed|background-consumer-1",
      email: "background-consumer@mercado-artesanal.demo",
      emailVerified: true,
      firstName: "Consumidor",
      lastName: "Fondo",
      name: "Consumidor de Fondo",
      role: "CONSUMER",
      isDemo: false,
    },
  });

  console.log("Demo world users seeded — 2 demo, 2 background.");

  // ---------------------------------------------------------------------------
  // Producers — 1 per demo/background producer user, each with 1 business
  // category assignment (ProducerCategory, O-2 LOCKED slugs).
  // ---------------------------------------------------------------------------
  const demoProducer = await prisma.producer.upsert({
    where: { userId: demoProducerUser.id },
    update: {},
    create: {
      userId: demoProducerUser.id,
      businessName: "Quesería Demo",
      nif: "B12345671",
      description: "Productor de demostración especializado en quesos artesanales.",
      addressLine1: "Calle Mayor 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
  });

  const backgroundProducer = await prisma.producer.upsert({
    where: { userId: backgroundProducerUser.id },
    update: {},
    create: {
      userId: backgroundProducerUser.id,
      businessName: "Bodega de Fondo",
      nif: "B12345672",
      description: "Productor de fondo para catálogo — no inicia sesión.",
      addressLine1: "Calle Bodega 2",
      addressCity: "Logroño",
      addressPostalCode: "26001",
      addressProvince: "La Rioja",
    },
  });

  const quesoProducerCategory = await prisma.producerCategory.findUniqueOrThrow({ where: { slug: "queso" } });
  const vinoProducerCategory = await prisma.producerCategory.findUniqueOrThrow({ where: { slug: "vino" } });

  await prisma.producerCategoryOnProducer.upsert({
    where: { producerId_categoryId: { producerId: demoProducer.id, categoryId: quesoProducerCategory.id } },
    update: {},
    create: { producerId: demoProducer.id, categoryId: quesoProducerCategory.id },
  });

  await prisma.producerCategoryOnProducer.upsert({
    where: { producerId_categoryId: { producerId: backgroundProducer.id, categoryId: vinoProducerCategory.id } },
    update: {},
    create: { producerId: backgroundProducer.id, categoryId: vinoProducerCategory.id },
  });

  console.log("Demo world producers seeded — 2 producers, 1 category assignment each.");

  // ---------------------------------------------------------------------------
  // DeliveryMode — 1 per producer. Demo producer uses PICKUP (no destination
  // address needed, simplifies any manual SubOrder the owner adds later).
  // ---------------------------------------------------------------------------
  await prisma.deliveryMode.upsert({
    where: { id: "seed-demo-producer-delivery-pickup" },
    update: {},
    create: {
      id: "seed-demo-producer-delivery-pickup",
      producerId: demoProducer.id,
      type: "PICKUP",
      cost: 0,
      pickupLocationName: "Quesería Demo — recogida en tienda",
      pickupStreet: "Calle Mayor 1",
      pickupMunicipality: "Madrid",
      pickupPostalCode: "28001",
      isActive: true,
    },
  });

  await prisma.deliveryMode.upsert({
    where: { id: "seed-background-producer-delivery-personal" },
    update: {},
    create: {
      id: "seed-background-producer-delivery-personal",
      producerId: backgroundProducer.id,
      type: "PERSONAL_DELIVERY",
      cost: 3.5,
      coverageZone: "La Rioja",
      isActive: true,
    },
  });

  console.log("Demo world delivery modes seeded — 1 per producer.");

  // ---------------------------------------------------------------------------
  // Products — 3 per producer, reusing existing Category slugs. One product
  // on the BACKGROUND producer is pre-flagged REPORTED so the ADMIN demo has
  // an immediate moderation-queue item.
  // ---------------------------------------------------------------------------
  const lacteosCategory = await prisma.category.findUniqueOrThrow({ where: { slug: "lacteos-y-quesos" } });
  const quesoCategory = await prisma.category.findUniqueOrThrow({ where: { slug: "queso" } });
  const conservasCategory = await prisma.category.findUniqueOrThrow({ where: { slug: "conservas" } });
  const vinosCategory = await prisma.category.findUniqueOrThrow({ where: { slug: "vinos-y-bebidas" } });
  const panaderiaCategory = await prisma.category.findUniqueOrThrow({ where: { slug: "panaderia" } });
  const especiasCategory = await prisma.category.findUniqueOrThrow({ where: { slug: "especias-y-condimentos" } });

  await prisma.product.upsert({
    where: { id: "seed-demo-product-1" },
    update: {},
    create: {
      id: "seed-demo-product-1",
      producerId: demoProducer.id,
      categoryId: lacteosCategory.id,
      name: "Queso curado de oveja",
      description: "Queso curado artesanal elaborado con leche de oveja.",
      price: 12.5,
      stock: 25,
      allergens: ["lacteos"],
    },
  });

  await prisma.product.upsert({
    where: { id: "seed-demo-product-2" },
    update: {},
    create: {
      id: "seed-demo-product-2",
      producerId: demoProducer.id,
      categoryId: quesoCategory.id,
      name: "Queso fresco de cabra",
      description: "Queso fresco suave elaborado con leche de cabra.",
      price: 6.9,
      stock: 40,
      allergens: ["lacteos"],
    },
  });

  await prisma.product.upsert({
    where: { id: "seed-demo-product-3" },
    update: {},
    create: {
      id: "seed-demo-product-3",
      producerId: demoProducer.id,
      categoryId: conservasCategory.id,
      name: "Miel de encurtido artesano",
      description: "Encurtido artesanal en conserva.",
      price: 5.2,
      stock: 30,
      allergens: [],
    },
  });

  await prisma.product.upsert({
    where: { id: "seed-background-product-1" },
    update: {},
    create: {
      id: "seed-background-product-1",
      producerId: backgroundProducer.id,
      categoryId: vinosCategory.id,
      name: "Vino tinto crianza",
      description: "Vino tinto de crianza de la región.",
      price: 9.75,
      stock: 60,
      allergens: ["sulfitos"],
    },
  });

  await prisma.product.upsert({
    where: { id: "seed-background-product-2" },
    update: {},
    create: {
      id: "seed-background-product-2",
      producerId: backgroundProducer.id,
      categoryId: panaderiaCategory.id,
      name: "Pan artesano de masa madre",
      description: "Pan artesanal elaborado con masa madre natural.",
      price: 4.1,
      stock: 20,
      allergens: ["gluten"],
    },
  });

  await prisma.product.upsert({
    where: { id: "seed-background-product-3" },
    update: {
      moderationStatus: "REPORTED",
      reportedAt: new Date(),
      reportReason: "Descripción del producto poco clara — pendiente de revisión.",
    },
    create: {
      id: "seed-background-product-3",
      producerId: backgroundProducer.id,
      categoryId: especiasCategory.id,
      name: "Mezcla de especias mediterránea",
      description: "Mezcla de especias y hierbas para condimentar.",
      price: 3.4,
      stock: 15,
      allergens: [],
      moderationStatus: "REPORTED",
      reportedAt: new Date(),
      reportReason: "Descripción del producto poco clara — pendiente de revisión.",
    },
  });

  console.log("Demo world products seeded — 6 products, 1 flagged REPORTED for moderation demo.");

  // ---------------------------------------------------------------------------
  // Address — default address for the DEMO PRODUCER user only, so a visitor
  // can try the live checkout flow immediately.
  // ---------------------------------------------------------------------------
  await prisma.address.upsert({
    where: { id: "seed-demo-producer-address" },
    update: {},
    create: {
      id: "seed-demo-producer-address",
      userId: demoProducerUser.id,
      line1: "Calle Mayor 1",
      city: "Madrid",
      postalCode: "28001",
      province: "Madrid",
      isDefault: true,
    },
  });

  console.log("Demo world address seeded — 1 default address for demo producer.");

  // ---------------------------------------------------------------------------
  // Notification — standalone welcome-history notification for the demo
  // producer. Deliberately no ORDER_CREATED/SUBORDER_STATUS_CHANGED rows
  // since no real Order/SubOrder exists yet.
  // ---------------------------------------------------------------------------
  await prisma.notification.upsert({
    where: { id: "seed-demo-producer-notification-welcome" },
    update: {},
    create: {
      id: "seed-demo-producer-notification-welcome",
      userId: demoProducerUser.id,
      type: "ACCOUNT_ACTIVATED",
      title: "Cuenta activada",
      body: "Tu cuenta de productor ha sido activada.",
      read: true,
    },
  });

  console.log("Demo world notification seeded — 1 welcome notification for demo producer.");

  await seedProductImages(demoProducer.id, backgroundProducer.id);

  console.log("Demo world seed complete.");
}

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

  // ---------------------------------------------------------------------------
  // Seed demo/guest-environment world data (WU4) — gated, see seedDemoWorld().
  // ---------------------------------------------------------------------------
  await seedDemoWorld();
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
