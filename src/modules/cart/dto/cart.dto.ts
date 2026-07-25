/**
 * Cart DTO schemas — Zod request validation for cart endpoints.
 *
 * All schemas use strictObject (z.object().strict()) per Cycle 2 policy:
 * unknown keys are rejected with VALIDATION_FAILED (422).
 *
 * Spec references:
 *   cart §"Request DTOs" — productId: non-empty string, quantity: int min 1
 *   cart §D5 — Zod → 422 VALIDATION_FAILED via errorMiddleware
 *   design — strictObject from @/shared/validation/zod (Cycle 2 policy)
 *
 * ID validation policy: use `z.string().min(1)` rather than `z.string().cuid()`
 * to avoid coupling the DTO to the current cuid1 format. Prisma may migrate
 * to cuid2 (ADR-008 leaves this open) and no other DTO in the repo uses
 * `.cuid()`. Existence and non-emptiness are the contract we validate here;
 * the service layer enforces existence and ownership.
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// POST /carrito/items
// ---------------------------------------------------------------------------

/**
 * Body schema for adding an item to the cart.
 *   productId — non-empty string identifying the product (required)
 *   quantity  — positive integer ≥ 1 (required)
 */
export const AddItemSchema = strictObject({
  productId: z.string().min(1, "productId is required"),
  quantity: z.number().int("quantity must be an integer").min(1, "quantity must be at least 1"),
});

export type AddItemBody = z.infer<typeof AddItemSchema>;

// ---------------------------------------------------------------------------
// PATCH /carrito/items/:itemId
// ---------------------------------------------------------------------------

/**
 * Body schema for updating the quantity of a cart item.
 *   quantity — positive integer ≥ 1 (required; replaces existing quantity)
 */
export const UpdateItemSchema = strictObject({
  quantity: z.number().int("quantity must be an integer").min(1, "quantity must be at least 1"),
});

export type UpdateItemBody = z.infer<typeof UpdateItemSchema>;
