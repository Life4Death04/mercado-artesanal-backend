# error-handling Specification

## Purpose

Uniform error contract for every HTTP response. Internally the codebase throws `AppError` subclasses; on the wire clients receive RFC 7807 Problem Details with a stable semantic `type` slug. This spec defines the class hierarchy, wire shape, error code registry, and middleware ordering rules.

## Requirements Traceability

- **RNF-05** GDPR/PII — error responses MUST NOT leak PII in `detail` or stack traces.
- **RNF-12** Fail-fast — server errors MUST NOT be masked as successes.
- **RNF-16** Maintainability — one central error handler.

## Wire Format (RFC 7807)

Every error response MUST have `Content-Type: application/problem+json` and a body matching:

```json
{
  "type": "/errors/<code-slug>",
  "title": "<default-title>",
  "status": <http-status>,
  "detail": "<safe human-readable message>",
  "code": "<SEMANTIC_CODE>",
  "instance": "<request-id>"
}
```

- `type` MUST be a relative URI in Cycle 1 (absolute URI promoted in Cycle 6).
- `code` MUST match the semantic code registry below.
- `instance` MUST be the request correlation ID (see `structured-logging`).
- Fields `errors[]` (array of `{ path, message }`) MAY be added for `VALIDATION_FAILED`.

## Requirements

### Requirement: Error code registry

The system MUST expose exactly the following semantic error codes in Cycle 1.

| Code                         | HTTP | `type` slug                          | Default title                | When to use                                                                |
| ---------------------------- | ---- | ------------------------------------ | ---------------------------- | -------------------------------------------------------------------------- |
| `UNAUTHORIZED`               | 401  | `/errors/unauthorized`               | "Unauthorized"               | Missing, malformed, or invalid JWT                                         |
| `FORBIDDEN`                  | 403  | `/errors/forbidden`                  | "Forbidden"                  | Authenticated but role is not allowed                                      |
| `ONBOARDING_REQUIRED`        | 403  | `/errors/onboarding-required`        | "Onboarding required"        | `role = PENDING_ROLE` hits a non-allow-list route                          |
| `NOT_FOUND`                  | 404  | `/errors/not-found`                  | "Not found"                  | Resource does not exist or is soft-deleted                                 |
| `ROLE_ALREADY_SET`           | 409  | `/errors/role-already-set`           | "Role already set"           | Onboarding retried on a non-PENDING user                                   |
| `NIF_ALREADY_REGISTERED`     | 409  | `/errors/nif-already-registered`     | "NIF already registered"     | Producer wizard NIF collides with existing Producer                        |
| `VALIDATION_FAILED`          | 422  | `/errors/validation-failed`          | "Validation failed"          | Zod body/query/params validation error                                     |
| `UNKNOWN_CATEGORY`           | 422  | `/errors/unknown-category`           | "Unknown category"           | Producer wizard references a `categorySlug` not in seed                    |
| `INVALID_DEFAULT_TRANSITION`  | 422  | `/errors/invalid-default-transition`  | "Invalid default transition"  | Consumer tries to demote current default address without promoting another                                              |
| `ADDRESS_DEFAULT_CONFLICT`    | 409  | `/errors/address-default-conflict`    | "Address default conflict"    | DB-level partial unique index violation: two concurrent writes raced to set `isDefault=true` for the same user. Source: `src/shared/errors/errors.ts` → `AddressDefaultConflictError` |

Additional generic bucket:

| Code             | HTTP | `type` slug              | Default title           | When to use                        |
| ---------------- | ---- | ------------------------ | ----------------------- | ---------------------------------- |
| `INTERNAL_ERROR` | 500  | `/errors/internal-error` | "Internal server error" | Fallback for unexpected exceptions |

#### Scenario: Registry codes map to HTTP status

- GIVEN any `AppError` subclass listed in the registry
- WHEN the error middleware serializes it
- THEN the response `status` and body `code` MUST match the registry row exactly

### Requirement: AppError class hierarchy

The system MUST expose an `AppError` base class with typed subclasses for each registry code.

- `AppError` MUST carry `code`, `status`, `title`, `detail`, and an optional `cause`.
- Subclasses MUST set `code`, `status`, and `title` from the registry.
- `VALIDATION_FAILED` subclass MUST accept a Zod issue list and expose it as `errors[]`.
- Throwing an `AppError` from a controller or service MUST NOT require the caller to build the wire response.

#### Scenario: Service throws typed error

- GIVEN a service that throws `new NifAlreadyRegisteredError()`
- WHEN the controller does not catch it
- THEN the central error middleware MUST return `409` with `code: "NIF_ALREADY_REGISTERED"`

### Requirement: Central error middleware

The system MUST install exactly one error-handling middleware as the LAST middleware in the Express chain.

- Order MUST be: security (`helmet`, `cors`, `compression`) → `express.json` → `pino-http` → routes → `errorMiddleware`.
- `errorMiddleware` MUST convert `AppError` to the wire format.
- Unknown errors (non-`AppError`) MUST be logged at `error` level and returned as `INTERNAL_ERROR` (500) with a generic `detail` — the raw message MUST NOT be exposed.
- `NODE_ENV=production` responses MUST NOT include stack traces.

#### Scenario: Unhandled non-AppError becomes 500

- GIVEN a controller that throws `new Error("db exploded: user=foo@bar")`
- WHEN the error middleware handles it
- THEN the response MUST be `500` with `code: "INTERNAL_ERROR"`
- AND the response body MUST NOT contain the substring `foo@bar`
- AND the error MUST be logged at `error` level with the raw message

#### Scenario: 404 fallback for unmatched routes

- GIVEN a request to a path that no router handles
- WHEN it reaches the fallback handler
- THEN the response MUST be `404` with `code: "NOT_FOUND"` and `type: "/errors/not-found"`

### Requirement: PII safety in error responses

Error responses MUST NOT include email, `auth0Sub`, JWT tokens, or password material in `detail`, `title`, or any nested field.

#### Scenario: Validation error does not echo secrets

- GIVEN a request body containing `{ "email": "leak@x.com", "password": "hunter2" }`
- WHEN Zod rejects the body
- THEN the `422` response MUST NOT contain `"leak@x.com"` or `"hunter2"` in any field

## Invariants

- Every HTTP error response in Cycle 1 MUST originate from `errorMiddleware`; controllers MUST NOT `res.status(...).json(...)` directly for errors.
- Introducing a new error condition MUST add a row to the registry table above and a matching `AppError` subclass.
