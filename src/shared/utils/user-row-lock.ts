/**
 * User row lock protocol — the single narrow boundary where this codebase
 * issues raw SQL to take Postgres row locks on `users` (design "ORM vs row
 * locks": "Raw SQL needs a narrow boundary").
 *
 * `lockUserRows(tx, ids)` deduplicates the id set and runs ONE parameterized
 * tagged `$queryRaw`: `SELECT id FROM users WHERE id IN (...) ORDER BY id
 * FOR UPDATE`. Ordering by `id` before locking is a deliberate deadlock
 * guard — every caller that needs to lock more than one User row (checkout
 * across multiple producer owners, admin lifecycle transitions) MUST always
 * acquire locks in the SAME deterministic order, so two concurrent
 * transactions locking an overlapping set can never form a lock-wait cycle.
 *
 * Callers lock the COMPLETE set ONCE, then re-read the rows they need
 * (design "Callers lock the complete set once, then re-read") — this
 * function returns only the locked row count/ids, never a business
 * projection; callers issue their OWN `tx.user.findMany` afterward to read
 * whatever columns they need under the lock already held.
 *
 * MUST run inside an existing `tx` (interactive transaction) — `FOR UPDATE`
 * locks are meaningless outside a transaction and are released at commit or
 * rollback.
 *
 * Design references:
 *   design — Architecture Decisions, "ORM vs row locks"
 *   design — Data Flow, "lock target User" / "locks the complete
 *     consumer/owner set"
 */
import { Prisma } from "@prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Locks every row in `userIds` (deduplicated) with `FOR UPDATE`, in
 * ascending `id` order (deadlock-avoidance — see file header).
 *
 * No-op (zero-row query, no lock taken) when `userIds` is empty — callers
 * are not required to special-case an empty selection set.
 *
 * @returns the ids that were actually found and locked. A caller that
 *   expects every requested id to exist SHOULD compare
 *   `lockedIds.length === new Set(userIds).size` and fail closed on a
 *   mismatch (a missing row means an id was invalid at the call site, not a
 *   lock-protocol concern).
 */
export async function lockUserRows(tx: PrismaTx, userIds: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) {
    return [];
  }

  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users WHERE id IN (${Prisma.join(uniqueIds)}) ORDER BY id FOR UPDATE
  `;

  return rows.map((row) => row.id);
}
