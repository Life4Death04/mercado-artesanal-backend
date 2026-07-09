/**
 * Onboarding service — consumer and producer onboarding transactions.
 *
 * Both operations require the user to have role === PENDING_ROLE;
 * otherwise RoleAlreadySetError (409) is thrown.
 *
 * Consumer onboarding (completeConsumer):
 *   - Persists firstName + lastName and flips role → CONSUMER.
 *   - Single update; no transaction required (atomic update by PK).
 *
 * Producer onboarding (completeProducer):
 *   - Resolves categorySlug[] against the seeded ProducerCategory catalog.
 *   - Unknown slugs → UnknownCategoryError (422) before any write.
 *   - Creates Producer row (NIF collision → NifAlreadyRegisteredError 409).
 *   - Creates ProducerCategoryOnProducer join rows.
 *   - Flips user role → PRODUCER.
 *   - All persistence in a single Prisma $transaction (R-4 LOCKED).
 *
 * Design references: §11 "Producer onboarding transaction design"
 * Spec references:
 *   user-onboarding — consumer + producer scenarios
 *   producer-bootstrap — NIF uniqueness, category slug resolution, dedupe
 */
import type { User } from "@prisma/client";

import {
  NifAlreadyRegisteredError,
  NotFoundError,
  RoleAlreadySetError,
  UnknownCategoryError,
} from "@/shared/errors/errors";
import * as userRepo from "@/shared/repositories/user.repository";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ConsumerOnboardingInput {
  firstName: string;
  lastName: string;
}

export interface ProducerAddress {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  province: string;
  country?: string;
}

export interface ProducerOnboardingInput {
  firstName: string;
  lastName: string;
  businessName: string;
  nif: string;
  description: string;
  address: ProducerAddress;
  categorySlugs: string[];
}

// ---------------------------------------------------------------------------
// Consumer onboarding
// ---------------------------------------------------------------------------

/**
 * Transition user from PENDING_ROLE → CONSUMER.
 *
 * @param userId - Internal CUID from req.user.id.
 * @param input  - Validated firstName + lastName.
 * @returns Updated User with role = CONSUMER.
 */
export async function completeConsumer(
  userId: string,
  input: ConsumerOnboardingInput,
): Promise<User> {
  // Re-read the user to verify current role (it may have changed since loadUser).
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError("User not found");
  if (user.role !== "PENDING_ROLE") throw new RoleAlreadySetError("User already onboarded");

  return userRepo.completeConsumerOnboarding(userId, {
    firstName: input.firstName,
    lastName: input.lastName,
  });
}

// ---------------------------------------------------------------------------
// Producer onboarding
// ---------------------------------------------------------------------------

/**
 * Transition user from PENDING_ROLE → PRODUCER inside a single $transaction.
 *
 * Steps (design §11):
 *   1. Verify user is PENDING_ROLE.
 *   2. Dedupe slugs, resolve to DB ids — missing slugs → UnknownCategoryError.
 *   3. Create Producer row — NIF collision → NifAlreadyRegisteredError.
 *   4. Create join rows.
 *   5. Flip role to PRODUCER.
 *
 * @param userId - Internal CUID from req.user.id.
 * @param input  - Validated producer onboarding data.
 * @returns Updated User (role = PRODUCER) with embedded producer + categories.
 */
export async function completeProducer(
  userId: string,
  input: ProducerOnboardingInput,
): Promise<User & { producer: NonNullable<unknown> }> {
  // Dedupe slugs before the transaction (cheap, deterministic — design §11).
  const uniqueSlugs = [...new Set(input.categorySlugs)];

  return prisma.$transaction(async (tx) => {
    // 1. Verify user exists and is PENDING_ROLE.
    const user = await userRepo.findById(userId, tx);
    if (!user) throw new NotFoundError("User not found");
    if (user.role !== "PENDING_ROLE") throw new RoleAlreadySetError("User already onboarded");

    // 2. Resolve slugs → category ids. Any missing slug → UnknownCategoryError.
    const categories = await tx.producerCategory.findMany({
      where: { slug: { in: uniqueSlugs } },
    });

    if (categories.length !== uniqueSlugs.length) {
      const foundSlugs = new Set(categories.map((c) => c.slug));
      const missingSlugs = uniqueSlugs.filter((s) => !foundSlugs.has(s));
      throw new UnknownCategoryError(`Unknown category slug(s): ${missingSlugs.join(", ")}`);
    }

    // 3. Create Producer row. Catch Prisma P2002 on NIF unique constraint.
    let producer;
    try {
      producer = await tx.producer.create({
        data: {
          userId,
          businessName: input.businessName,
          nif: input.nif.toUpperCase(),
          description: input.description,
          addressLine1: input.address.line1,
          addressLine2: input.address.line2 ?? null,
          addressCity: input.address.city,
          addressPostalCode: input.address.postalCode,
          addressProvince: input.address.province,
          addressCountry: input.address.country ?? "ES",
        },
      });
    } catch (e: unknown) {
      const prismaError = e as { code?: string; meta?: { target?: string[] } };
      if (
        prismaError.code === "P2002" &&
        prismaError.meta?.target?.some((t) => t.includes("nif"))
      ) {
        throw new NifAlreadyRegisteredError("A producer with this NIF already exists");
      }
      throw e;
    }

    // 4. Create join rows (ProducerCategoryOnProducer).
    await tx.producerCategoryOnProducer.createMany({
      data: categories.map((c) => ({
        producerId: producer.id,
        categoryId: c.id,
      })),
    });

    // 5. Flip role → PRODUCER and return updated user.
    const updatedUser = await userRepo.completeProducerOnboarding(
      userId,
      { firstName: input.firstName, lastName: input.lastName },
      tx,
    );

    // Attach producer to the return value (consumers of this service need the
    // producer shape for the 201 response assembly).
    return { ...updatedUser, producer };
  });
}
