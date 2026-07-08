# Admin Recovery Procedure

This document describes how to recover admin access when the sole admin account is lost, locked out of Auth0, or needs to be replaced.

> **Security notice**: This procedure requires direct CLI access to the deployed environment. It is an offline operation by design (ADR-006: least-privilege). Log every use of this procedure in your out-of-band audit trail.

---

## Prerequisites

- SSH access to the deployment host (or local dev environment).
- `DATABASE_URL` environment variable set and pointing to the target database.
- Node.js ≥ 20 and project dependencies installed (`npm install`).
- A valid Auth0 user sub for the replacement admin (obtainable from the Auth0 dashboard under **User Management → Users → user\_id** field).

---

## Step 1 — Identify and remove the stale admin row

Connect to the database and soft-delete (or hard-delete) the existing admin row.

**Soft-delete (recommended — preserves audit history):**

```sql
UPDATE users
SET deleted_at = NOW()
WHERE auth0_sub = 'auth0|YOUR_OLD_ADMIN_SUB'
  AND role = 'ADMIN';
```

**Hard-delete (only if soft-delete is not sufficient):**

```sql
DELETE FROM users
WHERE auth0_sub = 'auth0|YOUR_OLD_ADMIN_SUB';
```

After deletion, verify no active admin remains:

```sql
SELECT id, email, auth0_sub, role, deleted_at
FROM users
WHERE role = 'ADMIN' AND deleted_at IS NULL;
-- Expected: 0 rows
```

---

## Step 2 — Create the replacement admin

Run the `create-admin` CLI script with the new credentials:

```bash
npm run create-admin -- \
  --email admin@example.com \
  --auth0-sub "auth0|YOUR_NEW_ADMIN_SUB" \
  --first-name "Admin" \
  --last-name "User"
```

On success the script prints `Admin created: id=<cuid>` and exits with code `0`.

**Exit codes:**

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Admin created successfully.                                              |
| `1`  | Argument validation failed — check `--email` and `--auth0-sub`.         |
| `2`  | An active admin already exists — complete Step 1 first.                  |
| `3`  | Unexpected error (DB connection failure, write conflict, etc.).           |

---

## Step 3 — Verify the new admin

```sql
SELECT id, email, auth0_sub, role, email_verified, deleted_at
FROM users
WHERE role = 'ADMIN' AND deleted_at IS NULL;
-- Expected: 1 row with the new email and auth0_sub
```

The new admin's `email_verified` will be `false` until they log in via Auth0 for the first time — this is expected behaviour.

---

## When this procedure is needed

- The Auth0 account associated with the admin was deleted.
- The admin credentials were lost and Auth0 self-service recovery is not available.
- A security incident requires revoking the existing admin and replacing it with a new one.

---

## Important constraints

- The `create-admin` CLI script refuses to run if an active admin already exists (`exit 2`). There is **no flag** to bypass this guard. You must complete Step 1 before running Step 2.
- This operation **must** be logged in an out-of-band audit trail (security log, change ticket, etc.).
- Cycle 2 will introduce `POST /admin/admins` for admin creation via the HTTP API (admin-only). This procedure remains available for disaster recovery regardless of later cycles.

---

## Cross-references

- [`scripts/create-admin.ts`](../scripts/create-admin.ts) — CLI implementation.
- [`docs/architecture.md`](architecture.md) — system overview.
- `openspec/specs/admin-bootstrap/spec.md` — formal requirements.
