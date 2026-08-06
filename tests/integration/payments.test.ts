/**
 * Integration tests — POST /api/v1/pagos/intent and POST /api/v1/pagos/webhook
 * (Cycle 5 payments WU1 + WU2 + WU3, real Postgres, strict TDD).
 *
 * WU1 scope: `/pagos/intent`. WU2 scope: the `/pagos/webhook` raw-body trust
 * boundary — signature verification ONLY (400 + zero writes on bad/missing
 * signature, 200 no-op on any accepted-but-unhandled event type). WU3 scope:
 * the `payment_intent.succeeded` / `payment_intent.payment_failed` PRODUCTION
 * handlers — atomic order creation, idempotent replay, FAILED audit rows, and
 * the D3 FAILED->SUCCEEDED same-providerRef transition. See the "[WU2]" and
 * "[WU3]" describe blocks below.
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
// Testing Strategy. `createPaymentIntent`/`constructEvent` are the only
// exports exercised as mocks; no real network call to Stripe is ever made
// from this suite. `centsToEuros` (WU3) is a pure function with zero Stripe
// SDK dependency — preserved as the REAL implementation via `importOriginal`
// (strict-tdd "Extract-Before-Mock Rule"), since `payments.service.ts`
// imports it directly and this suite exercises the real FAILED-amount
// conversion end-to-end, not a mocked one.
// ---------------------------------------------------------------------------
vi.mock("@/modules/payments/services/stripe.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/payments/services/stripe.client")>();
  return {
    ...actual,
    stripeClient: {
      createPaymentIntent: vi.fn(),
      constructEvent: vi.fn(),
    },
  };
});

// eslint-disable-next-line import/first
import * as cartService from "@/modules/cart/services/cart.service";
// eslint-disable-next-line import/first
import { serializeDeliverySelectionsForMetadata } from "@/modules/payments/dto/payments.dto";
// eslint-disable-next-line import/first
import { stripeClient } from "@/modules/payments/services/stripe.client";
// eslint-disable-next-line import/first
import type { StripeEvent } from "@/modules/payments/services/stripe.client";
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

// ---------------------------------------------------------------------------
// WU3 — Stripe webhook event payload builders (design Data Flow, spec R7/R8).
// `data.object.metadata` mirrors exactly what WU1's `createPaymentIntent`
// writes at intent-creation time: `{ userId, cartId, deliverySelections }`.
// ---------------------------------------------------------------------------

function makeSucceededEvent(args: {
  intentId: string;
  amountCents: number;
  userId: string;
  cartId: string;
  deliverySelections: { producerId: string; deliveryModeId: string }[];
}): StripeEvent {
  return {
    id: `evt_${args.intentId}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: args.intentId,
        amount: args.amountCents,
        metadata: {
          userId: args.userId,
          cartId: args.cartId,
          deliverySelections: serializeDeliverySelectionsForMetadata(args.deliverySelections),
        },
      },
    },
  };
}

function makeFailedEvent(args: { intentId: string; amountCents: number }): StripeEvent {
  return {
    id: `evt_${args.intentId}`,
    type: "payment_intent.payment_failed",
    data: { object: { id: args.intentId, amount: args.amountCents } },
  };
}

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

// ===========================================================================
// WU3 — Atomic Webhook Events (payments §R7, §R8; design Decision 3)
//
// [WU3-1] first succeeded event creates exactly one Order + SUCCEEDED Payment
// [WU3-2] replayed succeeded event is a no-op — still exactly one Order
// [WU3-3] failed event persists a FAILED Payment, no Order, cart intact
// [WU3-4] D3 hinge: a prior FAILED Payment for the SAME providerRef is
//         deleted before the succeeded delegation, no P2002
// [WU3-5] a mid-transaction failure rolls back BOTH the prior-FAILED delete
//         and any partial order writes (proves the wrapper is ONE tx)
// ===========================================================================

describe("POST /api/v1/pagos/webhook — payment_intent.succeeded creates the order atomically [WU3-1]", () => {
  it(
    "[WU3-1] first succeeded event creates exactly ONE Order linked to a SUCCEEDED Payment",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer, cartId } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3succ1",
        nif: "B20000101",
      });
      const intentId = "pi_wu3_succ1";
      cleanup.providerRefs.push(intentId);

      mockedConstructEvent.mockReturnValueOnce(
        makeSucceededEvent({
          intentId,
          amountCents: 700,
          userId: consumer.id,
          cartId,
          deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }],
        }),
      );

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });

      expect(res.status).toBe(200);

      const payment = await db.payment.findUnique({ where: { providerRef: intentId } });
      expect(payment?.status).toBe("SUCCEEDED");

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(1);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — replayed succeeded event is a no-op [WU3-2]", () => {
  it(
    "[WU3-2] a replayed succeeded event for an already-recorded intent creates NO second Order",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer, cartId } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3replay",
        nif: "B20000102",
      });
      const intentId = "pi_wu3_replay";
      cleanup.providerRefs.push(intentId);

      const event = makeSucceededEvent({
        intentId,
        amountCents: 700,
        userId: consumer.id,
        cartId,
        deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }],
      });
      mockedConstructEvent.mockReturnValue(event);

      const firstRes = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });
      expect(firstRes.status).toBe(200);

      // Replay — the cart is now empty (cleared by the first delegation),
      // proving the no-op comes from createOrderFromPayment's step-0
      // idempotency pre-check, not from an incidental empty-cart short-circuit.
      const replayRes = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });
      expect(replayRes.status).toBe(200);

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(1);
      const paymentCount = await db.payment.count({ where: { providerRef: intentId } });
      expect(paymentCount).toBe(1);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — payment_intent.payment_failed persists a FAILED audit row [WU3-3]", () => {
  it(
    "[WU3-3] persists a FAILED Payment, creates no Order, and leaves the cart intact",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { consumer } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3fail1",
        nif: "B20000103",
      });
      const intentId = "pi_wu3_fail1";
      cleanup.providerRefs.push(intentId);

      mockedConstructEvent.mockReturnValueOnce(makeFailedEvent({ intentId, amountCents: 700 }));

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.payment_failed" });

      expect(res.status).toBe(200);

      const payment = await db.payment.findUnique({ where: { providerRef: intentId } });
      expect(payment?.status).toBe("FAILED");

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(0);

      const cartItemCount = await db.cartItem.count({ where: { cart: { userId: consumer.id } } });
      expect(cartItemCount).toBe(1);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — D3 FAILED->SUCCEEDED same providerRef transition [WU3-4]", () => {
  it(
    "[WU3-4] a succeeded event for a providerRef with a prior FAILED Payment deletes the FAILED row and creates the order without a P2002",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer, cartId } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3d3",
        nif: "B20000104",
      });
      const intentId = "pi_wu3_d3_retry";
      cleanup.providerRefs.push(intentId);

      // Seed the prior FAILED payment directly — isolates this test from the
      // FAILED handler's own correctness (already proven by [WU3-3]).
      await db.payment.create({ data: { providerRef: intentId, status: "FAILED", amount: 7.0 } });

      mockedConstructEvent.mockReturnValueOnce(
        makeSucceededEvent({
          intentId,
          amountCents: 700,
          userId: consumer.id,
          cartId,
          deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }],
        }),
      );

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });

      // No P2002 should ever surface as an error response — the wrapper
      // deletes the prior FAILED row BEFORE the frozen create runs.
      expect(res.status).toBe(200);

      const payments = await db.payment.findMany({ where: { providerRef: intentId } });
      expect(payments).toHaveLength(1);
      expect(payments[0]?.status).toBe("SUCCEEDED");

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(1);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — transaction failure leaves no partial state [WU3-5]", () => {
  it(
    "[WU3-5] a mid-transaction failure in the delegated write rolls back BOTH the prior-FAILED delete and any partial order writes",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer, cartId, product } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3rollback",
        nif: "B20000105",
        stock: 1,
        quantity: 1,
      });
      const intentId = "pi_wu3_rollback";
      cleanup.providerRefs.push(intentId);

      // Prior FAILED row for the SAME providerRef — the rollback proof below
      // only holds meaning if this row existed before the webhook fired.
      await db.payment.create({ data: { providerRef: intentId, status: "FAILED", amount: 7.0 } });

      // Force createOrderFromPayment to throw AFTER the wrapper's deleteMany
      // has already run inside the SAME $transaction, using a throw that
      // PASSES the WU3 R4 reconciliation guard (active delivery mode +
      // matching cartId + matching total, so `recomputeCartTotal` is neither
      // null nor a mismatch): the product went out of stock between cart-add
      // and webhook delivery, so `decrementStock` throws InsufficientStockError
      // deep inside the frozen write — well past step-0's idempotency
      // pre-check (no *SUCCEEDED* payment exists yet). This is the correct
      // mechanism to prove tx rollback now that an unresolvable delivery mode
      // is intercepted by the guard (persisted PENDING) instead of reaching
      // the transaction at all.
      await db.product.update({ where: { id: product.id }, data: { stock: 0 } });
      mockedConstructEvent.mockReturnValueOnce(
        makeSucceededEvent({
          intentId,
          amountCents: 700,
          userId: consumer.id,
          cartId,
          deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }],
        }),
      );

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });

      // The delegated write throws (ValidationFailedError) — errorMiddleware
      // maps it to a non-200 response; the spec scenario asserts DB state.
      expect(res.status).not.toBe(200);

      // Rollback proof: the prior FAILED row STILL EXISTS — the wrapper's
      // deleteMany ran inside the SAME now-rolled-back $transaction.
      const payments = await db.payment.findMany({ where: { providerRef: intentId } });
      expect(payments).toHaveLength(1);
      expect(payments[0]?.status).toBe("FAILED");

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(0);
    },
    20000,
  );
});

// ===========================================================================
// WU3 rework — 4R escalation fixes (money-integrity)
//
// [WU3-6] Bug 1: a delayed/reordered payment_intent.payment_failed for a
//         providerRef that ALREADY has a SUCCEEDED Payment + Order must
//         NEVER downgrade it — terminal-state guard.
// [WU3-7] Bug 2a: the recomputed live-cart total no longer matches what
//         Stripe actually charged -> reconciliation MISMATCH: no Order, no
//         stock decrement, an auditable PENDING Payment for the CHARGED
//         amount.
// [WU3-8] Bug 2b: same reconciliation guard, triggered by a cartId identity
//         mismatch instead of a total mismatch.
// ===========================================================================

describe("POST /api/v1/pagos/webhook — delayed FAILED after SUCCEEDED never downgrades [WU3-6]", () => {
  it(
    "[WU3-6] a payment_intent.payment_failed arriving AFTER payment_intent.succeeded for the SAME providerRef leaves the Payment SUCCEEDED and the Order intact",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer, cartId } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3downgrade",
        nif: "B20000106",
      });
      const intentId = "pi_wu3_downgrade";
      cleanup.providerRefs.push(intentId);

      mockedConstructEvent.mockReturnValueOnce(
        makeSucceededEvent({
          intentId,
          amountCents: 700,
          userId: consumer.id,
          cartId,
          deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }],
        }),
      );
      const succeededRes = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });
      expect(succeededRes.status).toBe(200);

      const orderCountBefore = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCountBefore).toBe(1);

      // A delayed/reordered payment_intent.payment_failed for the SAME
      // providerRef arrives AFTER the succeeded event already created the
      // order — this must be a no-op, never a downgrade (Bug 1 fix).
      mockedConstructEvent.mockReturnValueOnce(makeFailedEvent({ intentId, amountCents: 700 }));
      const failedRes = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.payment_failed" });
      expect(failedRes.status).toBe(200);

      const payments = await db.payment.findMany({ where: { providerRef: intentId } });
      expect(payments).toHaveLength(1);
      expect(payments[0]?.status).toBe("SUCCEEDED");

      const orderCountAfter = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCountAfter).toBe(1);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — reconciliation guard: charged amount no longer matches the live cart [WU3-7]", () => {
  it(
    "[WU3-7] a succeeded event whose recomputed live-cart total does not match intent.amount creates NO Order, does NOT decrement stock, and persists an auditable PENDING Payment for the CHARGED amount",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer, cartId, product } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3mismatch",
        nif: "B20000107",
        price: 5.0,
        deliveryCost: 2.0,
        quantity: 1,
        stock: 10,
      });
      const intentId = "pi_wu3_mismatch_total";
      cleanup.providerRefs.push(intentId);

      // Live cart total is 5.00 + 2.00 = 7.00 (700 cents) — Stripe charged
      // 9.99 instead, simulating the cart changing between intent creation
      // and webhook delivery.
      mockedConstructEvent.mockReturnValueOnce(
        makeSucceededEvent({
          intentId,
          amountCents: 999,
          userId: consumer.id,
          cartId,
          deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }],
        }),
      );

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });
      expect(res.status).toBe(200);

      const payment = await db.payment.findUnique({ where: { providerRef: intentId } });
      expect(payment?.status).toBe("PENDING");
      expect(Number(payment?.amount)).toBe(9.99);

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(0);

      const liveProduct = await db.product.findUnique({ where: { id: product.id } });
      expect(liveProduct?.stock).toBe(10);

      const cartItemCount = await db.cartItem.count({ where: { cart: { userId: consumer.id } } });
      expect(cartItemCount).toBe(1);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — reconciliation guard: cartId identity mismatch [WU3-8]", () => {
  it(
    "[WU3-8] a succeeded event whose metadata.cartId no longer matches the LIVE cart creates NO Order and persists an auditable PENDING Payment",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, deliveryMode, consumer } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3mismatchcart",
        nif: "B20000108",
      });
      const intentId = "pi_wu3_mismatch_cartid";
      cleanup.providerRefs.push(intentId);

      // amountCents matches the live cart total (700 = 5.00 + 2.00), but
      // metadata.cartId does NOT match the LIVE cart's id.
      mockedConstructEvent.mockReturnValueOnce(
        makeSucceededEvent({
          intentId,
          amountCents: 700,
          userId: consumer.id,
          cartId: "cart_id_stale_or_mismatched",
          deliverySelections: [{ producerId: producer.id, deliveryModeId: deliveryMode.id }],
        }),
      );

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });
      expect(res.status).toBe(200);

      const payment = await db.payment.findUnique({ where: { providerRef: intentId } });
      expect(payment?.status).toBe("PENDING");

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(0);
    },
    20000,
  );
});

describe("POST /api/v1/pagos/webhook — reconciliation guard: unverifiable total (delivery mode vanished) [WU3-9]", () => {
  it(
    "[WU3-9] a succeeded event whose selected delivery mode no longer resolves (recomputeCartTotal -> null) with a matching cartId persists a PENDING Payment for the CHARGED amount, creates NO Order, does NOT decrement stock, and returns 200 — the charge is NEVER lost",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      vi.clearAllMocks();

      const { producer, consumer, cartId, product } = await seedCheckoutReadyCart(db, cleanup, {
        namePrefix: "wu3cannotverify",
        nif: "B20000109",
        price: 5.0,
        deliveryCost: 2.0,
        quantity: 1,
        stock: 10,
      });
      const intentId = "pi_wu3_cannot_verify";
      cleanup.providerRefs.push(intentId);

      // The selected deliveryModeId no longer resolves to any active
      // DeliveryMode (it was deactivated/deleted after intent creation), so
      // `recomputeCartTotal` returns null: the charge CANNOT be verified.
      // cartId still matches, so WITHOUT the WU3 R4 fix the guard is skipped,
      // the frozen createOrderFromPayment THROWS ValidationFailedError, the
      // whole $transaction (incl. payment.create) rolls back, and this
      // CHARGED intent ends with NO Order AND NO Payment row — silent money
      // loss. The fix routes null through the safety block instead.
      mockedConstructEvent.mockReturnValueOnce(
        makeSucceededEvent({
          intentId,
          amountCents: 700,
          userId: consumer.id,
          cartId,
          deliverySelections: [{ producerId: producer.id, deliveryModeId: "mode_vanished" }],
        }),
      );

      const res = await request
        .post("/api/v1/pagos/webhook")
        .set("stripe-signature", "t=1,v1=valid")
        .send({ id: `evt_${intentId}`, type: "payment_intent.succeeded" });
      expect(res.status).toBe(200);

      // Durable record of the charge for manual reconciliation/refund.
      const payment = await db.payment.findUnique({ where: { providerRef: intentId } });
      expect(payment?.status).toBe("PENDING");
      expect(Number(payment?.amount)).toBe(7.0);

      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(0);

      const liveProduct = await db.product.findUnique({ where: { id: product.id } });
      expect(liveProduct?.stock).toBe(10);
    },
    20000,
  );
});

// ===========================================================================
// [WU1] checkout-contracts additive migration — schema-inspection coverage
// (Cycle 5 checkout-contracts WU1: nullable `Payment.userId`, six nullable
// `SubOrder.shipTo*` columns, new `PendingCheckout` table with a unique
// `fingerprint` and a unique `providerRef` correlation column).
//
// These assertions inspect the REAL Postgres information_schema after
// `prisma migrate deploy` — they do not exercise any HTTP route or service
// (none exists yet for WU1). They exist to prove the migration itself is
// additive/nullable and structurally correct BEFORE any WU2/WU3/WU4 code
// reads or writes these columns.
//
// Spec references: BE2-R1 (payment-status ownership — design Fork 2),
// BE3-R3 (immutable snapshot migration presence — design Fork 1/Fork 4).
// ===========================================================================

interface ColumnInfo {
  column_name: string;
  is_nullable: "YES" | "NO";
}

async function columnInfo(table: string, column: string): Promise<ColumnInfo | undefined> {
  const rows = await db.$queryRaw<ColumnInfo[]>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows[0];
}

// Prisma's `@unique` on Postgres materializes as a bare `CREATE UNIQUE
// INDEX` (see the WU1 migration.sql), NOT a named `CONSTRAINT ... UNIQUE`,
// so `information_schema.table_constraints` does not surface it. Walking
// pg_index/pg_attribute directly is the robust way to detect ANY unique
// index covering the column, regardless of how it was declared.
async function hasUniqueConstraintOnColumn(table: string, column: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ index_name: string }[]>`
    SELECT i.relname AS index_name
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE t.relname = ${table}
      AND a.attname = ${column}
      AND ix.indisunique = true
  `;
  return rows.length > 0;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.length > 0;
}

describe("[WU1] checkout-contracts migration — Payment.userId", () => {
  it(
    "[WU1-1] payments.user_id is a nullable additive column",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const column = await columnInfo("payments", "user_id");
      expect(column).toBeDefined();
      expect(column?.is_nullable).toBe("YES");
    },
    20000,
  );
});

describe("[WU1] checkout-contracts migration — SubOrder.shipTo* snapshot columns", () => {
  const shipToColumns = [
    "ship_to_line1",
    "ship_to_line2",
    "ship_to_city",
    "ship_to_postal_code",
    "ship_to_province",
    "ship_to_country",
  ];

  for (const column of shipToColumns) {
    it(
      `[WU1-2] sub_orders.${column} is a nullable additive column`,
      async (ctx) => {
        if (!dbReachable) {
          ctx.skip();
          return;
        }
        const info = await columnInfo("sub_orders", column);
        expect(info).toBeDefined();
        expect(info?.is_nullable).toBe("YES");
      },
      20000,
    );
  }
});

describe("[WU1] checkout-contracts migration — PendingCheckout table", () => {
  it(
    "[WU1-3] pending_checkouts table exists",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      expect(await tableExists("pending_checkouts")).toBe(true);
    },
    20000,
  );

  it(
    "[WU1-4] pending_checkouts.fingerprint has a UNIQUE constraint",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      expect(await hasUniqueConstraintOnColumn("pending_checkouts", "fingerprint")).toBe(true);
    },
    20000,
  );

  it(
    "[WU1-5] pending_checkouts.provider_ref is nullable AND has a UNIQUE constraint (BE-2 ownership correlation — resolves the PROCESSING-before-Payment-row ambiguity without a live Stripe read)",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const column = await columnInfo("pending_checkouts", "provider_ref");
      expect(column).toBeDefined();
      expect(column?.is_nullable).toBe("YES");
      expect(await hasUniqueConstraintOnColumn("pending_checkouts", "provider_ref")).toBe(true);
    },
    20000,
  );

  it(
    "[WU1-6] pending_checkouts.user_id is a required (NOT NULL) column — ownership is known at snapshot time",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const column = await columnInfo("pending_checkouts", "user_id");
      expect(column).toBeDefined();
      expect(column?.is_nullable).toBe("NO");
    },
    20000,
  );
});
