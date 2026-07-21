/**
 * Unit tests — toImageUrl slash-normalization (TDD — RED → GREEN)
 *
 * Strategy: mock the `@/shared/utils/env` module so each test case can
 * control `S3_PUBLIC_BASE_URL` independently without touching process.env
 * or the module-level singleton.
 *
 * Spec reference (product-images):
 *   §"URL derivation from s3Key"
 *
 * Scenarios:
 *   1. No trailing slash on base, no leading slash on key → single slash inserted.
 *   2. Trailing slash on base, no leading slash on key → trailing slash stripped, single slash.
 *   3. No trailing slash on base, leading slash on key → leading slash stripped, single slash.
 *   4. Trailing slash on base AND leading slash on key → both stripped, single slash.
 *   5. Nested multi-segment key path works correctly.
 *   6. Spec example: "https://cdn.example.com" + "producers/p1/products/prod1/img/abc"
 *      → "https://cdn.example.com/producers/p1/products/prod1/img/abc"
 *
 * What is NOT tested here:
 *   - HTTPS enforcement — that lives in the env schema (env.test.ts).
 *   - Missing/invalid S3_PUBLIC_BASE_URL — validated at boot by the Zod schema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the env module BEFORE importing the utility.
// vi.mock is hoisted by vitest to the top of the module so the factory
// runs before any import resolution occurs.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/env", () => {
  return {
    env: {
      S3_PUBLIC_BASE_URL: "https://cdn.example.com",
    },
  };
});

import { env } from "@/shared/utils/env";
import { toImageUrl } from "@/shared/utils/image-url";

// ---------------------------------------------------------------------------
// Helper: set S3_PUBLIC_BASE_URL on the mocked env for a specific test
// ---------------------------------------------------------------------------
function setBase(url: string) {
  (env as { S3_PUBLIC_BASE_URL: string }).S3_PUBLIC_BASE_URL = url;
}

// ---------------------------------------------------------------------------
// Reset base to a known state before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  setBase("https://cdn.example.com");
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario 1 — No trailing slash on base, no leading slash on key
// Spec §"URL derivation from s3Key": single slash MUST be inserted between them.
// ---------------------------------------------------------------------------
describe("toImageUrl — no trailing slash on base, no leading slash on key", () => {
  it("inserts a single slash between base and key", () => {
    setBase("https://cdn.example.com");

    const result = toImageUrl("img/abc");

    expect(result).toBe("https://cdn.example.com/img/abc");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Trailing slash on base URL normalized
// Spec §"Trailing slash on base URL normalized"
// ---------------------------------------------------------------------------
describe("toImageUrl — trailing slash on base URL is stripped", () => {
  it("strips trailing slash from base before joining", () => {
    setBase("https://cdn.example.com/");

    const result = toImageUrl("img/abc");

    expect(result).toBe("https://cdn.example.com/img/abc");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Leading slash on s3Key normalized
// Spec §"Leading slash on s3Key normalized"
// ---------------------------------------------------------------------------
describe("toImageUrl — leading slash on s3Key is stripped", () => {
  it("strips leading slash from key before joining", () => {
    setBase("https://cdn.example.com");

    const result = toImageUrl("/img/abc");

    expect(result).toBe("https://cdn.example.com/img/abc");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Both trailing slash on base AND leading slash on key
// Spec: MUST NOT produce a double slash.
// ---------------------------------------------------------------------------
describe("toImageUrl — both trailing slash on base AND leading slash on key", () => {
  it("produces exactly one slash between base and key (no double slash)", () => {
    setBase("https://cdn.example.com/");

    const result = toImageUrl("/img/abc");

    expect(result).toBe("https://cdn.example.com/img/abc");
    expect(result).not.toContain("//img");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Nested multi-segment key path
// Ensures the function does not alter internal slashes in the key.
// ---------------------------------------------------------------------------
describe("toImageUrl — nested multi-segment key path preserved", () => {
  it("preserves internal path separators in a nested key", () => {
    setBase("https://cdn.example.com");

    const result = toImageUrl("producers/p1/products/prod1/img/abc.jpg");

    expect(result).toBe(
      "https://cdn.example.com/producers/p1/products/prod1/img/abc.jpg",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Spec example verbatim
// Spec §"Base URL and key concatenated with single slash":
//   S3_PUBLIC_BASE_URL = "https://cdn.example.com"
//   s3Key = "producers/p1/products/prod1/img/abc"
//   url MUST equal "https://cdn.example.com/producers/p1/products/prod1/img/abc"
// ---------------------------------------------------------------------------
describe("toImageUrl — spec example: base + key with single slash", () => {
  it("matches the exact output from the spec scenario", () => {
    setBase("https://cdn.example.com");

    const result = toImageUrl("producers/p1/products/prod1/img/abc");

    expect(result).toBe(
      "https://cdn.example.com/producers/p1/products/prod1/img/abc",
    );
  });
});
