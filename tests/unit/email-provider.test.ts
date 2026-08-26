/**
 * Unit tests — EmailProvider boundary (notifications Phase 2, TDD — RED → GREEN).
 *
 * Mirrors src/modules/payments/services/stripe.client.ts's no-DI pattern: an
 * `EmailProvider` interface + a module singleton selected once at import time
 * from `env.EMAIL_PROVIDER`, with default-param injection at call sites
 * (`provider: EmailProvider = emailProvider`).
 *
 * The `@aws-sdk/client-ses` SDK is globally mocked in tests/setup.ts (mirrors
 * the existing S3 mock) — no test in this suite makes, or can make, a real
 * AWS call. `createEmailProvider` is a pure factory (Extract-Before-Mock
 * rule) so provider selection is testable without reloading the `env`
 * module or mutating `process.env`.
 *
 * Spec reference: sdd/notifications/spec — domain "email-provider".
 * Design reference: sdd/notifications/design — "Provider: mirror StripeClient",
 *   "SES test isolation: global vi.mock('@aws-sdk/client-ses') in tests/setup.ts".
 */
import { SESClient } from "@aws-sdk/client-ses";
import { describe, expect, it, vi } from "vitest";

import {
  ConsoleEmailProvider,
  createEmailProvider,
  dispatchEmails,
  type EmailMessage,
  type EmailProvider,
} from "@/shared/email/email-provider";
import { SesEmailProvider } from "@/shared/email/ses-email-provider";
import { parseEnv } from "@/shared/utils/env";

// ---------------------------------------------------------------------------
// Minimal valid base env input — mirrors tests/unit/env.test.ts BASE_VALID.
// ---------------------------------------------------------------------------
const BASE_VALID_ENV = {
  NODE_ENV: "test" as const,
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/mercado",
  AUTH0_DOMAIN: "test.eu.auth0.com",
  AUTH0_AUDIENCE: "https://api.test.example",
  AUTH0_M2M_CLIENT_ID: "test-m2m-client",
  AUTH0_M2M_CLIENT_SECRET: "test-m2m-secret",
  AUTH0_APPLICATION_CLIENT_ID: "test-app-client",
  AUTH0_DATABASE_CONNECTION: "Username-Password-Authentication",
  AUTH0_REQUEST_TIMEOUT_MS: "5000",
  LOG_LEVEL: "error" as const,
  CORS_ORIGIN: "*",
  S3_PUBLIC_BASE_URL: "https://cdn.example.com",
  STRIPE_SECRET_KEY: "sk_test_dummy_for_env_test",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy_for_env_test",
  // Required after admin-database-backups Phase 1 (env.ts fail-fast).
  BACKUP_ARTIFACT_DIR: "/var/backups/mercado",
  PG_DUMP_PATH: "/usr/lib/postgresql/16/bin/pg_dump",
  PG_RESTORE_PATH: "/usr/lib/postgresql/16/bin/pg_restore",
  BACKUP_OPERATION_TIMEOUT_MS: "300000",
};

function fakeMessage(to: string): EmailMessage {
  return { to, subject: "Test subject", body: "Test body" };
}

// ---------------------------------------------------------------------------
// [U-MOCK] SDK mock guard — mirrors images.service.test.ts's S3Client guard.
// ---------------------------------------------------------------------------
describe("[U-MOCK] SDK mock guard — SESClient must be mocked", () => {
  it("SESClient constructor is a vi.fn() (global mock from tests/setup.ts is active)", () => {
    // If the global vi.mock("@aws-sdk/client-ses") in tests/setup.ts were
    // removed, SESClient would be the real class and this would fail.
    expect(vi.isMockFunction(SESClient)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [2.1] Console is the default provider — never constructs an SESClient
// ---------------------------------------------------------------------------
describe("Provider selection: console is the default", () => {
  it("createEmailProvider('console') returns a ConsoleEmailProvider and never touches SES", () => {
    vi.mocked(SESClient).mockClear();

    const provider = createEmailProvider("console");

    expect(provider).toBeInstanceOf(ConsoleEmailProvider);
    expect(SESClient).not.toHaveBeenCalled();
  });

  it("parseEnv defaults EMAIL_PROVIDER to 'console' when the var is omitted", () => {
    const result = parseEnv({ ...BASE_VALID_ENV });
    expect(result.EMAIL_PROVIDER).toBe("console");
  });
});

// ---------------------------------------------------------------------------
// [2.2] Invalid EMAIL_PROVIDER value fails parseEnv (startup rejection)
// ---------------------------------------------------------------------------
describe("Provider selection: invalid value rejected at startup", () => {
  it("throws when EMAIL_PROVIDER is not 'console' or 'ses'", () => {
    const input = { ...BASE_VALID_ENV, EMAIL_PROVIDER: "sendgrid" };
    expect(() => parseEnv(input)).toThrow();
  });

  // Triangulation: a valid non-default value must NOT throw.
  it("accepts 'ses' as a valid EMAIL_PROVIDER value", () => {
    const result = parseEnv({ ...BASE_VALID_ENV, EMAIL_PROVIDER: "ses" });
    expect(result.EMAIL_PROVIDER).toBe("ses");
  });
});

// ---------------------------------------------------------------------------
// Provider selection: 'ses' constructs a SesEmailProvider (via the mocked SDK)
// ---------------------------------------------------------------------------
describe("Provider selection: ses", () => {
  it("createEmailProvider('ses') returns a SesEmailProvider", () => {
    const provider = createEmailProvider("ses");
    expect(provider).toBeInstanceOf(SesEmailProvider);
  });
});

// ---------------------------------------------------------------------------
// [2.3] dispatchEmails swallows a per-message send rejection, never throws
// ---------------------------------------------------------------------------
describe("dispatchEmails: best-effort, non-blocking dispatch", () => {
  it("resolves without throwing when one message's send() rejects", async () => {
    const send = vi
      .fn<EmailProvider["send"]>()
      .mockRejectedValueOnce(new Error("SES throttled"))
      .mockResolvedValueOnce(undefined);
    const fakeProvider: EmailProvider = { send };

    await expect(
      dispatchEmails([fakeMessage("a@x.com"), fakeMessage("b@x.com")], fakeProvider),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
  });

  // Triangulation: every message is attempted even when an EARLIER one
  // rejects — a failure must not short-circuit sibling dispatches.
  it("dispatches every message even when every send() rejects (no short-circuit)", async () => {
    const send = vi.fn<EmailProvider["send"]>().mockRejectedValue(new Error("boom"));
    const fakeProvider: EmailProvider = { send };

    await dispatchEmails(
      [fakeMessage("a@x.com"), fakeMessage("b@x.com"), fakeMessage("c@x.com")],
      fakeProvider,
    );

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("uses the module singleton emailProvider by default when no provider arg is passed", async () => {
    // Mirrors StripeClient's default-param injection pattern. The real
    // singleton in the test env is a ConsoleEmailProvider (EMAIL_PROVIDER
    // defaults/mirrors to "console" in vitest.config.ts) — this must resolve
    // cleanly with zero AWS interaction.
    await expect(dispatchEmails([fakeMessage("a@x.com")])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ConsoleEmailProvider: logs, makes no external call
// ---------------------------------------------------------------------------
describe("ConsoleEmailProvider", () => {
  it("send() resolves without invoking the SES SDK", async () => {
    vi.mocked(SESClient).mockClear();
    const provider = new ConsoleEmailProvider();

    await expect(
      provider.send({ to: "user@example.com", subject: "Hi", body: "Hello" }),
    ).resolves.toBeUndefined();

    expect(SESClient).not.toHaveBeenCalled();
  });
});
