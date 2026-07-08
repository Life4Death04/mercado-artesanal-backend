/**
 * Integration tests — structured-logging spec runtime coverage (Block B, PR#2 cleanup).
 *
 * Scenarios covered (HTTP layer via Supertest + injected logger):
 *   6. Correlation ID — request without X-Request-Id gets a response header
 *      matching UUID v4 regex (case-insensitive).
 *   7. Correlation ID — request with X-Request-Id: abc-123 produces an access
 *      log line whose parsed JSON has reqId: "abc-123".
 *   8. No request body in production logs — a POST request under
 *      NODE_ENV=production produces an access log JSON without a "body" field.
 *
 * Scope note:
 *   - DB-backed integration tests (health/ready 200 branch, producer-bootstrap
 *     seed verification) are EXPLICITLY deferred to Cycle 2 per:
 *       * vitest.config.ts:15 — "Tests that need a real DB spin up docker-compose.test.yml (Cycle 2+)."
 *       * tests/integration/health.test.ts:12-13 — "A dedicated DB-connected test suite
 *         (Cycle 2) will assert the 200 path."
 *   - This file intentionally does NOT import prisma or attempt any DB connection.
 *
 * Log capture strategy:
 *   createApp({ logger }) accepts an optional pino Logger instance.
 *   We build a logger backed by a Writable chunk accumulator and pass it to
 *   createApp so pino-http uses the same logger instance — every access log
 *   line is captured without spawning child processes or intercepting stdout.
 */
import { Writable } from "node:stream";

import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/app";
import { createLogger } from "@/shared/utils/logger";

// ---------------------------------------------------------------------------
// Shared capture infrastructure
// ---------------------------------------------------------------------------

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildCapture(): {
  dest: Writable;
  getLines: () => Promise<Record<string, unknown>[]>;
  reset: () => void;
} {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const getLines = (): Promise<Record<string, unknown>[]> =>
    new Promise((resolve) => {
      setImmediate(() => {
        const lines = chunks
          .join("")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        resolve(lines);
      });
    });
  const reset = (): void => {
    chunks.length = 0;
  };
  return { dest, getLines, reset };
}

// ---------------------------------------------------------------------------
// Scenario 6: Correlation ID — no incoming X-Request-Id
// ---------------------------------------------------------------------------

describe("Scenario 6 — correlation ID: no incoming X-Request-Id gets UUID v4 response header", () => {
  let request: ReturnType<typeof supertest>;
  let capture: ReturnType<typeof buildCapture>;

  beforeAll(() => {
    capture = buildCapture();
    const testLogger = createLogger({ env: "test", level: "trace", destination: capture.dest });
    const app = createApp({ logger: testLogger });
    request = supertest(app);
  });

  afterAll(() => {
    capture.dest.destroy();
  });

  it("response carries X-Request-Id matching UUID v4 AND access log has same reqId", async () => {
    capture.reset();
    const res = await request.get("/health");

    // --- Part 1: response header must be a UUID v4 ---
    const reqId = res.headers["x-request-id"] as string | undefined;
    expect(reqId).toBeDefined();
    expect(reqId).toMatch(UUID_V4_REGEX);

    // --- Part 2: the SAME UUID must appear in the access log as `reqId` ---
    // Give pino one extra tick to flush any buffered write after the HTTP
    // response has been sent.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lines = await capture.getLines();

    // At least one log line must carry a reqId field
    const lineWithReqId = lines.find((l) => "reqId" in l);
    expect(lineWithReqId).toBeDefined();

    // That reqId must equal the UUID echoed in the response header
    expect((lineWithReqId as { reqId: string }).reqId).toBe(reqId);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Correlation ID — incoming X-Request-Id is honored in logs
// ---------------------------------------------------------------------------

describe("Scenario 7 — correlation ID: incoming X-Request-Id propagates to access log reqId", () => {
  let request: ReturnType<typeof supertest>;
  let capture: ReturnType<typeof buildCapture>;

  beforeAll(() => {
    capture = buildCapture();
    const testLogger = createLogger({ env: "test", level: "trace", destination: capture.dest });
    const app = createApp({ logger: testLogger });
    request = supertest(app);
  });

  beforeEach(() => {
    capture.reset();
  });

  afterAll(() => {
    capture.dest.destroy();
  });

  it("pino-http access log line has reqId matching provided X-Request-Id", async () => {
    await request.get("/health").set("X-Request-Id", "abc-123");

    const lines = await capture.getLines();
    // pino-http emits at least one log line per request (request completed)
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Find the access log line — it carries reqId from customProps
    const accessLine = lines.find(
      (l) => "reqId" in l && (l as { reqId: unknown }).reqId === "abc-123",
    );
    expect(accessLine).toBeDefined();
    expect((accessLine as { reqId: string }).reqId).toBe("abc-123");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: No request body in production logs
// ---------------------------------------------------------------------------

describe("Scenario 8 — no request body in production mode access logs", () => {
  let request: ReturnType<typeof supertest>;
  let capture: ReturnType<typeof buildCapture>;

  beforeAll(() => {
    capture = buildCapture();
    // Use env: "production" to confirm the serializer behavior is environment-agnostic
    // (the serializer in app.ts never includes body regardless of env; this test
    // proves it at runtime with a production-mode logger + real HTTP round-trip).
    const testLogger = createLogger({
      env: "production",
      level: "trace",
      destination: capture.dest,
    });
    const app = createApp({ logger: testLogger });
    request = supertest(app);
  });

  beforeEach(() => {
    capture.reset();
  });

  afterAll(() => {
    capture.dest.destroy();
  });

  it("POST /health (404) access log does not contain a body field on req", async () => {
    // POST to an existing path that returns a JSON response; we only care
    // about the access log line, not the HTTP status.
    await request
      .post("/health")
      .send({ email: "sensitive@example.com", password: "hunter2" })
      .set("Content-Type", "application/json");

    const lines = await capture.getLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Every log line that includes a "req" object must NOT have a body field
    for (const line of lines) {
      const req = (line as { req?: Record<string, unknown> }).req;
      if (req !== undefined) {
        expect("body" in req).toBe(false);
      }
    }
  });
});
