/**
 * Integration smoke test: health endpoints.
 *
 * Mounts createApp() in-memory via Supertest — no TCP socket, no live DB required.
 *
 * Covered scenarios (per health-checks spec §21):
 *   - GET /health       → 200, correct JSON shape, no auth required
 *   - GET /health/ready → 200 or 503 depending on DB state; correct JSON shape either way
 *
 * DB probe: the readiness handler tries a live DB call. In CI without a running
 * Postgres we expect 503. Both 200 and 503 are accepted here — the test verifies
 * the shape, not which branch is taken. A dedicated DB-connected test suite
 * (Cycle 2) will assert the 200 path.
 */
import supertest from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import { createApp } from "@/app";
import { prisma } from "@/shared/utils/prisma";

const app = createApp();
const request = supertest(app);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /health — liveness", () => {
  it("returns 200 with the correct shape", async () => {
    const res = await request.get("/health");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      status: "ok",
      version: expect.any(String) as string,
      uptime: expect.any(Number) as number,
    });
  });

  it("does not require Authorization header", async () => {
    const res = await request.get("/health");
    // Must be 200, never 401
    expect(res.status).toBe(200);
  });

  it("echoes X-Request-Id when provided", async () => {
    const res = await request.get("/health").set("X-Request-Id", "test-correlation-id");
    expect(res.headers["x-request-id"]).toBe("test-correlation-id");
  });

  it("generates X-Request-Id when none provided", async () => {
    const res = await request.get("/health");
    const reqId = res.headers["x-request-id"] as string;
    expect(typeof reqId).toBe("string");
    expect(reqId.length).toBeGreaterThan(0);
  });
});

describe("GET /health/ready — readiness", () => {
  it("returns 200 or 503 with the correct shape", async () => {
    const res = await request.get("/health/ready");

    expect([200, 503]).toContain(res.status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    if (res.status === 200) {
      expect(res.body).toEqual({ status: "ok", db: "ok" });
    } else {
      expect(res.body).toEqual({ status: "degraded", db: "unreachable" });
    }
  });
});
