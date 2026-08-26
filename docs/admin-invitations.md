# Administrator Invitations

Use `POST /api/v1/admin/admins` to create administrators during normal operation. The caller must be an authenticated, active `ADMIN`. Supply a unique `requestKey`, the invitee email, and optional nullable `firstName` and `lastName`. A successful request returns `202 Accepted`, a safe operation view, `Location`, and `Retry-After: 2`.

Poll the returned `links.self` URL. Poll responses use `Cache-Control: no-store`. `SUCCEEDED`, `FAILED`, and `COMPENSATED` are terminal; `PENDING`, `PROCESSING`, and `COMPENSATING` are not. `COMPENSATED` means an Auth0 identity created by this operation was removed after local administrator creation could not complete.

## Deployment

1. Apply repository migrations before enabling invitation traffic.
2. Configure `DATABASE_URL`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_M2M_CLIENT_ID`, `AUTH0_M2M_CLIENT_SECRET`, `AUTH0_APPLICATION_CLIENT_ID`, `AUTH0_DATABASE_CONNECTION`, and `AUTH0_REQUEST_TIMEOUT_MS`.
3. Grant the Auth0 Management API client only `create:users`, `read:users`, and `delete:users`. Do not grant broader tenant-management scopes.
4. Start the API normally. The automatic worker starts with the server, processes durable operations, and resumes pending, compensating, or lease-expired work after restart.

## Safe Operations

- Reuse the same `requestKey` only for an exact replay by the same administrator. Different input returns a redacted `409`.
- Troubleshoot with the operation ID, public status, timestamps, and server-side failure classification. Do not log request bodies, request keys, provider responses, tokens, credentials, or internal error details.
- If an operation remains non-terminal, verify database connectivity, the worker process, Auth0 reachability, configured variable names, least-privilege scopes, and clock health. Restarting the API is safe because progress and leases are durable.
- A terminal `FAILED` or `COMPENSATED` operation requires a new request key after the underlying cause is corrected.

## Break-Glass Recovery

The `npm run create-admin` CLI bypasses the invitation workflow and is only for loss of all administrator access. Follow [Admin Recovery Procedure](admin-recovery.md), record its use out of band, and do not use it for routine provisioning.
