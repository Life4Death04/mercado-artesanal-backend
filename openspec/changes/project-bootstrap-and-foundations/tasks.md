# Tasks: Project Bootstrap and Foundations

## Review Workload Forecast

| Field                   | Value                                           |
| ----------------------- | ----------------------------------------------- |
| Estimated changed lines | ~1650 total (250 / 350 / 350 / 250 / 300 / 350) |
| 400-line budget risk    | High                                            |
| 800-line budget risk    | Low                                             |
| Chained PRs recommended | Yes                                             |
| Suggested split         | PR#1 → PR#2 → PR#3 → PR#4a → PR#4b → PR#5       |
| Delivery strategy       | force-chained                                   |
| Chain strategy          | feature-branch-chain                            |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
800-line budget risk: Low

### Suggested Work Units

| Unit | Goal                   | Likely PR | Notes                            |
| ---- | ---------------------- | --------- | -------------------------------- |
| 1    | Skeleton + tooling     | PR#1      | base=`feature/cycle-1-bootstrap` |
| 2    | Prisma, logger, health | PR#2      | base=`PR#1`                      |
| 3    | Error/RBAC middleware  | PR#3      | base=`PR#2`                      |
| 4    | Auth sync + me         | PR#4a     | base=`PR#3`                      |
| 5    | Onboarding flows       | PR#4b     | base=`PR#4a`                     |
| 6    | Addresses + admin CLI  | PR#5      | base=`PR#4b`                     |

## Phase 1: Skeleton / Tooling

- [x] 1.1 Create `package.json`, `tsconfig*.json`, ESLint, Prettier, `.editorconfig`, `.gitignore`, `.env.example` and scripts from `project-skeleton`; align with ADR-001/ADR-002.
- [x] 1.2 Scaffold `src/app.ts`, `src/server.ts`, `src/shared/utils/env.ts`, `docker-compose.yml`, `README.md`, `docs/architecture.md`; verify `typecheck`, `lint`, `format --check`, `build` pass.

## Phase 2: Prisma / Health / Logging

- [x] 2.1 Add `prisma/schema.prisma`, init migration, raw partial index `one_default_address_per_user`, and `prisma/seed.ts` for `producer-bootstrap`; honor ADR-003, ADR-008, R-2, R-4.
- [x] 2.2 Add `src/shared/utils/{prisma,logger}.ts`, `src/modules/health/*`, and wire `helmet → cors → compression → json → pino-http` in `src/app.ts`; add `tests/integration/health.test.ts` smoke per §21.

## Phase 3: Error / Auth / RBAC Foundation

- [ ] 3.1 Create `src/shared/errors/{AppError,errors}.ts` and `src/shared/middleware/{errorMiddleware,notFoundHandler}.ts` for `error-handling`; include Auth0 remap branch from R-5 / ADR-004.
- [ ] 3.2 Create `src/shared/middleware/{authenticate,loadUser,onboardingGate,requireRole}.ts` plus `src/shared/types/express.d.ts`; add Vitest unit tests for serializer, allow-list, and role checks per §21.

## Phase 4: Auth Sync / User Read / Onboarding

- [ ] 4.1 Add `src/shared/repositories/user.repository.ts` and `src/modules/{auth,users}/*` for `POST /api/v1/auth/sync` and `GET /api/v1/users/me`; preserve P-3 and `auth-jwt`/`user-profile` rules.
- [ ] 4.2 Add `src/shared/validation/zod.ts` and `src/modules/onboarding/*` for consumer/producer transactions, category dedupe, NIF/postal validation, and `description.max(2000)`; cover `user-onboarding`, `producer-bootstrap`, R-4.
- [ ] 4.3 Wire `/api/v1` routes and onboarding allow-list in `src/app.ts`; add Supertest cases for first-sync, re-sync, pending/me, consumer success, producer success, unknown slug, duplicate NIF, and ROLE_ALREADY_SET.

## Phase 5: Addresses / Admin Bootstrap / Finalization

- [ ] 5.1 Add `src/modules/addresses/*` for owner-scoped CRUD, soft-delete reads, default promotion/demotion transactions, and 404-no-leak behavior; trace `address-book`, ADR-003, R-2.
- [ ] 5.2 Add `scripts/create-admin.ts`, `docs/admin-recovery.md`, README quickstart, and tests for address edge cases plus CLI guardrails from `admin-bootstrap` and ADR-006.
