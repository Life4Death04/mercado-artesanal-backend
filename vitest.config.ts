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
    setupFiles: ["./tests/setup.ts"],
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
      // Required after expose-product-images-in-producer-list Slice 1.
      // Tests use https:// so the singleton boots cleanly in NODE_ENV=test.
      S3_PUBLIC_BASE_URL: "https://test-cdn.example.com",
      // Required after Cycle 5 payments WU1. Real Stripe SDK calls are always
      // mocked in tests (unit: mock stripe.client module; integration: stubbed
      // Stripe per design Testing Strategy) — this value only satisfies env.ts
      // fail-fast validation at singleton import time.
      STRIPE_SECRET_KEY: "sk_test_dummy_for_vitest",
      // Required after Cycle 5 payments WU2. `stripeClient.constructEvent` is
      // always mocked in tests (see tests/integration/payments.test.ts) — this
      // value only satisfies env.ts fail-fast validation at singleton import time.
      STRIPE_WEBHOOK_SECRET: "whsec_dummy_for_vitest",
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
