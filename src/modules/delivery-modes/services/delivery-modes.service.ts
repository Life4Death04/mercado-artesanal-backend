/**
 * Delivery-modes service — producer-scoped CRUD with delete guard.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as deliveryModesService from "@/modules/delivery-modes/services/delivery-modes.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma.* directly
 * per ADR-003 (architecture/repository-layer-policy).
 *
 * Key invariants:
 *   - create: validates PICKUP+pickupLocation guard BEFORE any DB write.
 *   - findAll: filters by producerId — returns only own delivery modes.
 *   - findById: findFirst({ where: { id, producerId } }) — cross-producer returns 404 (no-leak).
 *   - update: runs inside $transaction; findFirst guard before update; enforces PICKUP invariant
 *       using effective type/pickupLocation (patch fields merged with existing row).
 *   - hardDelete: runs inside $transaction:
 *       1. findFirst guard (404-no-leak on cross-producer)
 *       2. subOrder.count (active status filter: pending, preparing, sent)
 *       3. if count > 0 → ProducerHasActiveOrdersError (409) — reused per design §"Delivery-modes delete guard"
 *       4. if count === 0 → deliveryMode.delete
 *
 * Design references:
 *   design §"Delivery-modes delete guard": reuse ProducerHasActiveOrdersError (409)
 *   design ADR-003: no repositories/ layer
 *   spec delivery-modes §"Producer-scoped CRUD", §"PICKUP without pickupLocation rejected",
 *                        §"Cross-producer read returns 404", §"Delete blocked by active SubOrder reference"
 */
import type { DeliveryMode, DeliveryModeType, SubOrderStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

import { getCartForCheckout } from "@/modules/cart/services/cart.service";
import {
  DeliveryModeNotFoundError,
  ProducerHasActiveOrdersError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type {
  CreateDeliveryModeBody,
  DeliveryModeConsumerView,
  UpdateDeliveryModeBody,
} from "../dto/delivery-modes.dto";
import { mapDeliveryModeConsumerView } from "../dto/delivery-modes.dto";

export interface DeliveryModesForProducerView {
  producerId: string;
  modes: DeliveryModeConsumerView[];
}

// ---------------------------------------------------------------------------
// Active SubOrder statuses for the delete guard
// Spec: delivery-modes §"Delete blocked by active SubOrder reference"
// Design: count SubOrder rows where status IN (pending, preparing, sent)
// ---------------------------------------------------------------------------
const ACTIVE_SUBORDER_STATUSES: SubOrderStatus[] = ["pending", "preparing", "sent"];
const MAX_DELIVERY_MODE_COST = 99_999_999.99;

// ---------------------------------------------------------------------------
// Type-specific configuration normalization — shared by create and update
// ---------------------------------------------------------------------------

type DeliveryConfiguration = Pick<
  DeliveryMode,
  | "coverageZone"
  | "carrierCompany"
  | "notes"
  | "pickupLocation"
  | "pickupLocationName"
  | "pickupStreet"
  | "pickupMunicipality"
  | "pickupPostalCode"
  | "pickupOpeningHours"
>;

function buildCompatibilityPickupLocation(configuration: DeliveryConfiguration): string | null {
  if (!configuration.pickupStreet) {
    return configuration.pickupLocation;
  }

  const municipality = [configuration.pickupPostalCode, configuration.pickupMunicipality]
    .filter(Boolean)
    .join(" ");

  return [configuration.pickupLocationName, configuration.pickupStreet, municipality]
    .filter(Boolean)
    .join(", ");
}

function normalizeConfiguration(
  type: DeliveryModeType,
  configuration: DeliveryConfiguration,
  pickupLocationSource: "derive" | "preserve" = "derive",
): DeliveryConfiguration {
  if (type === "PICKUP") {
    if (!configuration.pickupLocation && !configuration.pickupStreet) {
      throw new ValidationFailedError([
        {
          path: "pickupLocation",
          message: "pickupLocation or pickupStreet is required when type is PICKUP",
        },
      ]);
    }

    return {
      ...configuration,
      coverageZone: null,
      carrierCompany: null,
      pickupLocation:
        pickupLocationSource === "derive"
          ? buildCompatibilityPickupLocation(configuration)
          : configuration.pickupLocation,
    };
  }

  return {
    ...configuration,
    carrierCompany: type === "SHIPPING_FLAT_RATE" ? configuration.carrierCompany : null,
    pickupLocation: null,
    pickupLocationName: null,
    pickupStreet: null,
    pickupMunicipality: null,
    pickupPostalCode: null,
    pickupOpeningHours: null,
  };
}

function configurationFromInput(input: CreateDeliveryModeBody): DeliveryConfiguration {
  return {
    coverageZone: input.coverageZone ?? null,
    carrierCompany: input.carrierCompany ?? null,
    notes: input.notes ?? null,
    pickupLocation: input.pickupLocation ?? null,
    pickupLocationName: input.pickupLocationName ?? null,
    pickupStreet: input.pickupStreet ?? null,
    pickupMunicipality: input.pickupMunicipality ?? null,
    pickupPostalCode: input.pickupPostalCode ?? null,
    pickupOpeningHours: input.pickupOpeningHours ?? null,
  };
}

function mergeConfiguration(
  current: DeliveryConfiguration,
  input: UpdateDeliveryModeBody,
): DeliveryConfiguration {
  return {
    coverageZone: input.coverageZone === undefined ? current.coverageZone : input.coverageZone,
    carrierCompany:
      input.carrierCompany === undefined ? current.carrierCompany : input.carrierCompany,
    notes: input.notes === undefined ? current.notes : input.notes,
    pickupLocation:
      input.pickupLocation === undefined ? current.pickupLocation : input.pickupLocation,
    pickupLocationName:
      input.pickupLocationName === undefined
        ? current.pickupLocationName
        : input.pickupLocationName,
    pickupStreet: input.pickupStreet === undefined ? current.pickupStreet : input.pickupStreet,
    pickupMunicipality:
      input.pickupMunicipality === undefined
        ? current.pickupMunicipality
        : input.pickupMunicipality,
    pickupPostalCode:
      input.pickupPostalCode === undefined ? current.pickupPostalCode : input.pickupPostalCode,
    pickupOpeningHours:
      input.pickupOpeningHours === undefined
        ? current.pickupOpeningHours
        : input.pickupOpeningHours,
  };
}

function ensureValidCost(cost: number): void {
  if (
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > MAX_DELIVERY_MODE_COST ||
    new Decimal(cost).decimalPlaces() > 2
  ) {
    throw new ValidationFailedError([
      {
        path: "cost",
        message:
          "cost must be finite, nonnegative, within Decimal(10,2), and have at most 2 decimals",
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new delivery mode for a producer.
 *
 * PICKUP requires either the legacy location string or a structured street.
 * Structured pickup data also refreshes the compatibility location string.
 *
 * Spec: delivery-modes §"PICKUP without pickupLocation rejected"
 */
export async function create(
  producerId: string,
  input: CreateDeliveryModeBody,
): Promise<DeliveryMode> {
  ensureValidCost(input.cost);
  const configuration = normalizeConfiguration(input.type, configurationFromInput(input));

  return prisma.deliveryMode.create({
    data: {
      producerId,
      type: input.type,
      cost: input.cost,
      ...configuration,
    },
  });
}

// ---------------------------------------------------------------------------
// findAll
// ---------------------------------------------------------------------------

/**
 * List all delivery modes owned by a producer.
 * Returns an empty array if the producer has none.
 *
 * Owner-scoping: filters strictly by `producerId` — a producer NEVER sees
 * another producer's rows. No cross-producer leakage is possible.
 *
 * Spec: delivery-modes §"Producer-scoped CRUD" — list
 */
export async function findAll(producerId: string): Promise<DeliveryMode[]> {
  return prisma.deliveryMode.findMany({
    where: { producerId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Returns active checkout options for each distinct producer in a user's cart.
 * The cart read is intentionally composed through the frozen checkout contract.
 */
export async function findActiveForCartProducers(
  userId: string,
): Promise<DeliveryModesForProducerView[]> {
  const cart = await getCartForCheckout(userId);
  const producerIds = [...new Set(cart.items.map((item) => item.producerId))];

  if (producerIds.length === 0) {
    return [];
  }

  const activeModes = await prisma.deliveryMode.findMany({
    where: { producerId: { in: producerIds }, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  return producerIds.map((producerId) => ({
    producerId,
    modes: activeModes
      .filter((mode) => mode.producerId === producerId && mode.isActive)
      .map(mapDeliveryModeConsumerView),
  }));
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

/**
 * Get a single delivery mode by id, scoped to the producer.
 *
 * Owner-scoping: `findFirst({ where: { id, producerId } })` — cross-producer
 * access returns `DeliveryModeNotFoundError` (404) without revealing that the
 * resource exists for another producer (no-leak pattern).
 *
 * Spec: delivery-modes §"Cross-producer read returns 404"
 */
export async function findById(producerId: string, id: string): Promise<DeliveryMode> {
  const dm = await prisma.deliveryMode.findFirst({
    where: { id, producerId },
  });

  if (!dm) {
    throw new DeliveryModeNotFoundError("Delivery mode not found");
  }

  return dm;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Partially update a delivery mode owned by the producer.
 * Runs inside $transaction: findFirst guard → effective configuration normalization → update.
 * Cross-producer: DeliveryModeNotFoundError (404) — no-leak.
 *
 * Effective values merge the patch with the persisted row. Type-inapplicable
 * fields are cleared and structured pickup data refreshes pickupLocation.
 *
 * Spec: delivery-modes §"Producer-scoped CRUD" — update
 *       delivery-modes §"PICKUP without pickupLocation rejected"
 */
export async function update(
  producerId: string,
  id: string,
  input: UpdateDeliveryModeBody,
): Promise<DeliveryMode> {
  return prisma.$transaction(async (tx) => {
    const dm = await tx.deliveryMode.findFirst({ where: { id, producerId } });

    if (!dm) {
      throw new DeliveryModeNotFoundError("Delivery mode not found");
    }

    const effectiveType = input.type ?? dm.type;
    ensureValidCost(input.cost ?? dm.cost.toNumber());
    const structuredPickupLocationPatched =
      input.pickupLocationName !== undefined ||
      input.pickupStreet !== undefined ||
      input.pickupMunicipality !== undefined ||
      input.pickupPostalCode !== undefined;
    const pickupLocationSource =
      structuredPickupLocationPatched || (dm.type !== "PICKUP" && effectiveType === "PICKUP")
        ? "derive"
        : "preserve";
    const configuration = normalizeConfiguration(
      effectiveType,
      mergeConfiguration(dm, input),
      pickupLocationSource,
    );
    if (dm.type === effectiveType) {
      configuration.coverageZone =
        input.coverageZone === undefined ? dm.coverageZone : configuration.coverageZone;
      configuration.carrierCompany =
        input.carrierCompany === undefined ? dm.carrierCompany : configuration.carrierCompany;
      configuration.notes = input.notes === undefined ? dm.notes : configuration.notes;
      configuration.pickupLocation =
        input.pickupLocation === undefined && !structuredPickupLocationPatched
          ? dm.pickupLocation
          : configuration.pickupLocation;
      configuration.pickupLocationName =
        input.pickupLocationName === undefined
          ? dm.pickupLocationName
          : configuration.pickupLocationName;
      configuration.pickupStreet =
        input.pickupStreet === undefined ? dm.pickupStreet : configuration.pickupStreet;
      configuration.pickupMunicipality =
        input.pickupMunicipality === undefined
          ? dm.pickupMunicipality
          : configuration.pickupMunicipality;
      configuration.pickupPostalCode =
        input.pickupPostalCode === undefined ? dm.pickupPostalCode : configuration.pickupPostalCode;
      configuration.pickupOpeningHours =
        input.pickupOpeningHours === undefined
          ? dm.pickupOpeningHours
          : configuration.pickupOpeningHours;
    }

    return tx.deliveryMode.update({
      where: { id },
      data: {
        ...(input.type !== undefined && { type: input.type }),
        ...(input.cost !== undefined && { cost: input.cost }),
        ...configuration,
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// hardDelete
// ---------------------------------------------------------------------------

/**
 * Hard-delete a delivery mode owned by the producer.
 *
 * Runs inside `$transaction` to avoid TOCTOU:
 *   1. `findFirst({ where: { id, producerId } })` — 404-no-leak on cross-producer access.
 *   2. `subOrder.count({ where: { deliveryModeId: id, status: { in: ACTIVE_SUBORDER_STATUSES } } })`
 *      — counts SubOrders in status `pending | preparing | sent` referencing this delivery mode.
 *   3. If count > 0 → throw `ProducerHasActiveOrdersError` (409, `PRODUCER_HAS_ACTIVE_ORDERS`).
 *      Design decision: reuse the canonical `ProducerHasActiveOrdersError` from
 *      `src/shared/errors/errors.ts` — the guard semantics are identical to the producer
 *      soft-delete guard and the spec only requires 409 without prescribing a new error code.
 *      See design §"Delivery-modes delete guard".
 *   4. If count === 0 → `deliveryMode.delete({ where: { id } })`.
 *
 * Transaction rationale: steps 2–4 must be atomic. Without the transaction,
 * a concurrent SubOrder creation between step 2 (count) and step 4 (delete)
 * could leave an orphaned deliveryModeId FK reference.
 *
 * Spec: delivery-modes §"Delete blocked by active SubOrder reference"
 * Design: §"Delivery-modes delete guard" — reuse ProducerHasActiveOrdersError (canonical)
 */
export async function hardDelete(producerId: string, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Step 1: ownership guard — 404-no-leak
    const dm = await tx.deliveryMode.findFirst({ where: { id, producerId } });

    if (!dm) {
      throw new DeliveryModeNotFoundError("Delivery mode not found");
    }

    // Step 2: count active SubOrders referencing this delivery mode
    const activeCount = await tx.subOrder.count({
      where: {
        deliveryModeId: id,
        status: { in: ACTIVE_SUBORDER_STATUSES },
      },
    });

    // Step 3: block delete if active SubOrders exist
    if (activeCount > 0) {
      throw new ProducerHasActiveOrdersError(
        "Cannot delete delivery mode: it is referenced by one or more active sub-orders",
      );
    }

    // Step 4: hard-delete
    await tx.deliveryMode.delete({ where: { id } });
  });
}
