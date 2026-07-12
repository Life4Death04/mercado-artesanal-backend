/**
 * Integration tests — images endpoints (Slice 6 TDD, RED phase).
 *
 * Strategy: mock prisma singleton, express-oauth2-jwt-bearer, and s3-client wrapper.
 * The global vi.mock in tests/setup.ts already mocks @aws-sdk/client-s3 and
 * @aws-sdk/s3-request-presigner. We also mock @/shared/s3/s3-client so tests
 * can program headObject and getPresignedUrl without touching real AWS.
 *
 * Tests exercise the full wire contract: routing, middleware chain,
 * request/response serialization, error mapping — without touching a live DB or S3.
 *
 * Scenarios covered (specs: product-images):
 *   [I1]  POST /producers/me/products/:id/images/presign  — 200 presigned URL returned
 *   [I2]  POST /producers/me/products/:id/images/presign  — 400 IMAGE_UPLOAD_INVALID (invalid mime)
 *   [I3]  POST /producers/me/products/:id/images/presign  — 400 IMAGE_UPLOAD_INVALID (oversized)
 *   [I4]  POST /producers/me/products/:id/images/presign  — 404 PRODUCT_NOT_FOUND (cross-producer)
 *   [I5]  POST /producers/me/products/:id/images/presign  — 401 unauthenticated
 *   [I6]  POST /producers/me/products/:id/images/confirm  — 201 ProductImage row returned
 *   [I7]  POST /producers/me/products/:id/images/confirm  — 400 IMAGE_UPLOAD_INVALID (S3 HEAD 404)
 *   [I8]  POST /producers/me/products/:id/images/confirm  — 400 IMAGE_UPLOAD_INVALID (position dup)
 *   [I9]  POST /producers/me/products/:id/images/confirm  — 404 PRODUCT_NOT_FOUND (cross-producer)
 *   [I10] s3Key leak guard — error body MUST NOT contain s3Key substring
 *   [I-MOCK] SDK mock guard — S3Client must be mocked (not real constructor)
 *
 * Spec references:
 *   product-images  §"Presign endpoint contract", §"Confirm endpoint contract",
 *                   §"Test hygiene — mock the SDK"
 *   error-handling  §"ImageUploadInvalidError never echoes the s3Key"
 *   design          §"S3 image flow", Decision #2
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as products.test.ts
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
        const payload = JSON.parse(
          Buffer.from(header, "base64").toString("utf8"),
        ) as Record<string, unknown>;
        req.auth = { payload: payload as never, header: {}, token: "test-token" };
        next();
      } catch {
        next({ status: 401, name: "UnauthorizedError" });
      }
    },
}));

// ---------------------------------------------------------------------------
// Mock: prisma singleton
// loadUser calls prisma.user.findUnique.
// images operations call prisma.product.findFirst and prisma.productImage.create.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      user: { findUnique: vi.fn() },
      product: { findFirst: vi.fn() },
      productImage: { create: vi.fn() },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: s3-client wrapper — controls headObject and getPresignedUrl per-test.
// The underlying @aws-sdk/* modules are already mocked by tests/setup.ts.
// ---------------------------------------------------------------------------
vi.mock("@/shared/s3/s3-client", () => {
  return {
    getPresignedUrl: vi.fn(),
    headObject: vi.fn(),
  };
});

import { S3Client } from "@aws-sdk/client-s3";
import { getPresignedUrl, headObject } from "@/shared/s3/s3-client";
import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProduct = mockedPrisma.product as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProductImage = mockedPrisma.productImage as any;
const mockedGetPresignedUrl = vi.mocked(getPresignedUrl);
const mockedHeadObject = vi.mocked(headObject);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRODUCER_ID = "prod_001";
const PRODUCT_ID = "product_001";
const S3_KEY = "producers/prod_001/products/product_001/img/abc123.jpg";
const UPLOAD_URL = "https://s3.eu-west-1.amazonaws.com/bucket/producers/prod_001/img/abc.jpg";

function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

function makeProducerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "cuid_user_001",
    role: "PRODUCER",
    email: "producer@example.com",
    producerId: PRODUCER_ID,
    ...overrides,
  };
}

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    producerId: PRODUCER_ID,
    name: "Test Product",
    isActive: true,
    deletedAt: null,
    ...overrides,
  };
}

function makeProductImage(overrides: Record<string, unknown> = {}) {
  return {
    id: "img_001",
    productId: PRODUCT_ID,
    s3Key: S3_KEY,
    mimeType: "image/jpeg",
    position: 0,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function mockLoadUser(user: ReturnType<typeof makeProducerUser> | null): void {
  if (!user) {
    mockedUser.findUnique.mockResolvedValueOnce(null);
    return;
  }
  mockedUser.findUnique.mockResolvedValueOnce({
    id: user.id,
    role: user.role,
    email: user.email,
    producer: user.producerId ? { id: user.producerId } : null,
  });
}

// ---------------------------------------------------------------------------
// App + request
// ---------------------------------------------------------------------------

const app = createApp();
const request = supertest(app);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.resetAllMocks();
  // $transaction: execute callback inline (pass prisma as the tx)
  mockedPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
});

// ---------------------------------------------------------------------------
// [I-MOCK] SDK mock guard
// spec: product-images §"Test hygiene — mock the SDK"
// ---------------------------------------------------------------------------

describe("[I-MOCK] SDK mock guard — S3Client must be mocked in integration suite", () => {
  it("S3Client constructor is a vi.fn() (global mock from tests/setup.ts is active)", () => {
    // If @aws-sdk/client-s3 were NOT mocked, S3Client would be the real constructor.
    // vi.isMockFunction() returns false for real constructors.
    // This assertion fails if the mock guard is absent — proving test hygiene.
    expect(vi.isMockFunction(S3Client)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [I1] POST /presign — 200 presigned URL returned
// ---------------------------------------------------------------------------

describe("[I1] POST /producers/me/products/:id/images/presign — 200 success", () => {
  it("returns 200 with { uploadUrl, s3Key, expiresIn } for valid request", async () => {
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedGetPresignedUrl.mockResolvedValueOnce(UPLOAD_URL);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/presign`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ mimeType: "image/jpeg", contentLength: 100_000 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("uploadUrl");
    expect(res.body).toHaveProperty("s3Key");
    expect(res.body).toHaveProperty("expiresIn", 300);
    expect(typeof res.body.uploadUrl).toBe("string");
    expect(res.body.uploadUrl.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// [I2] POST /presign — 400 IMAGE_UPLOAD_INVALID (invalid mimeType)
// spec: product-images §"Invalid mimeType rejected before presign"
// ---------------------------------------------------------------------------

describe("[I2] POST /presign — 400 IMAGE_UPLOAD_INVALID (invalid mimeType)", () => {
  it("returns 400 with code IMAGE_UPLOAD_INVALID for mimeType=image/gif", async () => {
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/presign`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ mimeType: "image/gif", contentLength: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMAGE_UPLOAD_INVALID");
  });
});

// ---------------------------------------------------------------------------
// [I3] POST /presign — 400 IMAGE_UPLOAD_INVALID (oversized contentLength)
// spec: product-images §"Oversized upload rejected before presign"
// ---------------------------------------------------------------------------

describe("[I3] POST /presign — 400 IMAGE_UPLOAD_INVALID (oversized)", () => {
  it("returns 400 with code IMAGE_UPLOAD_INVALID for contentLength > 5 MB", async () => {
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/presign`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ mimeType: "image/jpeg", contentLength: 6_000_000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMAGE_UPLOAD_INVALID");
  });
});

// ---------------------------------------------------------------------------
// [I4] POST /presign — 404 PRODUCT_NOT_FOUND (cross-producer)
// spec: product-images §"Presign endpoint contract" (producer scoping)
// ---------------------------------------------------------------------------

describe("[I4] POST /presign — 404 PRODUCT_NOT_FOUND (cross-producer access)", () => {
  it("returns 404 when product does not belong to the authenticated producer", async () => {
    mockLoadUser(makeProducerUser({ producerId: "other_producer" }));
    mockedProduct.findFirst.mockResolvedValueOnce(null);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/presign`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ mimeType: "image/jpeg", contentLength: 1000 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// [I5] POST /presign — 401 unauthenticated
// ---------------------------------------------------------------------------

describe("[I5] POST /presign — 401 unauthenticated", () => {
  it("returns 401 when no auth header is present", async () => {
    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/presign`)
      .send({ mimeType: "image/jpeg", contentLength: 1000 });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// [I6] POST /confirm — 201 ProductImage row returned
// spec: product-images §"Confirm endpoint contract"
// ---------------------------------------------------------------------------

describe("[I6] POST /confirm — 201 ProductImage created", () => {
  it("returns 201 with the new ProductImage on valid confirm request", async () => {
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedHeadObject.mockResolvedValueOnce(undefined);

    const newImage = makeProductImage();
    mockedProductImage.create.mockResolvedValueOnce(newImage);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/confirm`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ s3Key: S3_KEY, mimeType: "image/jpeg", position: 0 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("productId", PRODUCT_ID);
    expect(res.body).toHaveProperty("s3Key", S3_KEY);
    expect(res.body).toHaveProperty("mimeType", "image/jpeg");
    expect(res.body).toHaveProperty("position", 0);
  });
});

// ---------------------------------------------------------------------------
// [I7] POST /confirm — 400 IMAGE_UPLOAD_INVALID (S3 HEAD 404)
// spec: product-images §"Confirm without prior S3 object rejected"
// design: Decision #2 (HEAD 404 → 400, not 404)
// ---------------------------------------------------------------------------

describe("[I7] POST /confirm — 400 IMAGE_UPLOAD_INVALID (S3 HEAD 404)", () => {
  it("returns 400 with code IMAGE_UPLOAD_INVALID when S3 object does not exist", async () => {
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    const notFoundErr = Object.assign(new Error("Not Found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    mockedHeadObject.mockRejectedValueOnce(notFoundErr);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/confirm`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ s3Key: "missing/key", mimeType: "image/jpeg", position: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMAGE_UPLOAD_INVALID");
  });
});

// ---------------------------------------------------------------------------
// [I8] POST /confirm — 400 IMAGE_UPLOAD_INVALID (position dup)
// spec: product-images §"Position unique per product"
// ---------------------------------------------------------------------------

describe("[I8] POST /confirm — 400 IMAGE_UPLOAD_INVALID (position duplicate)", () => {
  it("returns 400 with code IMAGE_UPLOAD_INVALID on duplicate (productId, position)", async () => {
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedHeadObject.mockResolvedValueOnce(undefined);

    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["product_id", "position"] },
    });
    mockedProductImage.create.mockRejectedValueOnce(p2002);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/confirm`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ s3Key: S3_KEY, mimeType: "image/jpeg", position: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMAGE_UPLOAD_INVALID");
  });
});

// ---------------------------------------------------------------------------
// [I9] POST /confirm — 404 PRODUCT_NOT_FOUND (cross-producer)
// ---------------------------------------------------------------------------

describe("[I9] POST /confirm — 404 PRODUCT_NOT_FOUND (cross-producer)", () => {
  it("returns 404 when confirming for a product not owned by the producer", async () => {
    mockLoadUser(makeProducerUser({ producerId: "other_producer" }));
    mockedProduct.findFirst.mockResolvedValueOnce(null);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/confirm`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ s3Key: S3_KEY, mimeType: "image/jpeg", position: 0 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// [I10] s3Key leak guard — error body MUST NOT contain s3Key substring
// spec: error-handling §"ImageUploadInvalidError never echoes the s3Key"
// ---------------------------------------------------------------------------

describe("[I10] s3Key leak guard — error response body must not contain the s3Key", () => {
  it("400 response body does not contain the offending s3Key for S3 HEAD 404", async () => {
    const secretKey = "producers/P1/img/secret-key-abc.jpg";
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    const notFoundErr = Object.assign(new Error("Not Found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    mockedHeadObject.mockRejectedValueOnce(notFoundErr);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/confirm`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ s3Key: secretKey, mimeType: "image/jpeg", position: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMAGE_UPLOAD_INVALID");

    // The serialized response body must NOT contain the s3Key at any level
    const responseText = JSON.stringify(res.body);
    expect(responseText).not.toContain(secretKey);
    expect(responseText).not.toContain("producers/P1/img");
  });

  it("400 response body does not contain the s3Key for P2002 position duplicate", async () => {
    const secretKey = "producers/P1/img/another-secret.png";
    mockLoadUser(makeProducerUser());
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedHeadObject.mockResolvedValueOnce(undefined);

    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["product_id", "position"] },
    });
    mockedProductImage.create.mockRejectedValueOnce(p2002);

    const res = await request
      .post(`/api/v1/producers/me/products/${PRODUCT_ID}/images/confirm`)
      .set("x-test-auth", authHeader({ sub: "auth0|user001" }))
      .send({ s3Key: secretKey, mimeType: "image/jpeg", position: 0 });

    expect(res.status).toBe(400);
    const responseText = JSON.stringify(res.body);
    expect(responseText).not.toContain(secretKey);
  });
});
