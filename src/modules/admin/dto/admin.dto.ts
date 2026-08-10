/**
 * Admin catalog DTOs — Zod schemas for `/admin/*` request validation.
 *
 * All DTOs use `strictObject()` to enforce the project-wide strict DTO
 * policy (rejects unknown keys with VALIDATION_FAILED 422 via the global
 * errorMap).
 *
 * Spec references:
 *   admin-catalog §"Moderation queue and detail"
 *   admin-catalog §"Reversible audited moderation"
 *   admin-catalog §"Category administration"
 *   design — Interfaces / Contracts
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// Moderation queue query
// ---------------------------------------------------------------------------

/** ModerationStatus enum — exact wire strings from Prisma schema. */
export const ModerationStatusSchema = z.enum(["OK", "REPORTED", "REMOVED"]);

/**
 * Query parameters for GET /admin/products.
 *
 * Spec: admin-catalog §"Reported queue is filtered".
 */
export const ModerationQueueQuerySchema = strictObject({
  moderationStatus: ModerationStatusSchema,
});

export type ModerationQueueQuery = z.infer<typeof ModerationQueueQuerySchema>;

// ---------------------------------------------------------------------------
// Moderation transition body
// ---------------------------------------------------------------------------

/** Moderation actions accepted by PATCH /admin/products/:id/moderation. */
export const ModerationActionSchema = z.enum(["remove", "dismiss", "restore"]);

/**
 * Body for PATCH /admin/products/:id/moderation.
 *
 * Spec: admin-catalog §"Reversible audited moderation".
 */
export const ModerationBodySchema = strictObject({
  action: ModerationActionSchema,
  reason: z.string().trim().min(1, "reason must not be empty"),
});

export type ModerationBody = z.infer<typeof ModerationBodySchema>;

// ---------------------------------------------------------------------------
// Category admin bodies
// ---------------------------------------------------------------------------

const categoryNameSchema = z.string().trim().min(1).max(120);
const categoryDescriptionSchema = z.string().trim().min(1).max(1000);

/**
 * Body for POST /admin/categories.
 *
 * Forbidden fields (server-generated): id, slug, isActive, createdAt, updatedAt.
 * `slug` is intentionally absent — it is always derived from `name` at the
 * service layer (design — Decision "Mutable vs stable category slug").
 *
 * Spec: admin-catalog §"Category lifecycle succeeds".
 */
export const CreateCategoryBodySchema = strictObject({
  name: categoryNameSchema,
  description: categoryDescriptionSchema.optional(),
});

export type CreateCategoryBody = z.infer<typeof CreateCategoryBodySchema>;

/**
 * Body for PATCH /admin/categories/:id.
 *
 * All fields optional for partial updates. `slug` is NEVER accepted — PATCH
 * cannot derive a new slug (design — Decision "Mutable vs stable category
 * slug"). `isActive: true` is the restore path for a deactivated category.
 *
 * Spec: admin-catalog §"Category administration".
 */
export const UpdateCategoryBodySchema = strictObject({
  name: categoryNameSchema.optional(),
  description: categoryDescriptionSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBodySchema>;
