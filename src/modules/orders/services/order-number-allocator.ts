/**
 * Order number allocator — narrow typed raw-SQL boundary that atomically
 * assigns actor-scoped public references (design "Technical Approach").
 *
 * `allocateOrderNumber`/`allocateSubOrderNumber` each run ONE parameterized
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` against the actor's
 * dedicated counter table (`order_number_counters` / `sub_order_number_counters`,
 * WU1 schema), on the CALLER's `Prisma.TransactionClient`. The counter row
 * is created at `last_number = 1` on first use, or atomically incremented
 * on conflict — so allocation commits and rolls back WITH the aggregate it
 * numbers (design "Counter updates therefore serialize only the same
 * actor, commit with the aggregate, and roll back with it").
 *
 * MUST run inside an existing `tx` (interactive transaction) — mirrors the
 * same "narrow raw-SQL boundary" precedent as `user-row-lock.ts`.
 *
 * Design references:
 *   design — Technical Approach, Architecture Decisions ("Dedicated
 *     `order_number_counters` and `sub_order_number_counters`... Selected")
 *   design — Data Flow ("allocate consumer number... for each sorted
 *     producer: allocate")
 * Spec: order-public-references §"Actor-scoped allocation"
 */
import { Prisma } from "@prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Atomically allocates the next `Order.orderNumber` for `userId`.
 *
 * A scope's first allocation always returns `1` (spec scenario "New actors
 * begin independently at one"). If the CALLER's transaction later rolls
 * back, this INSERT/UPDATE rolls back with it, permitting a later call to
 * receive the same value (spec scenario "Rolled-back creation may release
 * number").
 *
 * Spec: order-public-references §"Actor-scoped allocation"
 * Design: Technical Approach — allocator SQL
 */
export async function allocateOrderNumber(userId: string, tx: PrismaTx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ last_number: number }>>(
    Prisma.sql`
      INSERT INTO order_number_counters (user_id, last_number)
      VALUES (${userId}, 1)
      ON CONFLICT (user_id) DO UPDATE
      SET last_number = order_number_counters.last_number + 1
      RETURNING last_number
    `,
  );
  return rows[0]!.last_number;
}

/**
 * Atomically allocates the next `SubOrder.subOrderNumber` for `producerId`.
 * Mirrors `allocateOrderNumber` exactly, scoped to
 * `sub_order_number_counters` (design "The producer variant is identical").
 *
 * Spec: order-public-references §"Actor-scoped allocation"
 * Design: Technical Approach — allocator SQL
 */
export async function allocateSubOrderNumber(producerId: string, tx: PrismaTx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ last_number: number }>>(
    Prisma.sql`
      INSERT INTO sub_order_number_counters (producer_id, last_number)
      VALUES (${producerId}, 1)
      ON CONFLICT (producer_id) DO UPDATE
      SET last_number = sub_order_number_counters.last_number + 1
      RETURNING last_number
    `,
  );
  return rows[0]!.last_number;
}
