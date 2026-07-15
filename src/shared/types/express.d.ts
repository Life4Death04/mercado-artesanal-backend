/**
 * Express Request type augmentation.
 *
 * Declares the two properties that the auth middleware chain populates:
 *   - req.auth   — populated by `authenticate` (express-oauth2-jwt-bearer)
 *   - req.user   — populated by `loadUser` (DB lookup keyed on req.auth.sub)
 *
 * Controllers and services MUST use these typed properties instead of
 * reading req.auth.payload directly (design §8 invariant).
 *
 * Role enum is inlined here to avoid a circular import between this
 * declaration file and the Prisma-generated client. The authoritative
 * source of truth for Role values is prisma/schema.prisma.
 */

// Side-effect import: pulls `qs` type declarations into scope so that
// `Express.Request.query` resolves to `ParsedQs` (Express's own type
// depends on `qs` being loaded in the ambient module graph). The name
// itself is not referenced here, hence the eslint disable.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { ParsedQs } from "qs";

declare global {
  namespace Express {
    interface Request {
      /**
       * Populated by `authenticate` middleware (express-oauth2-jwt-bearer).
       * Contains the decoded JWT payload plus the raw header and token.
       * Available on every authenticated request; undefined on public routes.
       */
      auth?: {
        payload: {
          sub: string;
          email?: string;
          email_verified?: boolean;
          [k: string]: unknown;
        };
        header: unknown;
        token: string;
      };

      /**
       * Populated by `loadUser` middleware (DB lookup by auth.sub).
       * - Defined and non-null: user exists in DB.
       * - null: user has no DB record yet (first call to POST /auth/sync is allowed).
       * - undefined: loadUser has not run (public route or pre-auth middleware).
       *
       * Cycle 2 extension (Decision #8): `producerId` is set when role === 'PRODUCER'
       * and the linked Producer row exists. Producer-scoped services read this field
       * instead of issuing a second DB round-trip per request.
       */
      user?: { id: string; role: string; email: string; producerId?: string } | null;
    }
  }
}

export {};
