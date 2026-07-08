/**
 * Addresses controller — thin HTTP layer for address CRUD.
 *
 * Validates request bodies with Zod, extracts req.user.id, delegates to
 * addresses.service, and serializes responses. All domain errors are thrown
 * and caught by the central errorMiddleware (RFC 7807).
 *
 * Response codes:
 *   GET    /users/me/addresses        → 200 array
 *   POST   /users/me/addresses        → 201 created address
 *   PATCH  /users/me/addresses/:id    → 200 updated address
 *   DELETE /users/me/addresses/:id    → 204 No Content
 *
 * Auth chain (design §5):
 *   authenticate → loadUser → onboardingGate → requireRole(CONSUMER|PRODUCER|ADMIN) → controller
 *
 * Spec references:
 *   address-book — wire shape, validation rules, response codes
 *   design §10 — transactional invariant enforcement (owned by service)
 */
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

import { UnauthorizedError } from "@/shared/errors/errors";
import { nonEmptyString, spanishPostalCodeSchema, validateBody } from "@/shared/validation/zod";

import * as addressService from "../services/addresses.service";

// ---------------------------------------------------------------------------
// Zod schemas — address-book spec wire shape
// ---------------------------------------------------------------------------

/**
 * Fields for creating or updating an address.
 * All fields are optional on update (PATCH semantics).
 */
const AddressBaseSchema = z.object({
  line1: nonEmptyString,
  line2: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v): string | null => (v === "" || v === undefined ? null : v)),
  city: nonEmptyString,
  postalCode: spanishPostalCodeSchema,
  province: nonEmptyString,
  country: z.string().length(2).toUpperCase().default("ES"),
  isDefault: z.boolean().optional(),
});

/**
 * Create: all required fields must be present.
 */
const CreateAddressSchema = AddressBaseSchema;

/**
 * Update (PATCH): every field is optional — only provided fields are updated.
 */
const UpdateAddressSchema = AddressBaseSchema.partial();

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/users/me/addresses
 * Returns active addresses for the authenticated user, default-first then newest.
 */
export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError("Authentication required");

    const addresses = await addressService.list(req.user.id);
    res.status(200).json(addresses);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/users/me/addresses
 * Creates a new address. First address is auto-defaulted (P-4).
 * Returns 201 with the created address.
 */
export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError("Authentication required");

    const body = validateBody(CreateAddressSchema, req.body);
    const address = await addressService.create(req.user.id, body);
    res.status(201).json(address);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/users/me/addresses/:id
 * Updates an existing address. 404-no-leak on foreign/deleted addresses.
 * 422 on demotion of current default without promotion.
 * Returns 200 with the updated address.
 */
export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError("Authentication required");

    const { id } = req.params as { id: string };
    const body = validateBody(UpdateAddressSchema, req.body);
    const address = await addressService.update(req.user.id, id, body);
    res.status(200).json(address);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/users/me/addresses/:id
 * Soft-deletes an address. Auto-promotes the newest sibling if deleted was default (O-1).
 * 404-no-leak on foreign/deleted addresses.
 * Returns 204 No Content.
 */
export async function softDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError("Authentication required");

    const { id } = req.params as { id: string };
    await addressService.softDeleteWithPromotion(req.user.id, id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
