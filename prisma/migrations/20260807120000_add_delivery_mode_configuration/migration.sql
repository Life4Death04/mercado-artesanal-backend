-- Add producer delivery configuration without changing existing rows or order snapshots.
-- Every new column is nullable, and the existing pickup_location column remains available
-- for backward compatibility with previously persisted pickup options.

-- AlterEnum
ALTER TYPE "DeliveryModeType" ADD VALUE 'PERSONAL_DELIVERY';

-- AlterTable
ALTER TABLE "delivery_modes"
ADD COLUMN "carrier_company" TEXT,
ADD COLUMN "notes" TEXT,
ADD COLUMN "pickup_location_name" TEXT,
ADD COLUMN "pickup_street" TEXT,
ADD COLUMN "pickup_municipality" TEXT,
ADD COLUMN "pickup_postal_code" TEXT,
ADD COLUMN "pickup_opening_hours" TEXT;
