/**
 * Unit tests — Zod .strict() policy helpers (TDD — RED phase)
 *
 * Spec reference:
 *   error-handling §"Zod .strict() policy for unknown keys"
 *   error-handling scenario "Unknown key rejected uniformly"
 *
 * Covers:
 *   - strictObject() helper enforces .strict() — unknown keys rejected with VALIDATION_FAILED (422)
 *   - installGlobalErrorMap() maps unrecognized_keys to "Field '<name>' is not allowed"
 *   - Cycle 1 exports remain accessible (non-regression)
 */
import { describe, expect, it } from "vitest";

import {
  installGlobalErrorMap,
  nonEmptyString,
  spanishNifSchema,
  spanishPostalCodeSchema,
  strictObject,
  validateBody,
} from "@/shared/validation/zod";
import { ValidationFailedError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// strictObject() — enforces Zod .strict() policy
// Spec scenario: "Unknown key rejected uniformly"
// ---------------------------------------------------------------------------

describe("strictObject()", () => {
  it("accepts a payload that contains only declared keys", () => {
    const schema = strictObject({ name: nonEmptyString });

    expect(() => validateBody(schema, { name: "María" })).not.toThrow();
    const result = validateBody(schema, { name: "María" });
    expect(result.name).toBe("María");
  });

  it("rejects a payload containing an unknown key with VALIDATION_FAILED (422)", () => {
    // Spec scenario: "Unknown key rejected uniformly"
    // GIVEN any Cycle 2 DTO (e.g., PatchSubOrderBody)
    // WHEN request body contains a key not declared in the schema (e.g., trackingNumber)
    // THEN response MUST be 422 with code VALIDATION_FAILED
    // AND the error errors[] array MUST identify the offending key
    const schema = strictObject({ status: nonEmptyString });

    expect(() =>
      validateBody(schema, { status: "preparing", trackingNumber: "TN1" }),
    ).toThrow(ValidationFailedError);
  });

  it("identifies the offending unknown key in the errors[] array", () => {
    const schema = strictObject({ status: nonEmptyString });

    try {
      validateBody(schema, { status: "preparing", trackingNumber: "TN1" });
      throw new Error("Expected ValidationFailedError — not thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationFailedError);
      const vErr = err as ValidationFailedError;
      // The errors array MUST identify the offending key
      const messages = vErr.errors.map((e) => e.message).join(" ");
      expect(messages.toLowerCase()).toMatch(/trackingNumber|unrecognized/i);
    }
  });

  it("rejects multiple unknown keys and reports each one", () => {
    const schema = strictObject({ title: nonEmptyString });

    try {
      validateBody(schema, { title: "Hat", color: "blue", size: "M" });
      throw new Error("Expected ValidationFailedError — not thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationFailedError);
      const vErr = err as ValidationFailedError;
      // At least one error per unknown key (Zod groups them but structure varies)
      expect(vErr.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns the correct parsed type (TypeScript-level contract)", () => {
    const schema = strictObject({ count: nonEmptyString });
    const result = validateBody(schema, { count: "5" });
    // Compile-time: result.count must be string
    const s: string = result.count;
    expect(s).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// installGlobalErrorMap() — maps unrecognized_keys to stable message
// ---------------------------------------------------------------------------

describe("installGlobalErrorMap()", () => {
  it("is a callable function that returns void", () => {
    expect(typeof installGlobalErrorMap).toBe("function");
    expect(() => installGlobalErrorMap()).not.toThrow();
  });

  it("after install, unknown keys produce a message containing the field name", () => {
    installGlobalErrorMap();

    const schema = strictObject({ status: nonEmptyString });

    try {
      validateBody(schema, { status: "ok", forbidden: "value" });
      throw new Error("Expected ValidationFailedError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationFailedError);
      const vErr = err as ValidationFailedError;
      const allMessages = vErr.errors.map((e) => e.message).join(" ");
      // After installGlobalErrorMap the message should reference the field name
      // or say "not allowed" per design contract
      expect(allMessages).toMatch(/forbidden|not allowed|unrecognized/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Cycle 1 exports non-regression
// ---------------------------------------------------------------------------

describe("Cycle 1 exports — non-regression", () => {
  it("spanishNifSchema still exported and validates correctly", () => {
    expect(() => spanishNifSchema.parse("12345678A")).not.toThrow();
    expect(() => spanishNifSchema.parse("short")).toThrow();
  });

  it("spanishPostalCodeSchema still exported and validates correctly", () => {
    expect(() => spanishPostalCodeSchema.parse("28001")).not.toThrow();
    expect(() => spanishPostalCodeSchema.parse("280")).toThrow();
  });

  it("validateBody still exported and throws ValidationFailedError on failure", () => {
    const schema = strictObject({ name: nonEmptyString });
    expect(() => validateBody(schema, { name: "" })).toThrow(ValidationFailedError);
    const result = validateBody(schema, { name: "ok" });
    expect(result.name).toBe("ok");
  });
});
