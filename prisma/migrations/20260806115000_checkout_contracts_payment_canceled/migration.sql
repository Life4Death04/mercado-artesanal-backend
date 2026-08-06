-- checkout-contracts WU3: additive persisted cancellation state.
-- Rollback: PostgreSQL enum values cannot be dropped in place; recreate the
-- enum only after no CANCELED rows remain.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELED';
