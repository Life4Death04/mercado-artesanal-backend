# Mercado Artesanal — Backend API

REST API for the Mercado Artesanal artisanal food e-commerce platform.
Built as a university thesis (TFG) + portfolio project.

**Stack**: TypeScript · Node.js 20 LTS · Express 4 · Prisma 5 · PostgreSQL 16 · Auth0 · Zod

---

## Quick start (5 commands)

```bash
# 1. Install dependencies
npm install

# 2. Copy and populate environment variables
cp .env.example .env
# Edit .env — set AUTH0_DOMAIN and AUTH0_AUDIENCE for your tenant

# 3. Start PostgreSQL (requires Docker)
docker compose up -d

# 4. Run database migration and seed
npm run db:migrate && npm run db:seed

# 5. Start the development server (hot-reload)
npm run dev
```

The API is now available at `http://localhost:3000`.

---

## Available scripts

| Script                 | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Start development server with hot-reload (`tsx watch`) |
| `npm run build`        | Compile TypeScript to `dist/` and rewrite path aliases |
| `npm run start`        | Start production server from `dist/`                   |
| `npm run typecheck`    | Type-check without emitting (`tsc --noEmit`)           |
| `npm run lint`         | Run ESLint                                             |
| `npm run lint:fix`     | Run ESLint with auto-fix                               |
| `npm run format`       | Format with Prettier                                   |
| `npm run db:migrate`   | Run Prisma migrations (development)                    |
| `npm run db:deploy`    | Apply migrations (production/CI)                       |
| `npm run db:seed`      | Seed `ProducerCategory` catalog                        |
| `npm run db:studio`    | Open Prisma Studio                                     |
| `npm run create-admin` | Bootstrap first admin user                             |
| `npm test`             | Run Vitest test suite                                  |

---

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full architecture overview.

Key principles:

- **Modular monolith** — vertical-slice layout: `src/modules/<name>/{routes,controllers,services,repositories}/`
- **Auth0-delegated identity** — JWT RS256, no local passwords
- **RBAC** — `PENDING_ROLE → CONSUMER | PRODUCER | ADMIN` via two-stage onboarding
- **Soft-delete everywhere** — explicit `where: { deletedAt: null }` in every repository query
- **RFC 7807 error responses** — `AppError` hierarchy → `{ type, title, status, detail, code }`
- **CUID string PKs** — JSON-safe, API-opaque, no BIGINT serialization hazards

---

## Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable         | Required | Description                                             |
| ---------------- | -------- | ------------------------------------------------------- |
| `NODE_ENV`       | ✅       | `development` \| `production` \| `test`                 |
| `PORT`           | ✅       | Server port (default: `3000`)                           |
| `DATABASE_URL`   | ✅       | PostgreSQL connection string                            |
| `AUTH0_DOMAIN`   | ✅       | Auth0 tenant domain (e.g. `your-tenant.eu.auth0.com`)   |
| `AUTH0_AUDIENCE` | ✅       | Auth0 API audience (e.g. `https://api.mercado.example`) |
| `LOG_LEVEL`      | —        | Pino log level (default: `info`)                        |
| `CORS_ORIGIN`    | —        | Comma-separated exact frontend origins; production requires explicit HTTPS |
| `TRUST_PROXY`    | —        | Trusted proxy IPs/CIDRs or `loopback` (default: `loopback`) |
| `BACKUP_DATABASE_HOST_ALLOWLIST` | — | Extra exact PostgreSQL hostnames/IPs allowed for backup operations |

### Reverse proxy and frontend assumptions

- Nginx is the only externally reachable HTTP entry point; the application port must not be exposed to untrusted clients.
- Set `TRUST_PROXY` to the exact source IP or narrow CIDR from which Nginx connects. Keep the default `loopback` only when Nginx connects through host loopback. This is required for client-IP rate limiting to use `X-Forwarded-For` safely.
- Nginx must replace or append the standard `X-Forwarded-For` chain and forward `X-Forwarded-Proto`. Do not preserve client-supplied forwarding headers at an untrusted boundary.
- Set `CORS_ORIGIN` to every browser frontend origin, separated by commas. Origins include scheme and optional port, but no path. Production rejects `*` and plain HTTP.
- If `DATABASE_URL` uses a service hostname such as `postgres`, add that exact hostname to `BACKUP_DATABASE_HOST_ALLOWLIST`. Omitting the variable keeps backup/restore connections loopback-only.
- Nginx health checks can use `/health`; readiness checks that require database connectivity can use `/health/ready`.

---

## Admin bootstrap

To create the first admin user:

```bash
npm run create-admin -- --email admin@example.com --auth0-sub auth0|your-user-id
```

See [`docs/admin-recovery.md`](docs/admin-recovery.md) for recovery procedures.

---

## License

UNLICENSED — university thesis project.
