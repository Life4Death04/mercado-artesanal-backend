/**
 * Users service — GET /users/me profile assembly.
 *
 * Fetches the full User + Producer + categories projection and maps it to
 * the user-profile spec wire shape:
 *
 *   {
 *     id, email, emailVerified, name, firstName, lastName, avatar,
 *     role, onboardingCompleted (computed), producer (null unless PRODUCER),
 *     createdAt, updatedAt
 *   }
 *
 * Invariants enforced:
 *   - onboardingCompleted = role !== "PENDING_ROLE" (MUST NOT be persisted).
 *   - producer field is non-null ONLY when role === "PRODUCER" AND there is
 *     a non-soft-deleted Producer row (J-1, producer-bootstrap spec).
 *   - producer.categorySlugs is derived from the category join rows.
 *
 * Returns null when no User row exists for the given id (404 path).
 *
 * Spec reference: user-profile §"GET /users/me — read current user"
 */
import type { Prisma } from "@prisma/client";

import * as userRepo from "@/shared/repositories/user.repository";

// Shape of the producer sub-object in the response (user-profile spec §GET /users/me).
export interface ProducerView {
  id: string;
  businessName: string;
  nif: string;
  description: string;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    postalCode: string;
    province: string;
    country: string;
  };
  categorySlugs: string[];
}

// Full /users/me response shape.
export interface MeView {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  role: string;
  onboardingCompleted: boolean;
  producer: ProducerView | null;
  createdAt: Date;
  updatedAt: Date;
}

type UserWithProducer = Prisma.UserGetPayload<{
  include: {
    producer: {
      include: { categories: { include: { category: true } } };
    };
  };
}>;

function mapToMeView(user: UserWithProducer): MeView {
  const isProducer = user.role === "PRODUCER";

  let producerView: ProducerView | null = null;

  if (isProducer && user.producer) {
    const p = user.producer;
    producerView = {
      id: p.id,
      businessName: p.businessName,
      nif: p.nif,
      description: p.description,
      address: {
        line1: p.addressLine1,
        line2: p.addressLine2 ?? null,
        city: p.addressCity,
        postalCode: p.addressPostalCode,
        province: p.addressProvince,
        country: p.addressCountry,
      },
      categorySlugs: p.categories.map((link) => link.category.slug),
    };
  }

  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    avatar: user.avatar ?? null,
    role: user.role,
    onboardingCompleted: user.role !== "PENDING_ROLE",
    producer: producerView,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Assemble the /users/me response for the given user id.
 *
 * @param userId - The internal CUID from req.user.id (populated by loadUser).
 * @returns MeView on success, null when no row exists.
 */
export async function getMe(userId: string): Promise<MeView | null> {
  const user = await userRepo.findByIdWithProducer(userId);
  if (!user) return null;
  return mapToMeView(user);
}
