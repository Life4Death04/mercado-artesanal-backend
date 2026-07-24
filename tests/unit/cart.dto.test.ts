/**
 * Unit tests — cart.dto (cycle-3/cart, PR #1 TDD).
 *
 * Strategy: import Zod schemas directly, call .safeParse, assert success/failure.
 * No mocks required — pure Zod validation tests.
 *
 * Tasks covered: WU1-T1 (DTO/error tests green; npm run typecheck; npm run lint)
 *
 * Scenarios covered (spec §R3 request DTOs, §R4 PATCH DTO):
 *   [D1] AddItemSchema — valid body passes
 *   [D2] AddItemSchema — missing productId rejected
 *   [D3] AddItemSchema — quantity < 1 rejected
 *   [D4] AddItemSchema — quantity = 0 rejected
 *   [D5] AddItemSchema — unknown keys rejected (strictObject policy)
 *   [D6] UpdateItemSchema — valid body passes
 *   [D7] UpdateItemSchema — quantity < 1 rejected
 *   [D8] UpdateItemSchema — unknown keys rejected (strictObject policy)
 *
 * Spec references:
 *   cart §"Request DTOs" — productId: string (cuid), quantity: int min 1
 *   cart §D5 (Zod → 422 VALIDATION_FAILED via errorMiddleware)
 *   design — strictObject from @/shared/validation/zod (Cycle 2 policy)
 */
import { describe, expect, it } from "vitest";

import { AddItemSchema, UpdateItemSchema } from "@/modules/cart/dto/cart.dto";

// ---------------------------------------------------------------------------
// [D1-D5] AddItemSchema
// ---------------------------------------------------------------------------

describe("AddItemSchema", () => {
  it("[D1] valid body passes", () => {
    const result = AddItemSchema.safeParse({ productId: "cjld2cyuq0000t3rmniod1foy", quantity: 2 });
    expect(result.success).toBe(true);
  });

  it("[D2] missing productId is rejected", () => {
    const result = AddItemSchema.safeParse({ quantity: 1 });
    expect(result.success).toBe(false);
  });

  it("[D3] quantity < 1 is rejected (quantity = -1)", () => {
    const result = AddItemSchema.safeParse({ productId: "cjld2cyuq0000t3rmniod1foy", quantity: -1 });
    expect(result.success).toBe(false);
  });

  it("[D4] quantity = 0 is rejected", () => {
    const result = AddItemSchema.safeParse({ productId: "cjld2cyuq0000t3rmniod1foy", quantity: 0 });
    expect(result.success).toBe(false);
  });

  it("[D5] unknown keys are rejected (strictObject policy)", () => {
    const result = AddItemSchema.safeParse({
      productId: "cjld2cyuq0000t3rmniod1foy",
      quantity: 1,
      extraField: "injected",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [D6-D8] UpdateItemSchema
// ---------------------------------------------------------------------------

describe("UpdateItemSchema", () => {
  it("[D6] valid body passes", () => {
    const result = UpdateItemSchema.safeParse({ quantity: 3 });
    expect(result.success).toBe(true);
  });

  it("[D7] quantity < 1 is rejected (quantity = 0)", () => {
    const result = UpdateItemSchema.safeParse({ quantity: 0 });
    expect(result.success).toBe(false);
  });

  it("[D8] unknown keys are rejected (strictObject policy)", () => {
    const result = UpdateItemSchema.safeParse({ quantity: 1, forbidden: "x" });
    expect(result.success).toBe(false);
  });
});
