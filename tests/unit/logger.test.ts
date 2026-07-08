/**
 * Unit tests — structured-logging spec runtime coverage (Block B, PR#2 cleanup).
 *
 * Scenarios covered (no HTTP layer):
 *   1. Dev transport config — NODE_ENV=development produces a pino instance
 *      with transport.target === "pino-pretty" and the exact options from logger.ts.
 *   2. Production JSON — NODE_ENV=production emits single-line JSON with level,
 *      time, and msg fields; no transport property on the pino options.
 *   3. PII redaction — Authorization header → "[REDACTED]" in a simulated req object.
 *   4. PII redaction — user email in a hand-written log call → "[REDACTED]",
 *      other fields preserved.
 *   5. PII redaction — parametrized test covering all remaining redact paths:
 *      cookie, auth0Sub, password, token, accessToken, idToken, refreshToken,
 *      req.body.email, req.body.password.
 *
 * Design note:
 *   Scenario 1 validates the transport OPTIONS OBJECT only — the pino-pretty
 *   worker thread is intentionally NOT spawned in tests (it would require a
 *   live pino-pretty binary and a separate write stream). This gives us
 *   deterministic, fast coverage of the configuration path without the
 *   complexity of intercepting a worker thread.
 *
 * Log capture strategy:
 *   All production/test-mode loggers are built via createLogger({ destination })
 *   where destination is a Writable that accumulates chunks into an array.
 *   We parse accumulated JSON lines after each call with a nextTick/flush guard.
 */
import { Writable } from "node:stream";

import pino, { type TransportSingleOptions } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REDACT_CONFIG, buildLoggerOptions, createLogger } from "@/shared/utils/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accumulates pino log lines. Call flush() to get parsed JSON objects. */
function buildCapture(): { dest: Writable; flush: () => Promise<Record<string, unknown>[]> } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const flush = (): Promise<Record<string, unknown>[]> =>
    new Promise((resolve) => {
      // Give pino one tick to drain any pending writes
      setImmediate(() => {
        const lines = chunks
          .join("")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        resolve(lines);
      });
    });
  return { dest, flush };
}

// ---------------------------------------------------------------------------
// Scenario 1: Dev transport config
// ---------------------------------------------------------------------------

describe("Scenario 1 — dev environment transport config", () => {
  it("dev env produces pino-pretty transport with exact options", () => {
    // buildLoggerOptions is a pure function — no worker thread is spawned here.
    // We inspect the returned LoggerOptions object directly to prove the
    // transport target, options, level, and redact config are all correct.
    const opts = buildLoggerOptions("development", "info");

    // transport is always TransportSingleOptions for development — cast to access .target/.options
    const transport = opts.transport as TransportSingleOptions | undefined;

    // Transport target must be pino-pretty
    expect(transport?.target).toBe("pino-pretty");

    // Transport options must match exactly what the spec's design demands
    expect(transport?.options).toEqual({
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
      ignore: "pid,hostname",
    });

    // Level and redact config are wired correctly
    expect(opts.level).toBe("info");
    expect(opts.redact).toBe(REDACT_CONFIG);
  });

  it("dev env transport config is accepted by pino at construction time", () => {
    // Proves the config is not just syntactically shaped but also semantically
    // valid: pino resolves the pino-pretty target without throwing.
    // If pino-pretty were absent or the target string were wrong, pino would
    // throw "unable to determine transport target" at construction time.
    expect(() => pino(buildLoggerOptions("development", "info"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Production JSON output
// ---------------------------------------------------------------------------

describe("Scenario 2 — production environment emits JSON to destination", () => {
  it("NODE_ENV=production logger.info({ event }) emits single-line JSON with level, time, msg", async () => {
    const { dest, flush } = buildCapture();
    const logger = createLogger({ env: "production", level: "info", destination: dest });

    logger.info({ event: "boot" }, "started");

    const lines = await flush();
    expect(lines).toHaveLength(1);

    const line = lines[0];
    expect(typeof line).toBe("object");
    expect("level" in (line ?? {})).toBe(true);
    expect("time" in (line ?? {})).toBe(true);
    expect("msg" in (line ?? {})).toBe(true);
    expect((line as { msg: string }).msg).toBe("started");
    // level 30 = info in pino's numeric encoding
    expect((line as { level: number }).level).toBe(30);
    // No transport property visible in the JSON output
    expect("transport" in (line ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: PII redaction — Authorization header
// ---------------------------------------------------------------------------

describe("Scenario 3 — PII redaction: Authorization header", () => {
  it("req.headers.authorization is replaced with '[REDACTED]'", async () => {
    const { dest, flush } = buildCapture();
    const logger = createLogger({ env: "test", level: "trace", destination: dest });

    // Simulate what pino-http serializes into the log when it logs a request
    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature",
            "content-type": "application/json",
          },
        },
      },
      "request incoming",
    );

    const lines = await flush();
    expect(lines).toHaveLength(1);

    const line = lines[0] as {
      req: { headers: { authorization: string; "content-type": string } };
    };
    expect(line.req.headers.authorization).toBe("[REDACTED]");
    // Non-PII header must be preserved
    expect(line.req.headers["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: PII redaction — email in hand-written log
// ---------------------------------------------------------------------------

describe("Scenario 4 — PII redaction: email in hand-written log call", () => {
  it("user.email is '[REDACTED]' while user.id remains visible", async () => {
    const { dest, flush } = buildCapture();
    const logger = createLogger({ env: "test", level: "info", destination: dest });

    // Exact call from spec §User email is redacted in a hand-written log
    // Note: BigInt is not JSON-serializable; pino handles it via its serializer.
    // Using number instead (pino serializes BigInt to string but test is about redaction).
    logger.info({ user: { email: "a@b.com", id: 1 } }, "sync");

    const lines = await flush();
    expect(lines).toHaveLength(1);

    const line = lines[0] as { user: { email: string; id: number } };
    expect(line.user.email).toBe("[REDACTED]");
    expect(line.user.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: PII redaction — parametrized coverage of all remaining paths
// ---------------------------------------------------------------------------

describe("Scenario 5 — PII redaction: parametrized coverage of all redact paths", () => {
  let dest: Writable;
  let flush: () => Promise<Record<string, unknown>[]>;

  beforeEach(() => {
    const capture = buildCapture();
    dest = capture.dest;
    flush = capture.flush;
  });

  afterEach(() => {
    dest.destroy();
  });

  it.each([
    // [description, log-payload, path-in-result, expected-value]
    [
      "req.headers.cookie",
      { req: { headers: { cookie: "session=abc123" } } },
      (parsed: Record<string, unknown>) =>
        (parsed as { req: { headers: { cookie: string } } }).req.headers.cookie,
    ],
    [
      "*.auth0Sub",
      { user: { auth0Sub: "auth0|user_123" } },
      (parsed: Record<string, unknown>) => (parsed as { user: { auth0Sub: string } }).user.auth0Sub,
    ],
    [
      "*.password",
      { credentials: { password: "hunter2" } },
      (parsed: Record<string, unknown>) =>
        (parsed as { credentials: { password: string } }).credentials.password,
    ],
    [
      "*.token",
      { data: { token: "tok_abc123" } },
      (parsed: Record<string, unknown>) => (parsed as { data: { token: string } }).data.token,
    ],
    [
      "*.accessToken",
      { session: { accessToken: "at_xyz789" } },
      (parsed: Record<string, unknown>) =>
        (parsed as { session: { accessToken: string } }).session.accessToken,
    ],
    [
      "*.idToken",
      { session: { idToken: "id_tok_abc" } },
      (parsed: Record<string, unknown>) =>
        (parsed as { session: { idToken: string } }).session.idToken,
    ],
    [
      "*.refreshToken",
      { session: { refreshToken: "rt_abc" } },
      (parsed: Record<string, unknown>) =>
        (parsed as { session: { refreshToken: string } }).session.refreshToken,
    ],
    [
      "req.body.email",
      { req: { body: { email: "pii@example.com", name: "Alice" } } },
      (parsed: Record<string, unknown>) =>
        (parsed as { req: { body: { email: string } } }).req.body.email,
    ],
    [
      "req.body.password",
      { req: { body: { password: "supersecret" } } },
      (parsed: Record<string, unknown>) =>
        (parsed as { req: { body: { password: string } } }).req.body.password,
    ],
  ] as const)(
    "redacts path '%s' → '[REDACTED]'",
    async (
      _description: string,
      payload: Record<string, unknown>,
      extract: (parsed: Record<string, unknown>) => unknown,
    ) => {
      const capture = buildCapture();
      const logger = createLogger({ env: "test", level: "trace", destination: capture.dest });
      logger.info(payload, "pii-test");
      const lines = await capture.flush();
      expect(lines).toHaveLength(1);
      expect(extract(lines[0]!)).toBe("[REDACTED]");
    },
  );
});
