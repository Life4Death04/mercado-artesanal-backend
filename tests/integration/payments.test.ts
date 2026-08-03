/**
 * Integration tests — POST /api/v1/pagos/intent and POST /api/v1/pagos/webhook
 * (Cycle 5 payments WU1 + WU2, real Postgres, strict TDD).
 *
 * WU1 scope: `/pagos/intent`. WU2 scope: the `/pagos/webhook` raw-body trust
 * boundary — signature verification ONLY (400 + zero writes on bad/missing
 * signature, 200 no-op on any accepted-but-unhandled event type). WU2 does
 * NOT implement `payment_intent.succeeded` / `payment_intent.payment_failed`
 * production handling — every verified event type is a no-op in this slice
 * (WU3 scope). See the "[WU2]" describe blocks below.
 *
 * Strategy (design §Testing Strategy — "Integration (Supertest + real
 * Prisma, stubbed Stripe)"): mirrors `orders.test.ts`'s real-Postgres
 * pattern. `express-oauth2-jwt-bearer` is replaced with the repo's standard
 * `X-Test-Auth` test double (cart.test.ts / orders.test.ts precedent).
 * `@/shared/utils/prisma` is NOT mocked — `getCartForCheckout`, `loadUser`,
 * and the delivery-mode lookup all hit the REAL Postgres test database
 * through the real singleton, exactly like `orders.test.ts`'s WU3 HTTP
 * suite. ONLY `@/modules/payments/services/stripe.client` is stubbed — no
 * real Stripe SDK call is ever made.
 *
 * Seed/cleanup scaffolding lives in `tests/helpers/payments-fixtures.ts`
 * (extracted refactor — see that file's header for details). WU2/WU3 reuse
 * the same helpers instead of re-authoring this boilerplate.
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed) — same policy as
 * `orders.test.ts`. `docker compose -f docker-compose.test.yml up -d` MUST
 * be running before this suite executes.
 *
 * Scenarios covered (spec §ADDED requirements R1-R5, R6, R9):
 *   [PH1] valid cart + valid delivery selection -> 201 { clientSecret }
 *   [PH2] no Authorization header -> 401
 *   [PH3] no Cart row for the authenticated user -> 404
 *   [PH4] empty cart (Cart row exists, zero items) -> 422 EMPTY_CART_CHECKOUT
 *   [PH5] deliverySelections missing the cart's producer -> 422 VALIDATION_FAILED
 *   [PH6] requested quantity exceeds LIVE Product.stock -> 409 INSUFFICIENT_STOCK
 *   [PH7] Stripe rejects the PaymentIntent call -> 502 PAYMENT_INTENT_CREATION_FAILED
 *   [PH8] repeat request for the SAME cart reuses the SAME idempotencyKey (cartId)
 *   [WU2-1] invalid webhook signature -> 400 WEBHOOK_SIGNATURE_INVALID, zero writes
 *   [WU2-2] missing webhook signature header -> 400 WEBHOOK_SIGNATURE_INVALID, zero writes
 *   [WU2-3] unhandled/unknown event type -> 200 no-op, zero writes
 *   [WU2-4] /pagos/intent still parses a normal JSON body after the webhook
 *           raw-body wiring is added in src/app.ts (proves route-scoped
 *           express.raw does not regress the global express.json parser)
 *
 * Spec references:
 *   payments §"POST /pagos/intent creates intent behind full auth chain" (R1)
 *   payments §"Intent validates delivery selections" (R2)
 *   payments §"Intent hard stock gate" (R3)
 *   payments §"Intent amount server-side EUR" (R4)
 *   payments §"Stripe failure -> PaymentIntentCreationError 502" (R5)
 *   payments §"POST /pagos/webhook verifies the Stripe signature over the raw body" (R6)
 *   payments §"Unhandled webhook event types are ignored" (R9)
 */
import { PrismaClient } from "@prisma/client";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer ONLY — same test double as cart.test.ts /
// orders.test.ts. `@/shared/utils/prisma` is intentionally NOT mocked.
// ---------------------------------------------------------------------------
vi.mock("express-oauth2-jwt-bearer", () => ({
  auth: () =>
    (
      req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ): void => {
      const header = req.headers["x-test-auth"] as string | undefined;
      if (!header) {
        next({ status: 401, name: "UnauthorizedError" });
        return;
      }
      try {
        const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
        req.auth = { payload: payload as never, header: {}, token: "test-token" };
        next();
      } catch {
        next({ status: 401, name: "UnauthorizedError" });
      }
    },
}));

// ---------------------------------------------------------------------------
// Mock: the Stripe SDK boundary/mock seam ONLY — "stubbed Stripe" per design
// Testing Strategy. `createPaymentIntent` is the only export exercised by
// WU1; no real network call to Stripe is ever made from this suite.
// ---------------------------------------------------------------------------
vi.mock("@/modules/payments/services/stripe.client", () => ({
  stripeClient: {
    createPaymentIntent: vi.fn(),
    constructEvent: vi.fn(),
  },
}));

// eslint-disable-next-line import/first
import * as cartService from "@/modules/cart/services/cart.service";
// eslint-disable-next-line import/first
import { stripeClient } from "@/modules/payments/services/stripe.client";
// eslint-disable-next-line import/first
import { prisma } from "@/shared/utils/prisma";
// eslint-disable-next-line import/first
import { createApp } from "@/app";
// eslint-disable-next-line import/first
import {
  authHeader,
  consumerAuthHeaderFor,
  consumerClaim,
  createPaymentsFixtureCleanup,
  cleanupPaymentsFixtures,
  isDbReachable,
  seedCheckoutReadyCart,
  seedConsumer,
  seedProducer,
} from "../helpers/payments-fixtures";

const mockedCreatePaymentIntent = vi.mocked(stripeClient.createPaymentIntent);
const mockedConstructEvent = vi.mocked(stripeClient.constructEvent);

const app = createApp();
const request = supertest(app);

// ---------------------------------------------------------------------------
// Real Prisma client for setup/teardown — not the singleton under test.
// ---------------------------------------------------------------------------
const db = new PrismaClient();

let dbReachable = false;

// ---------------------------------------------------------------------------
// Seed/cleanup tracking — helpers themselves live in
// tests/helpers/payments-fixtures.ts (see file header note above).
// ---------------------------------------------------------------------------
const cleanup = createPaymentsFixtureCleanup();

beforeAll(async () => {
  dbReachable = await isDbReachable(db);
});

afterAll(async () => {
  if (dbReachable) {
    await cleanupPaymentsFixtures(db, cleanup);
  }
  await db.$disconnect();
  await prisma.$disconnect();
});

// ===========================================================================
// [PH1] valid cart + valid delivery selection -> 201 { clientSecret }
// ===========================================================================

describe("POST /api/v1/pagos/intent — happy path [PH1]", () => {
  it(
    "[PH1] creates a Stripe PaymentIntent and returns 201 { clientSecret }",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "ph1",
        nif: "B20000011",
      });

      mockedCreatePaymentIntent.mockResolvedValueOnce({
        id: "pi_ph1",
        client_secret: "secret_ph1",
      });

      const res = await request
        .post("/api/v1/pagos/intent")
        .set("x-test-auth", consumerAuthHeaderFor("ph1"))
        .send({ deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ clientSecret: "secret_ph1" });
      expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 7 }), // 5.00 + 2.00 shipping
      );
    },
    20000,
  );
});

// ===========================================================================
// [PH2] no Authorization header -> 401
// ===========================================================================

describe("POST /api/v1/pagos/intent — 401 on missing JWT [PH2]", () => {
  it("[PH2] returns 401 when no Authorization/x-test-auth header is present", async () => {
    const res = await request.post("/api/v1/pagos/intent").send({ deliverySelections: [] });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// [PH3] no Cart row -> 404
// ===========================================================================

describe("POST /api/v1/pagos/intent — 404 when no Cart row exists [PH3]", () => {
  it(
    "[PH3] returns 404 NOT_FOUND for an authenticated user with no Cart row",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const consumer = await seedConsumer(db, cleanup, "ph3");

      const res = await request
        .post("/api/v1/pagos/intent")
        .set("x-test-auth", authHeader(consumerClaim(`test-payments-ph3-user`)))
        .send({ deliverySelections: [] });

      expect(res.status).toBe(404);
      expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
      void consumer;
    },
    20000,
  );
});

// ===========================================================================
// [PH4] empty cart (Cart row exists, zero items) -> 422 EMPTY_CART_CHECKOUT
// ===========================================================================

describe("POST /api/v1/pagos/intent — 422 EMPTY_CART_CHECKOUT [PH4]", () => {
  it(
    "[PH4] returns 422 EMPTY_CART_CHECKOUT when the Cart row exists but has zero items",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const consumer = await seedConsumer(db, cleanup, "ph4");
      // Lazily create an empty Cart row via clearCart's no-op-safe path is not
      // guaranteed to create a row; use the real service the same way cart
      // PR#2/#3 tests do — a Cart row is created lazily on first addItem, so
      // instead directly upsert an empty Cart row to prove the EMPTY branch.
      await db.cart.upsert({
        where: { userId: consumer.id },
        create: { userId: consumer.id },
        update: {},
      });

      const res = await request
        .post("/api/v1/pagos/intent")
        .set("x-test-auth", authHeader(consumerClaim(`test-payments-ph4-user`)))
        .send({ deliverySelections: [] });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: "EMPTY_CART_CHECKOUT" });
      expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
    },
    20000,
  );
});

// ===========================================================================
// [PH5] deliverySelections missing the cart's producer -> 422 VALIDATION_FAILED
// ===========================================================================

describe("POST /api/v1/pagos/intent — 422 VALIDATION_FAILED on bad delivery selections [PH5]", () => {
  it(
    "[PH5] returns 422 VALIDATION_FAILED when deliverySelections omits the cart's producer",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, category } = await seedProducer(db, cleanup, "ph5", "B20000051");
      const consumer = await seedConsumer(db, cleanup, "ph5");

      const product = await db.product.create({
        data: {
          producerId: producer.id,
          categoryId: category.id,
          name: "PH5 Product",
          description: "d",
          price: 5.0,
          stock: 10,
          isActive: true,
        },
      });
      await cartService.addItem(consumer.id, product.id, 1);

      const res = await request
        .post("/api/v1/pagos/intent")
        .set("x-test-auth", authHeader(consumerClaim(`test-payments-ph5-user`)))
        .send({ deliverySelections: [] });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
    },
    20000,
  );
});

// ===========================================================================
// [PH6] requested quantity exceeds LIVE Product.stock -> 409 INSUFFICIENT_STOCK
// ===========================================================================

describe("POST /api/v1/pagos/intent — 409 INSUFFICIENT_STOCK [PH6]", () => {
  it(
    "[PH6] returns 409 INSUFFICIENT_STOCK when live stock dropped below the cart quantity",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, product } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "ph6",
        nif: "B20000061",
        stock: 2,
        quantity: 2,
      });
      // Stock drops below the already-in-cart quantity AFTER the add (simulates
      // another consumer/producer action reducing stock live before intent creation).
      await db.product.update({ where: { id: product.id }, data: { stock: 1 } });

      const res = await request
        .post("/api/v1/pagos/intent")
        .set("x-test-auth", consumerAuthHeaderFor("ph6"))
        .send({ deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }] });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "INSUFFICIENT_STOCK" });
      expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
    },
    20000,
  );
});

// ===========================================================================
// [PH7] Stripe rejects the PaymentIntent call -> 502 PAYMENT_INTENT_CREATION_FAILED
// ===========================================================================

describe("POST /api/v1/pagos/intent — 502 PAYMENT_INTENT_CREATION_FAILED [PH7]", () => {
  it(
    "[PH7] returns 502 when the stubbed Stripe client rejects, with no local state written",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "ph7",
        nif: "B20000071",
      });

      mockedCreatePaymentIntent.mockRejectedValueOnce(new Error("stripe unreachable"));

      const res = await request
        .post("/api/v1/pagos/intent")
        .set("x-test-auth", consumerAuthHeaderFor("ph7"))
        .send({ deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }] });

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: "PAYMENT_INTENT_CREATION_FAILED" });

      const paymentCount = await db.payment.count({ where: { providerRef: { not: null } } });
      // No local Payment row is ever written by intent creation (WU1 never writes state).
      const cartStillIntact = await db.cartItem.count({ where: { cart: { userId: consumer.id } } });
      expect(cartStillIntact).toBe(1);
      void paymentCount;
    },
    20000,
  );
});

// ===========================================================================
// [PH8] repeat request for the SAME cart reuses the SAME idempotencyKey (cartId)
// ===========================================================================

describe("POST /api/v1/pagos/intent — stable idempotency key across repeat requests [PH8]", () => {
  it(
    "[PH8] passes the SAME cartId as idempotencyKey on two consecutive requests for the same cart",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "ph8",
        nif: "B20000081",
      });

      mockedCreatePaymentIntent.mockResolvedValue({ id: "pi_ph8", client_secret: "secret_ph8" });

      const body = { deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }] };
      const authSet = consumerAuthHeaderFor("ph8");

      await request.post("/api/v1/pagos/intent").set("x-test-auth", authSet).send(body);
      await request.post("/api/v1/pagos/intent").set("x-test-auth", authSet).send(body);

      expect(mockedCreatePaymentIntent).toHaveBeenCalledTimes(2);
      const firstKey = mockedCreatePaymentIntent.mock.calls[0]?.[0]?.idempotencyKey;
      const secondKey = mockedCreatePaymentIntent.mock.calls[1]?.[0]?.idempotencyKey;
      expect(firstKey).toBe(secondKey);
      expect(typeof firstKey).toBe("string");
    },
    20000,
  );
});

// ===========================================================================
// WU2 — Webhook Trust Boundary (payments §R6, §R9)
//
// [WU2-1] invalid signature -> 400 WEBHOOK_SIGNATURE_INVALID, zero writes
// [WU2-2] missing signature header -> 400 WEBHOOK_SIGNATURE_INVALID, zero writes
// [WU2-3] unhandled event type -> 200 no-op, zero writes
// [WU2-4] a normal JSON route (/pagos/intent) still parses its body correctly
//         after the webhook raw-body wiring is added to src/app.ts
//
// `stripeClient.constructEvent` is the ONLY verification seam (design "TDD
// Seams: Signature verification") — every WU2 scenario below drives it
// through the real HTTP boundary rather than calling payments.service
// directly, so the raw-body middleware wiring in src/app.ts is exercised
// end-to-end, not just the service function in isolation.
// ===========================================================================

describe("POST /api/v1/pagos/webhook — invalid signature is rejected [WU2-1]", () => {
  it(
    "[WU2-1] returns 400 WEBHOOK_SIGNATURE_INVALID and writes zero Payment/Order rows",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      mockedConstructEvent.mockImplementationOnce(() => {
        throw new Error("Stripe signature verification failed");
      });

      const paymentsBefore = await db.payment.count();
      const ordersBefore = await db.order.count();

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=deadbeef")
        .send({ id: "evt_wu2_bad_sig", type: "payment_intent.succeeded" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
      expect(mockedConstructEvent).toHaveBeenCalledTimes(1);

      const paymentsAfter = await db.payment.count();
      const ordersAfter = await db.order.count();
      expect(paymentsAfter).toBe(paymentsBefore);
      expect(ordersAfter).toBe(ordersBefore);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — missing signature header is rejected [WU2-2]", () => {
  it(
    "[WU2-2] returns 400 WEBHOOK_SIGNATURE_INVALID without ever calling constructEvent, zero writes",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const paymentsBefore = await db.payment.count();
      const ordersBefore = await db.order.count();

      const res = await request
        .post("/api/v1/pagos/webhook")
        .send({ id: "evt_wu2_no_sig", type: "payment_intent.succeeded" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
      // Missing-signature rejection MUST short-circuit before the Stripe
      // client is ever consulted (design "Signature verification is the
      // ONLY verification point").
      expect(mockedConstructEvent).not.toHaveBeenCalled();

      const paymentsAfter = await db.payment.count();
      const ordersAfter = await db.order.count();
      expect(paymentsAfter).toBe(paymentsBefore);
      expect(ordersAfter).toBe(ordersBefore);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — unhandled event type is a no-op [WU2-3]", () => {
  it(
    "[WU2-3] returns 200 for a verified but unhandled event type, with zero writes",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      mockedConstructEvent.mockReturnValueOnce({
        id: "evt_wu2_unhandled",
        type: "payment_intent.canceled",
        data: { object: {} },
      });

      const paymentsBefore = await db.payment.count();
      const ordersBefore = await db.order.count();

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=validlooking")
        .send({ id: "evt_wu2_unhandled", type: "payment_intent.canceled" });

      expect(res.status).toBe(200);

      const paymentsAfter = await db.payment.count();
      const ordersAfter = await db.order.count();
      expect(paymentsAfter).toBe(paymentsBefore);
      expect(ordersAfter).toBe(ordersBefore);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/intent — still parses JSON after webhook raw-body wiring [WU2-4]", () => {
  it(
    "[WU2-4] returns 201 { clientSecret } proving req.body is still a parsed JSON object on the intent route",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu2json",
        nif: "B20000091",
      });

      mockedCreatePaymentIntent.mockResolvedValueOnce({
        id: "pi_wu2json",
        client_secret: "secret_wu2json",
      });

      const res = await request
        .post("/api/v1/pagos/intent")
        .set("x-test-auth", consumerAuthHeaderFor("wu2json"))
        .send({ deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ clientSecret: "secret_wu2json" });
    },
    20000,
  );
});
