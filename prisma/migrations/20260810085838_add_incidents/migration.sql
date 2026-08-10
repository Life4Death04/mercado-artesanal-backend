-- Add the Incident audit aggregate (admin-incidents WU1).
-- Additive-only migration: no backfill, no uniqueness on sub_order_id
-- (multiple reports against the same sub-order are not prohibited).
-- All four FKs use RESTRICT: incidents are audits and MUST NOT disappear
-- or lose actors/targets when a parent row is removed.

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "sub_order_id" TEXT NOT NULL,
    "producer_id" TEXT NOT NULL,
    "report_reason" VARCHAR(2000) NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_by_id" TEXT,
    "resolution_reason" VARCHAR(2000),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_reporter_id_created_at_id_idx" ON "incidents"("reporter_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "incidents_created_at_id_idx" ON "incidents"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "incidents_sub_order_id_idx" ON "incidents"("sub_order_id");

-- CreateIndex
CREATE INDEX "incidents_producer_id_idx" ON "incidents"("producer_id");

-- CreateIndex
CREATE INDEX "incidents_resolved_by_id_idx" ON "incidents"("resolved_by_id");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_sub_order_id_fkey" FOREIGN KEY ("sub_order_id") REFERENCES "sub_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_producer_id_fkey" FOREIGN KEY ("producer_id") REFERENCES "producers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
