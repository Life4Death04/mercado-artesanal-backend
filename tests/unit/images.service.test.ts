/**
 * Unit tests — images.service (Slice 6 TDD, RED phase).
 *
 * Strategy: mock prisma singleton and s3-client wrapper module.
 * The global vi.mock in tests/setup.ts already mocks @aws-sdk/client-s3 and
 * @aws-sdk/s3-request-presigner. Here we also mock @/shared/s3/s3-client so
 * individual tests can program headObject and getPresignedUrl behavior.
 *
 * SDK mock guard (spec: product-images §"Test hygiene — mock the SDK"):
 *   A test verifies the S3Client constructor is a vi.fn() from tests/setup.ts.
 *   If the global mock were absent, S3Client would be the real class and the
 *   guard test would fail — proving the suite enforces the mock.
 *
 * Scenarios covered (specs: product-images):
 *
 * presign:
 *   [U1] Invalid mimeType rejected before any S3 call (IMAGE_UPLOAD_INVALID 400).
 *   [U2] Oversized contentLength rejected before any S3 call (IMAGE_UPLOAD_INVALID 400).
 *   [U3] Cross-producer access returns ProductNotFoundError (404) — owner check.
 *   [U4] Valid request returns { uploadUrl, s3Key, expiresIn } without DB insert.
 *
 * confirm:
 *   [U5] S3 HEAD 404 → IMAGE_UPLOAD_INVALID (400) without inserting DB row.
 *   [U6] s3Key MUST NOT appear in the error detail (PII-safety invariant).
 *   [U7] Prisma P2002 unique violation on (productId, position) → IMAGE_UPLOAD_INVALID (400).
 *   [U8] Valid confirm inserts ProductImage row and returns it.
 *
 * SDK mock guard:
 *   [U-MOCK] S3Client constructor is a vi.fn() — SDK is mocked (not real).
 *
 * Spec references:
 *   product-images  §"Presign endpoint contract", §"Confirm endpoint contract",
 *                   §"Test hygiene — mock the SDK"
 *   error-handling  §"ImageUploadInvalidError never echoes the s3Key"
 *   design          §"S3 image flow", Decision #2 (HEAD 404 → 400, not 404)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement).
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      product: {
        findFirst: vi.fn(),
      },
      productImage: {
        create: vi.fn(),
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock s3-client wrapper so we can control headObject and getPresignedUrl.
// The @aws-sdk/* modules are already mocked globally by tests/setup.ts.
// ---------------------------------------------------------------------------
vi.mock("@/shared/s3/s3-client", () => {
  return {
    getPresignedUrl: vi.fn(),
    headObject: vi.fn(),
  };
});

import { S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@/shared/utils/prisma";
import { getPresignedUrl, headObject } from "@/shared/s3/s3-client";
import { ImageUploadInvalidError, ProductNotFoundError } from "@/shared/errors/errors";
import * as imagesService from "@/modules/images/services/images.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
const mockedGetPresignedUrl = vi.mocked(getPresignedUrl);
const mockedHeadObject = vi.mocked(headObject);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProduct = mockedPrisma.product as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProductImage = mockedPrisma.productImage as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRODUCER_ID = "prod_001";
const PRODUCT_ID = "product_001";
const S3_KEY = "producers/prod_001/products/product_001/img/abc123.jpg";

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
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.resetAllMocks();
  // $transaction: pass the callback through to execute inline
  mockedPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
});

// ---------------------------------------------------------------------------
// [U-MOCK] SDK mock guard
// spec: product-images §"Test hygiene — mock the SDK"
// ---------------------------------------------------------------------------

describe("[U-MOCK] SDK mock guard — S3Client must be mocked", () => {
  it("S3Client constructor is a vi.fn() (global mock from tests/setup.ts is active)", () => {
    // If the global vi.mock('@aws-sdk/client-s3') from tests/setup.ts were absent,
    // S3Client would be the real constructor (not a spy), and this assertion would fail.
    // This proves the mock guard is active for this test file.
    expect(vi.isMockFunction(S3Client)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [U1] presign — invalid mimeType rejected before S3 call
// spec: product-images §"Invalid mimeType rejected before presign"
// ---------------------------------------------------------------------------

describe("[U1] presign — invalid mimeType rejected before any S3 call", () => {
  it("throws IMAGE_UPLOAD_INVALID (400) for mimeType=image/gif without calling S3", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    await expect(
      imagesService.presign(PRODUCER_ID, PRODUCT_ID, {
        mimeType: "image/gif",
        contentLength: 1000,
      }),
    ).rejects.toThrow(ImageUploadInvalidError);

    // S3 must NEVER be called
    expect(mockedGetPresignedUrl).not.toHaveBeenCalled();
  });

  it("the rejected error has code IMAGE_UPLOAD_INVALID and status 400", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    const err = await imagesService
      .presign(PRODUCER_ID, PRODUCT_ID, { mimeType: "image/gif", contentLength: 1000 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImageUploadInvalidError);
    expect((err as ImageUploadInvalidError).code).toBe("IMAGE_UPLOAD_INVALID");
    expect((err as ImageUploadInvalidError).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// [U2] presign — oversized contentLength rejected before S3 call
// spec: product-images §"Oversized upload rejected before presign"
// ---------------------------------------------------------------------------

describe("[U2] presign — oversized contentLength rejected before any S3 call", () => {
  it("throws IMAGE_UPLOAD_INVALID (400) for contentLength > 5 MB", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    await expect(
      imagesService.presign(PRODUCER_ID, PRODUCT_ID, {
        mimeType: "image/jpeg",
        contentLength: 6_000_000,
      }),
    ).rejects.toThrow(ImageUploadInvalidError);

    expect(mockedGetPresignedUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [U3] presign — cross-producer owner check returns ProductNotFoundError
// spec: product-images §"Presign endpoint contract" (producer scoping)
// ---------------------------------------------------------------------------

describe("[U3] presign — cross-producer owner check returns ProductNotFoundError", () => {
  it("throws ProductNotFoundError (404) when product does not belong to producer", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null); // no result for wrong producer

    await expect(
      imagesService.presign("other_producer", PRODUCT_ID, {
        mimeType: "image/jpeg",
        contentLength: 1000,
      }),
    ).rejects.toThrow(ProductNotFoundError);

    expect(mockedGetPresignedUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [U4] presign — valid request returns uploadUrl, s3Key, expiresIn
// spec: product-images §"Presign endpoint contract"
// ---------------------------------------------------------------------------

describe("[U4] presign — valid request returns presigned URL shape", () => {
  it("returns { uploadUrl, s3Key, expiresIn } without inserting any DB row", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedGetPresignedUrl.mockResolvedValueOnce("https://s3.example.com/presigned-url");

    const result = await imagesService.presign(PRODUCER_ID, PRODUCT_ID, {
      mimeType: "image/jpeg",
      contentLength: 100_000,
    });

    expect(result.uploadUrl).toBe("https://s3.example.com/presigned-url");
    expect(typeof result.s3Key).toBe("string");
    expect(result.s3Key.length).toBeGreaterThan(0);
    expect(result.expiresIn).toBe(300);

    // No DB insert should occur
    expect(mockedProductImage.create).not.toHaveBeenCalled();
  });

  it("s3Key is a non-empty opaque string that does not contain the mimeType", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedGetPresignedUrl.mockResolvedValueOnce("https://s3.example.com/presigned-url");

    const result = await imagesService.presign(PRODUCER_ID, PRODUCT_ID, {
      mimeType: "image/png",
      contentLength: 50_000,
    });

    // s3Key is opaque — verify non-empty string and doesn't leak mime info
    expect(typeof result.s3Key).toBe("string");
    expect(result.s3Key).not.toContain("image/png");
    expect(result.s3Key.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// [U5] confirm — S3 HEAD 404 → IMAGE_UPLOAD_INVALID (400)
// spec: product-images §"Confirm without prior S3 object rejected"
// design: Decision #2 (HEAD 404 → 400, not 404)
// ---------------------------------------------------------------------------

describe("[U5] confirm — S3 HEAD 404 maps to IMAGE_UPLOAD_INVALID (400)", () => {
  it("throws IMAGE_UPLOAD_INVALID when headObject throws a NotFound error", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    const notFoundErr = Object.assign(new Error("Not Found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    mockedHeadObject.mockRejectedValueOnce(notFoundErr);

    await expect(
      imagesService.confirm(PRODUCER_ID, PRODUCT_ID, {
        s3Key: "missing/key",
        mimeType: "image/jpeg",
        position: 0,
      }),
    ).rejects.toThrow(ImageUploadInvalidError);

    // No DB row inserted
    expect(mockedProductImage.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [U6] confirm — s3Key MUST NOT appear in error detail
// spec: error-handling §"ImageUploadInvalidError never echoes the s3Key"
// ---------------------------------------------------------------------------

describe("[U6] confirm — s3Key MUST NOT appear in serialized error detail", () => {
  it("the thrown ImageUploadInvalidError detail does not contain the s3Key", async () => {
    const offendingKey = "producers/P1/img/secret-key.jpg";
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());

    const notFoundErr = Object.assign(new Error("Not Found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    mockedHeadObject.mockRejectedValueOnce(notFoundErr);

    const err = await imagesService
      .confirm(PRODUCER_ID, PRODUCT_ID, {
        s3Key: offendingKey,
        mimeType: "image/jpeg",
        position: 0,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImageUploadInvalidError);

    // The error detail (used in serialized response) must NOT contain the s3Key
    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain(offendingKey);
    expect(serialized).not.toContain("producers/P1/img");
    // Also check the detail property directly
    expect((err as ImageUploadInvalidError).detail).not.toContain(offendingKey);
  });
});

// ---------------------------------------------------------------------------
// [U7] confirm — Prisma P2002 (productId, position) → IMAGE_UPLOAD_INVALID (400)
// spec: product-images §"Position unique per product"
// ---------------------------------------------------------------------------

describe("[U7] confirm — Prisma P2002 unique violation maps to IMAGE_UPLOAD_INVALID (400)", () => {
  it("throws IMAGE_UPLOAD_INVALID (400) on duplicate (productId, position)", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedHeadObject.mockResolvedValueOnce(undefined);

    // Simulate Prisma P2002 unique constraint violation
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["product_id", "position"] },
    });
    mockedProductImage.create.mockRejectedValueOnce(p2002);

    await expect(
      imagesService.confirm(PRODUCER_ID, PRODUCT_ID, {
        s3Key: S3_KEY,
        mimeType: "image/jpeg",
        position: 0,
      }),
    ).rejects.toThrow(ImageUploadInvalidError);
  });

  it("the P2002 error detail does not expose column names or s3Key", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedHeadObject.mockResolvedValueOnce(undefined);

    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["product_id", "position"] },
    });
    mockedProductImage.create.mockRejectedValueOnce(p2002);

    const err = await imagesService
      .confirm(PRODUCER_ID, PRODUCT_ID, {
        s3Key: S3_KEY,
        mimeType: "image/jpeg",
        position: 0,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImageUploadInvalidError);

    // Must not leak column names or s3Key
    const detail = (err as ImageUploadInvalidError).detail ?? "";
    expect(detail).not.toContain("product_id");
    expect(detail).not.toContain("position");
    expect(detail).not.toContain(S3_KEY);
  });
});

// ---------------------------------------------------------------------------
// [U8] confirm — valid request inserts ProductImage row and returns it
// spec: product-images §"Confirm endpoint contract"
// ---------------------------------------------------------------------------

describe("[U8] confirm — valid request inserts ProductImage row", () => {
  it("returns the new ProductImage row on success", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makeProduct());
    mockedHeadObject.mockResolvedValueOnce(undefined);

    const newImage = makeProductImage();
    mockedProductImage.create.mockResolvedValueOnce(newImage);

    const result = await imagesService.confirm(PRODUCER_ID, PRODUCT_ID, {
      s3Key: S3_KEY,
      mimeType: "image/jpeg",
      position: 0,
    });

    expect(result).toEqual(newImage);
    expect(mockedProductImage.create).toHaveBeenCalledOnce();
    expect(mockedProductImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: PRODUCT_ID,
          s3Key: S3_KEY,
          mimeType: "image/jpeg",
          position: 0,
        }),
      }),
    );
  });
});
