import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "@/app";
import { env } from "@/shared/utils/env";

describe("HTTP network boundaries", () => {
  it("allows configured frontend origins and omits CORS headers for other origins", async () => {
    const app = createApp();

    const allowed = await request(app).get("/health").set("Origin", "http://frontend.test");
    const denied = await request(app).get("/health").set("Origin", "https://unknown.test");

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://frontend.test");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("uses the forwarded client IP only when the direct proxy is trusted", async () => {
    const app = express();
    app.set("trust proxy", env.TRUST_PROXY);
    app.use(rateLimit({ windowMs: 60_000, limit: 1 }));
    app.get("/", (_req, res) => res.sendStatus(204));

    expect((await request(app).get("/").set("X-Forwarded-For", "192.0.2.10")).status).toBe(204);
    expect((await request(app).get("/").set("X-Forwarded-For", "192.0.2.10")).status).toBe(429);
    expect((await request(app).get("/").set("X-Forwarded-For", "192.0.2.11")).status).toBe(204);

    const untrustedApp = express();
    untrustedApp.set("trust proxy", ["10.0.0.1"]);
    untrustedApp.use(rateLimit({ windowMs: 60_000, limit: 1 }));
    untrustedApp.get("/", (_req, res) => res.sendStatus(204));

    expect(
      (await request(untrustedApp).get("/").set("X-Forwarded-For", "192.0.2.20")).status,
    ).toBe(204);
    expect(
      (await request(untrustedApp).get("/").set("X-Forwarded-For", "192.0.2.21")).status,
    ).toBe(429);
  });
});
