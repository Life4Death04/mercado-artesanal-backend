/**
 * Products DTOs — Zod schemas for request body validation.
 *
 * All Cycle 2 DTOs use `strictObject()` from shared validation to enforce
 * the strict DTO policy. `strictObject(shape)` calls `z.object(shape).strict()`
 * internally, so unknown keys are rejected with VALIDATION_FAILED (422) and the
 * global errorMap message "Field '<name>' is not allowed" (installGlobalErrorMap).
 *
 * REFACTOR note: `.strict()` is already enforced via `strictObject()` — no additional
 * per-DTO `.strict()` calls are needed. The REFACTOR phase verified this and found
 * no delta was required.
 *
 * Forbidden fields guarded by strict policy examples:
 *   CreateProduct — `moderationStatus`, `producerId`, `deletedAt` (mass-assignment prevention)
 *   UpdateProduct — `moderationStatus`, `reportedAt`, `reportReason` (moderation is internal)
 *   ReportProduct — `moderationStatus` (only `reason` is accepted)
 *
 * Spec references:
 *   product-catalog §"Product entity" — field types and constraints
 *   product-taxonomy scenario "Create product with unknown categoryId rejected" — enforced in service
 *   error-handling §"Zod .strict() policy for unknown keys" (Cycle 2)
 *   design — Architecture Decision #1 (strictObject project-wide)
 */
import { z } from "zod";

import { nonEmptyString, strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// Create product
// ---------------------------------------------------------------------------

export const CreateProductSchema = strictObject({
  categoryId: nonEmptyString,
  name: nonEmptyString,
  description: nonEmptyString,
  price: z.number().positive("Price must be greater than 0"),
  stock: z.number().int().min(0, "Stock must be >= 0").optional(),
  lowStockThreshold: z.number().int().min(0, "Low stock threshold must be >= 0").optional(),
  ingredients: z.string().nullable().optional(),
  allergens: z.array(z.string()).optional(),
  weight: z.number().int().positive().nullable().optional(),
  presentation: z.string().nullable().optional(),
});

export type CreateProductBody = z.infer<typeof CreateProductSchema>;

// ---------------------------------------------------------------------------
// Update product (PATCH — all fields optional)
// ---------------------------------------------------------------------------

export const UpdateProductSchema = strictObject({
  name: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
  price: z.number().positive("Price must be greater than 0").optional(),
  stock: z.number().int().min(0, "Stock must be >= 0").optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  ingredients: z.string().nullable().optional(),
  allergens: z.array(z.string()).optional(),
  weight: z.number().int().positive().nullable().optional(),
  presentation: z.string().nullable().optional(),
});

export type UpdateProductBody = z.infer<typeof UpdateProductSchema>;

// ---------------------------------------------------------------------------
// Report product
// ---------------------------------------------------------------------------

export const ReportProductSchema = strictObject({
  reason: nonEmptyString.max(500, "Reason must be <= 500 characters"),
});

export type ReportProductBody = z.infer<typeof ReportProductSchema>;

// ---------------------------------------------------------------------------
// Public product list query (public-catalog capability — unauthenticated)
// ---------------------------------------------------------------------------

/**
 * Query params for `GET /api/v1/products` (public, unauthenticated).
 *
 * `sort` values are `asc`/`desc` — matching spec public-catalog §"PUB-R1"
 * exact scenario `GET /api/v1/products?sort=asc`, ordering by price.
 *
 * Spec: public-catalog §"PUB-R1 — Public product list".
 */
export const ListPublicProductsQuerySchema = strictObject({
  categoryId: nonEmptyString.optional(),
  available: z.coerce.boolean().optional(),
  sort: z.enum(["asc", "desc"]).optional(),
});

export type ListPublicProductsQuery = z.infer<typeof ListPublicProductsQuerySchema>;
