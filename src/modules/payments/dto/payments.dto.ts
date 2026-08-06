/**
 * Payments DTO schemas — Zod request validation for POST /pagos/intent
 * (Cycle 5 payments WU1) + the D1 compact-metadata guard.
 *
 * All schemas use strictObject (z.object().strict()) per Cycle 2 policy:
 * unknown keys are rejected with VALIDATION_FAILED (422).
 *
 * `DeliverySelection` is the FROZEN shape already defined by the orders
 * slice (`orders.service.ts`) — payments reuses that type (type-only import)
 * rather than redeclaring an equivalent shape, so the two slices can never
 * silently drift apart.
 *
 * Spec references:
 *   payments §"Intent validates delivery selections" (R2)
 *   design D1 — deliverySelections carry-through via compact PaymentIntent
 *     metadata; <500 chars for MVP cart sizes, <=50 keys.
 */
import { z } from "zod";

import type { DeliverySelection } from "@/modules/orders/services/orders.service";
import { ValidationFailedError } from "@/shared/errors/errors";
import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// POST /pagos/intent — body schema
// ---------------------------------------------------------------------------

/**
 * One delivery selection: a producerId paired with the deliveryModeId the
 * consumer chose for that producer's items. Existence, ownership, and
 * isActive are enforced later against live rows in `payments.service.ts` —
 * this schema only validates SHAPE (non-empty identifiers, no unknown keys).
 */
export const DeliverySelectionSchema = strictObject({
  producerId: z.string().min(1, "producerId is required"),
  deliveryModeId: z.string().min(1, "deliveryModeId is required"),
});

/**
 * Body schema for POST /pagos/intent.
 *   deliverySelections — array of DeliverySelectionSchema (bijection against
 *     the caller's cart is enforced in the service layer, not here — Zod
 *     cannot see the cart).
 *   addressId — ADDITIVE, optional at the schema level (checkout-contracts
 *     BE-3, design Fork 1). The SERVICE (not this schema) enforces it is
 *     required WHEN any selected DeliveryMode.type is SHIPPING_FLAT_RATE,
 *     and ignored for an all-pickup cart — Zod cannot see the resolved
 *     delivery modes. The schema stays `strictObject`: this is a new
 *     optional field, not a shape relaxation.
 */
export const CreatePaymentIntentSchema = strictObject({
  deliverySelections: z.array(DeliverySelectionSchema),
  addressId: z.string().min(1, "addressId must not be empty").optional(),
});

export type CreatePaymentIntentBody = z.infer<typeof CreatePaymentIntentSchema>;

export type PaymentProcessingState = "PROCESSING" | "SUCCEEDED" | "FAILED" | "PENDING" | "CANCELED";

export interface PaymentStatusView {
  state: PaymentProcessingState;
  orderId: string | null;
  code: string;
}

// ---------------------------------------------------------------------------
// D1 — compact deliverySelections metadata guard
// ---------------------------------------------------------------------------

/**
 * Upper bound on the compact JSON length written into PaymentIntent metadata
 * (design D1: "<500 chars for MVP cart sizes"). Stripe's own per-value limit
 * is 500 characters — this guard fails fast BEFORE the Stripe call, with a
 * clear application-level error instead of an opaque Stripe API rejection.
 */
export const MAX_METADATA_DELIVERY_SELECTIONS_LENGTH = 500;

/**
 * Upper bound on the NUMBER of delivery selections carried in metadata
 * (design D1: "<=50 keys"). A cart legitimately spanning more than 50
 * distinct producers is outside the MVP's supported cart shape.
 */
export const MAX_METADATA_DELIVERY_SELECTIONS_COUNT = 50;

/**
 * Serializes `deliverySelections` into the compact JSON string stored in the
 * Stripe PaymentIntent metadata (design D1). Re-derivation at webhook time
 * (WU2/WU3) parses this same string back into `DeliverySelection[]`.
 *
 * Throws `ValidationFailedError` (422) BEFORE any Stripe call when the
 * caller's cart would produce metadata Stripe could reject or that would
 * silently exceed the MVP's supported cart shape.
 *
 * Spec: payments §"Intent validates delivery selections"
 * Design: D1
 */
export function serializeDeliverySelectionsForMetadata(
  selections: DeliverySelection[],
): string {
  if (selections.length > MAX_METADATA_DELIVERY_SELECTIONS_COUNT) {
    throw new ValidationFailedError(
      [
        {
          path: "deliverySelections",
          message: `Too many delivery selections for intent metadata (max ${MAX_METADATA_DELIVERY_SELECTIONS_COUNT})`,
        },
      ],
      "Invalid delivery selections",
    );
  }

  const compact = JSON.stringify(selections);

  if (compact.length > MAX_METADATA_DELIVERY_SELECTIONS_LENGTH) {
    throw new ValidationFailedError(
      [
        {
          path: "deliverySelections",
          message: `deliverySelections metadata exceeds ${MAX_METADATA_DELIVERY_SELECTIONS_LENGTH} characters`,
        },
      ],
      "Invalid delivery selections",
    );
  }

  return compact;
}

/**
 * Parses the compact JSON string written into PaymentIntent metadata by
 * `serializeDeliverySelectionsForMetadata` back into `DeliverySelection[]`
 * (WU3 — the `payment_intent.succeeded` handler re-derives the caller's
 * `deliverySelections` from `event.data.object.metadata.deliverySelections`
 * before delegating to the frozen `createOrderFromPayment`).
 *
 * No shape validation is performed here — the resolved rows are re-validated
 * EXCLUSIVELY against LIVE `DeliveryMode` data inside `createOrderFromPayment`
 * (design Decision 4 step 3a), the same pattern `payments.service.ts`
 * already follows for the intent-creation path. A malformed/unexpected value
 * would surface as `ValidationFailedError` there, not here.
 *
 * Spec: payments §"payment_intent.succeeded creates the order atomically and idempotently"
 * Design: Decision 1 (deliverySelections carry-through)
 *
 * WU3 rework (4R escalation WARNING fix): a malformed metadata string threw
 * a raw `SyntaxError` from `JSON.parse` instead of the module's standard
 * `ValidationFailedError` (422) — wrapped here so a corrupted/tampered
 * PaymentIntent metadata value surfaces through the same error taxonomy as
 * every other rejection this module produces, instead of an unhandled 500.
 */
export function deserializeDeliverySelectionsFromMetadata(compact: string): DeliverySelection[] {
  try {
    return JSON.parse(compact) as DeliverySelection[];
  } catch {
    throw new ValidationFailedError(
      [{ path: "deliverySelections", message: "Malformed deliverySelections metadata" }],
      "Invalid delivery selections",
    );
  }
}
