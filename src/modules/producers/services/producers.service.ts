/**
 * Producers service — private profile edit, soft-delete guard, and public projection.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as producersService from "@/modules/producers/services/producers.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma.* directly
 * per ADR-003 (architecture/repository-layer-policy).
 * NOTE: tasks.md line 100 references a `repositories/` folder, but ADR-003
 * (enforced in Slices 3–8) forbids it. design.md is the authoritative source.
 * Decision: follow design.md, no repositories/ layer.
 *
 * Key invariants:
 *   - patch: runs inside $transaction:
 *       1. findFirst guard (404 when not found — existence-scoped to non-deleted rows)
 *       2. if categorySlugs present: resolve slugs → validate all exist → deleteMany + createMany
 *       3. update scalar fields on the producer row
 *   - softDelete: runs inside $transaction:
 *       1. findFirst guard (404 when not found or already soft-deleted)
 *       2. subOrder.count non-terminal statuses (pending, preparing, sent)
 *       3. if count > 0 → ProducerHasActiveOrdersError (409)
 *          Reuse rationale: same error code (PRODUCER_HAS_ACTIVE_ORDERS) as delivery-modes delete
 *          guard — the spec only requires 409 without prescribing a new error code.
 *          See design §"Delivery-modes delete guard" and §"Errors" table.
 *       4. if count === 0 → producer.update({ deletedAt: now() })
 *   - findPublicById: direct query (no transaction needed — read-only):
 *       1. producer.findFirst({ where: { id, deletedAt: null } }) — soft-deleted → 404
 *       2. if null → NotFoundError (404)
 *       3. return redacted projection (omit nif, userId, addressLine1, addressLine2, addressPostalCode)
 *          PII-safety audit: nif and address PII columns never appear in PublicProducerProjection.
 *
 * Design references:
 *   design §"Transactions required": producers.patch (categorySlugs), producers.softDelete (guard + set deletedAt)
 *   design §"Delivery-modes delete guard": ProducerHasActiveOrdersError reuse pattern
 *   design §"Errors": ProducerHasActiveOrdersError (409, PRODUCER_HAS_ACTIVE_ORDERS)
 *   design ADR-003: no repositories/ layer
 *   spec producer-bootstrap §"Private profile edit endpoint"
 *   spec producer-bootstrap §"Public producer projection endpoint"
 *   spec producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
 */
import type { Producer, SubOrderStatus } from "@prisma/client";

import {
  NotFoundError,
  ProducerHasActiveOrdersError,
  UnknownCategoryError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type { PatchProducerBody } from "../dto/producers.dto";

// ---------------------------------------------------------------------------
// Non-terminal SubOrder statuses for the soft-delete guard
// Spec: producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
// Design: count SubOrder rows where status IN (pending, preparing, sent)
// Note: isTerminalStatus() from sub-orders.service is not imported here to avoid
// circular-ish coupling; we define the non-terminal set directly, which is the
// same source of truth as ALLOWED_TRANSITIONS keys in sub-orders.service.
// ---------------------------------------------------------------------------
const NON_TERMINAL_SUBORDER_STATUSES: SubOrderStatus[] = ["pending", "preparing", "sent"];

// ---------------------------------------------------------------------------
// Public projection type
// Spec: producer-bootstrap §"Public producer projection endpoint"
//   Returned: id, businessName, description, address.city, address.province,
//             address.country, categories: [{slug, name}], createdAt
//   Redacted: nif, userId, address.line1, address.line2, address.postalCode,
//             deletedAt, updatedAt
// ---------------------------------------------------------------------------

export interface PublicProducerProjection {
  id: string;
  businessName: string;
  description: string;
  address: {
    city: string;
    province: string;
    country: string;
  };
  categories: Array<{ slug: string; name: string }>;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

/**
 * Partially update an authenticated producer's profile.
 *
 * Runs inside `$transaction`:
 *   1. findFirst({ where: { id: producerId, deletedAt: null } }) — 404 when not found.
 *   2. If `categorySlugs` present:
 *       a. Resolve slugs → ProducerCategory rows.
 *       b. If any slug not found → UnknownCategoryError (422).
 *       c. deleteMany existing join rows for this producer.
 *       d. createMany new join rows.
 *   3. Update scalar fields on the producer row.
 *
 * Transaction rationale: category replacement (steps 2c–2d) + profile update (step 3)
 * must be atomic. Without a transaction, a concurrent patch could interleave and corrupt
 * the M-N join table.
 *
 * Spec: producer-bootstrap §"Private profile edit endpoint"
 * Spec scenario: "Partial update succeeds"
 * Spec scenario: "Unknown categorySlug rejected"
 */
export async function patch(
  producerId: string,
  input: PatchProducerBody,
): Promise<Producer> {
  return prisma.$transaction(async (tx) => {
    // Step 1: ownership + existence guard (deletedAt: null scopes to live rows only)
    const producer = await tx.producer.findFirst({
      where: { id: producerId, deletedAt: null },
    });

    if (!producer) {
      throw new NotFoundError("Producer not found");
    }

    // Step 2: category replacement (when categorySlugs is explicitly provided)
    if (input.categorySlugs !== undefined) {
      const uniqueSlugs = [...new Set(input.categorySlugs)];

      const categories = await tx.producerCategory.findMany({
        where: { slug: { in: uniqueSlugs } },
      });

      if (categories.length !== uniqueSlugs.length) {
        // Identify which slugs were not found for the error detail
        const foundSlugs = new Set(categories.map((c: { slug: string }) => c.slug));
        const missingSlugs = uniqueSlugs.filter((s) => !foundSlugs.has(s));
        throw new UnknownCategoryError(
          `Unknown category slug(s): ${missingSlugs.join(", ")}`,
        );
      }

      // Replace current M-N set atomically:
      // deleteMany removes all existing join rows; createMany inserts the new set.
      // Both run inside the same transaction — concurrent patch cannot interleave.
      await tx.producerCategoryOnProducer.deleteMany({ where: { producerId } });

      if (categories.length > 0) {
        await tx.producerCategoryOnProducer.createMany({
          data: categories.map((c: { id: string }) => ({
            producerId,
            categoryId: c.id,
          })),
        });
      }
    }

    // Step 3: build scalar update data from provided fields only (undefined → not included).
    // Using spread-conditional pattern keeps the data object free of undefined entries.
    const data = {
      ...(input.businessName !== undefined && { businessName: input.businessName }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.address?.line1 !== undefined && { addressLine1: input.address.line1 }),
      ...(input.address?.line2 !== undefined && { addressLine2: input.address.line2 }),
      ...(input.address?.city !== undefined && { addressCity: input.address.city }),
      ...(input.address?.postalCode !== undefined && { addressPostalCode: input.address.postalCode }),
      ...(input.address?.province !== undefined && { addressProvince: input.address.province }),
      ...(input.address?.country !== undefined && { addressCountry: input.address.country }),
    };

    // Always call update so updatedAt is refreshed (covers category-only patches too).
    return tx.producer.update({ where: { id: producerId }, data });
  });
}

// ---------------------------------------------------------------------------
// softDelete
// ---------------------------------------------------------------------------

/**
 * Soft-delete an authenticated producer.
 *
 * Runs inside `$transaction`:
 *   1. findFirst({ where: { id: producerId, deletedAt: null } }) — 404 when not found.
 *   2. Count SubOrders with non-terminal status (pending, preparing, sent).
 *   3. If count > 0 → ProducerHasActiveOrdersError (409, PRODUCER_HAS_ACTIVE_ORDERS).
 *   4. If count === 0 → producer.update({ deletedAt: now() }).
 *
 * Transaction rationale: count + update must be atomic. Without the transaction,
 * a concurrent SubOrder creation between count (step 2) and update (step 4) could
 * allow a soft-delete to proceed with live active SubOrders.
 *
 * Spec: producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
 * Spec scenario: "Delete blocked by non-terminal SubOrder"
 * Spec scenario: "Delete allowed when all SubOrders terminal"
 * Spec scenario: "Delete allowed when producer has no SubOrders"
 * Design §"Transactions required": producers.softDelete (guard + set deletedAt)
 */
export async function softDelete(producerId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Step 1: existence guard — 404 when not found
    const producer = await tx.producer.findFirst({
      where: { id: producerId, deletedAt: null },
    });

    if (!producer) {
      throw new NotFoundError("Producer not found");
    }

    // Step 2: count non-terminal SubOrders owned by this producer
    const activeCount = await tx.subOrder.count({
      where: {
        producerId,
        status: { in: NON_TERMINAL_SUBORDER_STATUSES },
      },
    });

    // Step 3: block soft-delete if non-terminal SubOrders exist.
    // Reuse ProducerHasActiveOrdersError (409, PRODUCER_HAS_ACTIVE_ORDERS) — the same
    // error class used by the delivery-modes delete guard. The spec only requires 409;
    // it does not prescribe a distinct error code for producer vs. delivery-mode guards.
    // See design §"Delivery-modes delete guard" and §"Errors" table.
    if (activeCount > 0) {
      throw new ProducerHasActiveOrdersError(
        "Cannot delete producer: it has non-terminal sub-orders",
      );
    }

    // Step 4: soft-delete the producer
    await tx.producer.update({
      where: { id: producerId },
      data: { deletedAt: new Date() },
    });
  });
}

// ---------------------------------------------------------------------------
// findPublicById
// ---------------------------------------------------------------------------

/**
 * Fetch a live producer by id and return a PII-redacted public projection.
 *
 * Filters `deletedAt: null` so soft-deleted producers appear as 404.
 * Uses `select` (not `include`) to request only the spec-approved columns from
 * Postgres — this is defense-in-depth: PII columns (nif, addressLine1, etc.)
 * never leave the DB layer, even if the projection builder were to break.
 *
 * Returned fields (spec: producer-bootstrap §"Public producer projection endpoint"):
 *   id, businessName, description, address.city, address.province,
 *   address.country, categories: [{slug, name}], createdAt
 *
 * Redacted fields (MUST NOT appear — enforced by select):
 *   nif, userId, addressLine1, addressLine2, addressPostalCode,
 *   deletedAt, updatedAt
 *
 * PII-safety audit:
 *   - nif: NOT in select → never reaches service layer
 *   - addressLine1/2: NOT in select → never reaches service layer
 *   - addressPostalCode: NOT in select → never reaches service layer
 *   - userId: NOT in select → never reaches service layer
 *
 * Spec scenario: "Public projection redacts PII"
 * Spec scenario: "Soft-deleted producer returns 404"
 */
export async function findPublicById(id: string): Promise<PublicProducerProjection> {
  const producer = await prisma.producer.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      businessName: true,
      description: true,
      addressCity: true,
      addressProvince: true,
      addressCountry: true,
      createdAt: true,
      // M-N join — select only slug + name from the ProducerCategory side
      categories: {
        select: {
          category: {
            select: { slug: true, name: true },
          },
        },
      },
    },
  });

  if (!producer) {
    throw new NotFoundError("Producer not found");
  }

  // Build the public projection shape — address fields are remapped to the
  // nested { city, province, country } structure the spec requires.
  return {
    id: producer.id,
    businessName: producer.businessName,
    description: producer.description,
    address: {
      city: producer.addressCity,
      province: producer.addressProvince,
      country: producer.addressCountry,
    },
    categories: producer.categories.map((pc) => ({
      slug: pc.category.slug,
      name: pc.category.name,
    })),
    createdAt: producer.createdAt,
  };
}
