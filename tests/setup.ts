/**
 * Global test setup — Cycle 2 bootstrap.
 *
 * Registered via vitest.config.ts `setupFiles` so this runs once
 * per test file, before any test in the suite.
 *
 * Responsibilities:
 *   1. Mock AWS SDK modules globally — every test file is protected from
 *      accidental real S3 calls (design §Testing Strategy "S3 mock leakage").
 *   2. Install the global Zod error map so `unrecognized_keys` messages
 *      are stable across every test that validates Zod schemas.
 *
 * Spec reference:
 *   product-images §"Test hygiene — mock the SDK"
 *   error-handling §"Zod .strict() policy for unknown keys"
 */
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// 1. Global AWS SDK mocks — prevent real S3 calls from any test file.
//    The actual implementations are provided per-test via mockResolvedValue.
// ---------------------------------------------------------------------------
vi.mock("@aws-sdk/client-s3", () => {
  return {
    S3Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
    HeadObjectCommand: vi.fn(),
    PutObjectCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => {
  return {
    getSignedUrl: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// 2. Install the global Zod error map so error messages are consistent in
//    every test file. Static import — no circular dependency exists between
//    the setup file and the validation module.
// ---------------------------------------------------------------------------
import { installGlobalErrorMap } from "@/shared/validation/zod";

installGlobalErrorMap();
