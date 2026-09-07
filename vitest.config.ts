import { resolve } from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    // Integration tests share one real Postgres database and some assertions
    // (e.g. tests/integration/payments.test.ts WU2-1..3 before/after row
    // counts) read that shared state. Running test FILES in parallel forks
    // let unrelated files write Payment/Order rows between a test's own
    // before/after count, causing nondeterministic full-suite failures that
    // do not reproduce when a file is run in isolation. Disabling file
    // parallelism serializes file execution (fileParallelism forces
    // maxWorkers=1) so shared-database assertions are deterministic without
    // weakening what any test asserts. See Vitest docs: "File parallelism
    // can be disabled ... useful in scenarios where tests share external
    // resources, such as a database, that cannot handle concurrent access."
    fileParallelism: false,
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
      CORS_ORIGIN: "http://frontend.test,https://admin.test",
      TRUST_PROXY: "loopback",
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
      // Required after Cycle 5 notifications Phase 2. Explicitly pinned to
      // "console" (same as the schema default) so the test-env singleton
      // never selects the SES provider — @aws-sdk/client-ses is globally
      // mocked in tests/setup.ts regardless, but this keeps intent explicit.
      EMAIL_PROVIDER: "console",
      // Required after admin-database-backups Phase 1 (env.ts fail-fast on
      // missing/relative). Real Client 16 binaries are never invoked by unit
      // tests in this PR — routes stay disabled until Phase 4.
      BACKUP_ARTIFACT_DIR: "/tmp/mercado-test-backups",
      PG_DUMP_PATH: "/usr/lib/postgresql/16/bin/pg_dump",
      PG_RESTORE_PATH: "/usr/lib/postgresql/16/bin/pg_restore",
      BACKUP_OPERATION_TIMEOUT_MS: "300000",
      BACKUP_DATABASE_HOST_ALLOWLIST: "",
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
