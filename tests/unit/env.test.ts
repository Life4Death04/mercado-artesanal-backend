/**
 * Unit tests — env schema validation for S3_PUBLIC_BASE_URL (TDD — RED → GREEN)
 *
 * Strategy: test the Zod schema parsing function directly (not the singleton `env`).
 * We export the schema (or a parse helper) from env.ts so we can exercise all
 * branches without touching process.env or the module-level singleton.
 *
 * Spec reference (product-images, amended):
 *   §"S3_PUBLIC_BASE_URL is a required environment variable"
 *
 * Scenarios:
 *   1. Missing S3_PUBLIC_BASE_URL → fail boot (ZodError)
 *   2. Empty string S3_PUBLIC_BASE_URL → fail boot (ZodError)
 *   3. Malformed (non-URL) value → fail boot (ZodError)
 *   4. NODE_ENV=production + http:// URL → fail boot (ZodError — HTTPS required in prod)
 *   5. NODE_ENV=development + http:// URL → pass, no throw
 *   6. NODE_ENV=test + http:// URL → pass, no throw (non-prod also permits http)
 *   7. NODE_ENV=production + https:// URL → pass
 *   8. NODE_ENV=development + https:// URL → pass
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEnv } from "@/shared/utils/env";

// ---------------------------------------------------------------------------
// Minimal valid base input — all required fields that already existed.
// We extend this per scenario to isolate S3_PUBLIC_BASE_URL behavior.
// ---------------------------------------------------------------------------
const BASE_VALID = {
  NODE_ENV: "test" as const,
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/mercado",
  AUTH0_DOMAIN: "test.eu.auth0.com",
  AUTH0_AUDIENCE: "https://api.test.example",
  LOG_LEVEL: "error" as const,
  CORS_ORIGIN: "*",
  TRUST_PROXY: "loopback",
  // Required after Cycle 5 payments WU1 (STRIPE_SECRET_KEY added to env.ts).
  STRIPE_SECRET_KEY: "sk_test_dummy_for_env_test",
  // Required after Cycle 5 payments WU2 (STRIPE_WEBHOOK_SECRET added to env.ts).
  STRIPE_WEBHOOK_SECRET: "whsec_dummy_for_env_test",
  // Required after admin-database-backups Phase 1 (env.ts fail-fast on
  // missing/relative). See dedicated "backup config" scenarios below for the
  // fail-fast coverage of these four values.
  BACKUP_ARTIFACT_DIR: "/var/backups/mercado",
  PG_DUMP_PATH: "/usr/lib/postgresql/16/bin/pg_dump",
  PG_RESTORE_PATH: "/usr/lib/postgresql/16/bin/pg_restore",
  BACKUP_OPERATION_TIMEOUT_MS: "300000",
};

describe("network boundary config", () => {
  it("parses multiple explicit CORS origins and trusted proxy ranges", () => {
    const result = parseEnv({
      ...BASE_VALID,
      S3_PUBLIC_BASE_URL: "https://cdn.example.com",
      CORS_ORIGIN: "http://localhost:5173, https://admin.example.com",
      TRUST_PROXY: "loopback,172.20.0.5,10.20.0.0/16",
    });

    expect(result.CORS_ORIGIN).toEqual([
      "http://localhost:5173",
      "https://admin.example.com",
    ]);
    expect(result.TRUST_PROXY).toEqual(["loopback", "172.20.0.5", "10.20.0.0/16"]);
  });

  it.each(["https://frontend.example.com/path", "frontend.example.com", "*,https://frontend.example.com"])(
    "rejects invalid CORS allow-list value %s",
    (CORS_ORIGIN) => {
      expect(() =>
        parseEnv({ ...BASE_VALID, S3_PUBLIC_BASE_URL: "https://cdn.example.com", CORS_ORIGIN }),
      ).toThrow();
    },
  );

  it("rejects wildcard and HTTP origins in production", () => {
    for (const CORS_ORIGIN of ["*", "http://frontend.example.com"]) {
      expect(() =>
        parseEnv({
          ...BASE_VALID,
          NODE_ENV: "production",
          S3_PUBLIC_BASE_URL: "https://cdn.example.com",
          CORS_ORIGIN,
        }),
      ).toThrow();
    }
  });

  it.each(["true", "1", "nginx", "0.0.0.0/0", "10.0.0.0/33"])(
    "rejects unsafe or malformed proxy trust value %s",
    (TRUST_PROXY) => {
      expect(() =>
        parseEnv({ ...BASE_VALID, S3_PUBLIC_BASE_URL: "https://cdn.example.com", TRUST_PROXY }),
      ).toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 1 — Missing S3_PUBLIC_BASE_URL prevents boot
// Spec §"Missing env var prevents boot"
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: missing", () => {
  it("throws ZodError when S3_PUBLIC_BASE_URL is absent", () => {
    const input = { ...BASE_VALID }; // no S3_PUBLIC_BASE_URL
    expect(() => parseEnv(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Empty string prevents boot
// Spec §"Empty env var prevents boot"
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: empty string", () => {
  it("throws ZodError when S3_PUBLIC_BASE_URL is an empty string", () => {
    const input = { ...BASE_VALID, S3_PUBLIC_BASE_URL: "" };
    expect(() => parseEnv(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Malformed (non-URL) value prevents boot
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: malformed URL", () => {
  it("throws ZodError when S3_PUBLIC_BASE_URL is not a valid URL", () => {
    const input = { ...BASE_VALID, S3_PUBLIC_BASE_URL: "not-a-url" };
    expect(() => parseEnv(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — production + http:// → fail-closed
// Spec §"Non-HTTPS URL prevents boot in production"
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: http:// in production", () => {
  it("throws when NODE_ENV=production and S3_PUBLIC_BASE_URL uses http://", () => {
    const input = {
      ...BASE_VALID,
      NODE_ENV: "production" as const,
      S3_PUBLIC_BASE_URL: "http://insecure.example.com",
    };
    expect(() => parseEnv(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — development + http:// → pass (MinIO / LocalStack)
// Spec §"Non-HTTPS URL accepted outside production"
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: http:// in development", () => {
  it("does NOT throw when NODE_ENV=development and S3_PUBLIC_BASE_URL uses http://", () => {
    const input = {
      ...BASE_VALID,
      NODE_ENV: "development" as const,
      S3_PUBLIC_BASE_URL: "http://localhost:9000",
    };
    const result = parseEnv(input);
    expect(result.S3_PUBLIC_BASE_URL).toBe("http://localhost:9000");
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — test + http:// → pass (same non-prod rule as development)
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: http:// in test environment", () => {
  it("does NOT throw when NODE_ENV=test and S3_PUBLIC_BASE_URL uses http://", () => {
    const input = {
      ...BASE_VALID,
      NODE_ENV: "test" as const,
      S3_PUBLIC_BASE_URL: "http://localhost:9000",
    };
    const result = parseEnv(input);
    expect(result.S3_PUBLIC_BASE_URL).toBe("http://localhost:9000");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — production + https:// → pass
// Spec §"HTTPS URL accepted in any environment"
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: https:// in production", () => {
  it("does NOT throw when NODE_ENV=production and S3_PUBLIC_BASE_URL uses https://", () => {
    const input = {
      ...BASE_VALID,
      NODE_ENV: "production" as const,
      S3_PUBLIC_BASE_URL: "https://cdn.example.com",
      CORS_ORIGIN: "https://frontend.example.com",
    };
    const result = parseEnv(input);
    expect(result.S3_PUBLIC_BASE_URL).toBe("https://cdn.example.com");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — development + https:// → pass
// Spec §"HTTPS URL accepted in any environment"
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: https:// in development", () => {
  it("does NOT throw when NODE_ENV=development and S3_PUBLIC_BASE_URL uses https://", () => {
    const input = {
      ...BASE_VALID,
      NODE_ENV: "development" as const,
      S3_PUBLIC_BASE_URL: "https://cdn.example.com",
    };
    const result = parseEnv(input);
    expect(result.S3_PUBLIC_BASE_URL).toBe("https://cdn.example.com");
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — non-prod + http:// → console.warn emitted (downgrade notice)
// Spec §"Non-HTTPS URL accepted outside production" + warn requirement:
//   The app MUST emit a warn log when S3_PUBLIC_BASE_URL uses http:// in a
//   non-production environment, so the configuration is not silently ignored.
// ---------------------------------------------------------------------------
describe("S3_PUBLIC_BASE_URL: warn log on non-prod http://", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("calls console.warn with a message mentioning S3_PUBLIC_BASE_URL and http:// when NODE_ENV=development", () => {
    const input = {
      ...BASE_VALID,
      NODE_ENV: "development" as const,
      S3_PUBLIC_BASE_URL: "http://cdn.example.com",
    };

    parseEnv(input);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("S3_PUBLIC_BASE_URL"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("http://"));
  });

  // Triangulation: https:// must NOT trigger the warn
  it("does NOT call console.warn when NODE_ENV=development and S3_PUBLIC_BASE_URL uses https://", () => {
    const input = {
      ...BASE_VALID,
      NODE_ENV: "development" as const,
      S3_PUBLIC_BASE_URL: "https://cdn.example.com",
    };

    parseEnv(input);

    // Warn must not have been called for this config (no downgrade, no noise)
    const callsWithS3Mention = warnSpy.mock.calls.filter((args) =>
      args.some(
        (a) => typeof a === "string" && a.includes("S3_PUBLIC_BASE_URL"),
      ),
    );
    expect(callsWithS3Mention).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — admin-database-backups config: fail-fast on missing/relative
// Spec/design: admin-database-backups "boot fails closed" (BACKUP_ARTIFACT_DIR,
// PG_DUMP_PATH, PG_RESTORE_PATH, BACKUP_OPERATION_TIMEOUT_MS).
// ---------------------------------------------------------------------------
const BACKUP_VALID = {
  ...BASE_VALID,
  S3_PUBLIC_BASE_URL: "https://cdn.example.com",
};

describe("backup config: valid absolute paths and positive timeout", () => {
  it("does NOT throw when all four backup vars are valid", () => {
    expect(() => parseEnv(BACKUP_VALID)).not.toThrow();
  });
});

describe.each([
  ["BACKUP_ARTIFACT_DIR", undefined],
  ["BACKUP_ARTIFACT_DIR", "relative/backups"],
  ["PG_DUMP_PATH", undefined],
  ["PG_DUMP_PATH", "relative/pg_dump"],
  ["PG_RESTORE_PATH", undefined],
  ["PG_RESTORE_PATH", "relative/pg_restore"],
  ["BACKUP_OPERATION_TIMEOUT_MS", undefined],
  ["BACKUP_OPERATION_TIMEOUT_MS", "not-a-number"],
  ["BACKUP_OPERATION_TIMEOUT_MS", "-1"],
] as const)("backup config: %s = %p fails boot", (key, value) => {
  it("throws ZodError", () => {
    const input: Record<string, string | undefined> = { ...BACKUP_VALID, [key]: value };
    expect(() => parseEnv(input)).toThrow();
  });
});
