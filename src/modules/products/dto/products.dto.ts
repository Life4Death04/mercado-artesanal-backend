/**
 * Products DTOs — Zod schemas for request body validation.
 *
 * All Cycle 2 DTOs use `strictObject()` from shared validation to enforce
 * the strict DTO policy (rejects unknown keys with VALIDATION_FAILED 422).
 *
 * Spec references:
 *   product-catalog §"Product entity" — field types and constraints
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
