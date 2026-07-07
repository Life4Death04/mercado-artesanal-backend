import { resolve } from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    sequence: {
      concurrent: false,
    },
    testTimeout: 10000,
    // Provide minimum required env vars so env.ts validates at import time.
    // Tests that need a real DB spin up docker-compose.test.yml (Cycle 2+).
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/mercado_test",
      AUTH0_DOMAIN: "test.eu.auth0.com",
      AUTH0_AUDIENCE: "https://api.test.example",
      LOG_LEVEL: "error",
      CORS_ORIGIN: "*",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/**", "dist/**", "prisma/**", "scripts/**"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
