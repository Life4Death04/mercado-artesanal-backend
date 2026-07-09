/**
 * Onboarding controller — handles POST /users/me/onboarding/consumer|producer.
 *
 * Validates the request body with Zod, extracts req.user.id, delegates to
 * onboarding.service, and serializes the response.
 *
 * Response codes:
 *   Consumer: 200 with updated User (user-onboarding spec §"Consumer onboarding succeeds")
 *   Producer: 201 with updated User + embedded producer (user-onboarding spec §"Producer onboarding succeeds")
 *
 * Auth chain for both routes:
 *   authenticate → loadUser → onboardingGate(allow-listed) → controller
 *
 * Spec reference: user-onboarding §"Consumer onboarding endpoint" + §"Producer onboarding endpoint"
 */
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

import { UnauthorizedError } from "@/shared/errors/errors";
import {
  nonEmptyString,
  spanishNifSchema,
  spanishPostalCodeSchema,
  validateBody,
} from "@/shared/validation/zod";

import * as usersService from "../../users/services/users.service";
import * as onboardingService from "../services/onboarding.service";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Consumer onboarding body schema.
 * Both fields must be non-empty after trim. Extra fields rejected (strict).
 */
const ConsumerOnboardingSchema = z
  .object({
    firstName: nonEmptyString,
    lastName: nonEmptyString,
  })
  .strict();

/**
 * Address sub-schema shared by producer onboarding.
 */
const AddressSchema = z
  .object({
    line1: nonEmptyString,
    line2: z.string().optional(),
    city: nonEmptyString,
    postalCode: spanishPostalCodeSchema,
    province: nonEmptyString,
    country: z.string().length(2).default("ES"),
  })
  .strict();

/**
 * Producer onboarding body schema.
 * categorySlugs must be a non-empty array; duplicates are collapsed in the service.
 * description max 2000 chars (R-4 + producer-bootstrap spec).
 */
const ProducerOnboardingSchema = z
  .object({
    firstName: nonEmptyString,
    lastName: nonEmptyString,
    businessName: nonEmptyString,
    nif: spanishNifSchema,
    description: nonEmptyString.max(2000, "Description must not exceed 2000 characters"),
    address: AddressSchema,
    categorySlugs: z.array(z.string().min(1)).min(1, "At least one category slug is required"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/users/me/onboarding/consumer
 *
 * Validates body, calls completeConsumer service, returns 200 + User profile.
 */
export async function consumer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError("Authentication required");
    }

    const body = validateBody(ConsumerOnboardingSchema, req.body);

    await onboardingService.completeConsumer(req.user.id, body);

    // Fetch the full /me view for the response (user-onboarding spec: "200 with updated User")
    const meView = await usersService.getMe(req.user.id);

    res.status(200).json(meView);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/users/me/onboarding/producer
 *
 * Validates body, calls completeProducer service (transactional), returns 201 + User profile.
 */
export async function producer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError("Authentication required");
    }

    const body = validateBody(ProducerOnboardingSchema, req.body);

    await onboardingService.completeProducer(req.user.id, body);

    // Fetch the full /me view for the response (user-onboarding spec: "201 with updated User")
    const meView = await usersService.getMe(req.user.id);

    res.status(201).json(meView);
  } catch (err) {
    next(err);
  }
}
