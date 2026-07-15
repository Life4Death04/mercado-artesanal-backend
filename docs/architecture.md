# Architecture — Mercado Artesanal Backend

> Cycle 1 of 6 | Status: in progress
> Last updated: 2026-07-07

---

## Overview

Mercado Artesanal is built as a **vertical-slice modular monolith**: one deployable process, feature-cohesive modules, no shared mutable state between modules.

The complexity budget in Cycle 1 is spent on invariants that must NOT leak:

- Two-stage onboarding (PENDING → CONSUMER/PRODUCER)
- Address auto-promotion on delete
- Producer transactional creation (NIF uniqueness, category deduplication)
- PII redaction in all logs

Everything else is baseline industry-standard: Express, Prisma, Auth0, pino.

---

## Directory layout

```
src/
├── app.ts                         ← createApp() — Express factory, no listen()
├── server.ts                      ← Process entry-point (listen + graceful shutdown)
├── modules/
│   ├── auth/
│   │   ├── routes/auth.routes.ts
│   │   ├── controllers/auth.controller.ts
│   │   └── services/auth.service.ts
│   ├── users/
│   │   ├── routes/users.routes.ts
│   │   ├── controllers/users.controller.ts
│   │   └── services/users.service.ts
│   ├── onboarding/
│   │   ├── routes/onboarding.routes.ts
│   │   ├── controllers/onboarding.controller.ts
│   │   ├── services/onboarding.service.ts
│   │   └── repositories/producer.repository.ts
│   ├── addresses/
│   │   ├── routes/addresses.routes.ts
│   │   ├── controllers/addresses.controller.ts
│   │   └── services/addresses.service.ts
│   └── health/
│       ├── routes/health.routes.ts
│       └── controllers/health.controller.ts
├── shared/
│   ├── middleware/
│   │   ├── authenticate.ts           ← express-oauth2-jwt-bearer wrapper
│   │   ├── loadUser.ts               ← req.user population
│   │   ├── onboardingGate.ts         ← 403 ONBOARDING_REQUIRED
│   │   ├── requireRole.ts            ← role factory
│   │   ├── errorMiddleware.ts        ← RFC 7807 serializer (LAST middleware)
│   │   └── notFoundHandler.ts        ← 404 fallback
│   ├── errors/
│   │   ├── AppError.ts               ← Abstract base
│   │   └── errors.ts                 ← All subclasses
│   ├── repositories/
│   │   └── user.repository.ts        ← Shared user read/write (cross-module)
│   ├── utils/
│   │   ├── env.ts                    ← Zod-validated env (fail-fast)
│   │   ├── prisma.ts                 ← PrismaClient singleton
│   │   └── logger.ts                 ← pino + PII redact
│   ├── types/
│   │   └── express.d.ts              ← req.auth, req.user augmentations
│   └── validation/
│       └── zod.ts                    ← Shared refinements (NIF, postalCode)
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── scripts/
│   └── create-admin.ts
└── docs/
    ├── architecture.md               ← This file
    ├── auth0-setup.md
    └── admin-recovery.md
```

---

## Architecture Decision Records

### ADR-001 — Modular monolith, vertical-slice layout

**Decision**: Feature code lives in `src/modules/<name>/{routes,controllers,services,repositories}/`. Cross-cutting code lives in `src/shared/`. No feature module imports from another feature module directly.

**Why**: Cohesion per feature; easy to extract a module into a microservice later without circular dependency untangling.

**Consequence**: The `User` entity is accessed by `auth`, `users`, and `onboarding` — it lives in `src/shared/repositories/user.repository.ts` as the single cross-module read path.

---

### ADR-002 — TypeScript strict + CommonJS + tsc-alias

**Decision**: `strict: true`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `module: "CommonJS"`, `moduleResolution: "node16"`. Dev: `tsx watch`. Build: `tsc -p tsconfig.build.json && tsc-alias`.

**Why**: Fast dev server, readable production output. No ESM/CJS interop pain with Prisma and pino in 2026 CommonJS-dominant ecosystem. `tsc-alias` rewrites `@/*` import aliases in `dist/` so `node dist/server.js` runs without resolver patches.

**Consequence**: Path alias `@/*` → `src/*` works at dev-time (tsx) and at runtime (tsc-alias). Verified by acceptance: `npm run build && node dist/server.js` must start cleanly.

---

### ADR-003 — Soft-delete via explicit `where: { deletedAt: null }`

**Decision**: Every Prisma query that reads business entities MUST include `where: { deletedAt: null }` explicitly. No Prisma middleware, no `$extends` query extension.

**Why**: Explicit is bulletproof. Middleware-based solutions have been known to silently skip on nested reads or raw queries.

**Consequence**: Verbose query code, but reviewers can always see the filter. Services call `prisma` (or a transaction client `tx`) directly — the `repositories/` sub-layer existed only in `onboarding` and `shared/` where cross-module reuse justified it; `addresses` and `products` services issue Prisma calls inline.

---

### ADR-004 — Hybrid error handling: AppError → RFC 7807

**Decision**: Internal code throws typed `AppError` subclasses. The single `errorMiddleware` (last Express middleware) serializes them to RFC 7807 Problem Details: `{ type, title, status, detail, code, instance }`.

**Why**: Ergonomic in code (throw and forget); standardized on the wire (clients parse one shape).

**Consequence**: `errorMiddleware` also remaps Auth0 library errors (`InvalidTokenError`, `{ status: 401 }`) to `UnauthorizedError` — this is the single point of Auth0 → AppError translation (R-5).

---

### ADR-005 — Auth0 + two-stage onboarding

**Decision**: Auth0 is the identity provider (no local passwords). Every user starts with `role = PENDING_ROLE` after `/auth/sync`. They must complete the onboarding wizard (consumer or producer) to unlock the rest of the API.

**Why**: Backend owns role state; abandoned wizards are re-prompted on next login. Auth0 stays simple.

**Consequence**: The `onboardingGate` middleware allows only 4 routes for `PENDING_ROLE` users. Every new authenticated route is blocked by default — reviewers must explicitly opt in.

---

### ADR-006 — Admin bootstrap via CLI only (Cycle 1)

**Decision**: First admin is created by running `npm run create-admin -- --email ... --auth0-sub ...`. No HTTP endpoint for admin creation in Cycle 1.

**Why**: Least-privilege (RNF-09). Explicit, auditable, cannot be triggered by a web client.

**Consequence**: `scripts/create-admin.ts` guards against a second admin creation attempt (exit code 2). Recovery documented in `docs/admin-recovery.md`.

---

### ADR-007 — pino + PII redact

**Decision**: `pino` with `pino-pretty` (dev) / JSON (prod). Redact: `Authorization`, `cookie`, `email`, `auth0Sub`, `password`, `token`, `accessToken`, `idToken`, `refreshToken`.

**Why**: ~5× faster than winston; JSON-native; GDPR-compliant redaction prevents credential leaks in log aggregators.

**Consequence**: Log bodies are NOT included in production (spec: no bodies). `X-Request-Id` is echoed as a response header via `pino-http` + small header middleware.

---

### ADR-008 — CUID string PKs (deviation from essay's BIGINT)

**Decision**: All primary keys use `String @id @default(cuid())`. All foreign keys are `String`. DB columns are `TEXT`.

**Why**:

1. JSON-safe — `BigInt` is not JSON-serializable by default; CUID is a plain string.
2. API-opaque — sequential BIGINT leaks cardinality; CUIDs do not.
3. Distributed-friendly — no DB round-trip for ID generation.

**Trade-off accepted**: 25-char string PKs cost more storage than 8-byte BIGINT. Acceptable at TFG scale.

---

## Middleware composition order

```
[helmet]         ← security headers first
[cors]           ← reject cross-origin before body parsing
[compression]    ← transparent to logging
[express.json]   ← body parsed before pino-http (enables body redaction)
[pino-http]      ← assigns req.id (correlation ID visible to all downstream layers)
[/health]        ← public, no auth chain
[/api/v1]        ← each route applies: authenticate → loadUser → onboardingGate → requireRole → controller
[notFoundHandler]← 404 → NotFoundError (reaches only unrouted paths)
[errorMiddleware]← LAST — RFC 7807 serializer (Express requires 4-arg error handler as last)
```

---

## HTTP surface (Cycle 1)

| Method | Path                                   | Auth       | Purpose                                |
| ------ | -------------------------------------- | ---------- | -------------------------------------- |
| GET    | `/health`                              | public     | Liveness check                         |
| GET    | `/health/ready`                        | public     | Readiness — DB `SELECT 1` only         |
| POST   | `/api/v1/auth/sync`                    | JWT        | Idempotent user sync from Auth0 claims |
| GET    | `/api/v1/users/me`                     | JWT        | Current user profile                   |
| POST   | `/api/v1/users/me/onboarding/consumer` | JWT        | Consumer onboarding wizard             |
| POST   | `/api/v1/users/me/onboarding/producer` | JWT        | Producer onboarding wizard             |
| GET    | `/api/v1/users/me/addresses`           | JWT + role | List addresses                         |
| POST   | `/api/v1/users/me/addresses`           | JWT + role | Create address                         |
| PATCH  | `/api/v1/users/me/addresses/:id`       | JWT + role | Update address                         |
| DELETE | `/api/v1/users/me/addresses/:id`       | JWT + role | Soft-delete address                    |

---

## Data model summary

Five Prisma models: `User`, `Producer`, `ProducerCategory`, `ProducerCategoryOnProducer`, `Address`.

Key constraints:

- `User.auth0Sub` — unique (Auth0 identity anchor)
- `Producer.nif` — unique (Spanish business tax ID)
- `Producer.userId` — unique (one Producer per User)
- Address: partial unique index `one_default_address_per_user` on `(user_id) WHERE is_default = true AND deleted_at IS NULL` (raw SQL in init migration — Prisma cannot express partial unique indexes in schema blocks)

See `prisma/schema.prisma` for the authoritative schema.

---

## Testing strategy

| Layer       | What                                                                | Tool                                   |
| ----------- | ------------------------------------------------------------------- | -------------------------------------- |
| Unit        | AppError serializer, onboardingGate allow-list, requireRole factory | Vitest, no DB                          |
| Integration | Endpoint happy + error paths                                        | Vitest + Supertest + `mercado_test` DB |
| E2E         | N/A Cycle 1                                                         | —                                      |

Cycle 1: harness wired + `/health` smoke test. Cycle 2: strict TDD + Cycle-1 endpoint back-fill.

Vitest config: `pool: "forks"` (Prisma-safe), `sequence.concurrent: false` (DB state), `testTimeout: 10000`.
