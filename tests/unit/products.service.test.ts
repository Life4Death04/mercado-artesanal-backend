/**
 * Unit tests — products.service (Slice 3 TDD, RED phase).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * Tests exercise service-level business logic: ownership enforcement,
 * validation branching, active-order guard, report first-wins semantics,
 * and image mapping (Slice 3).
 *
 * Scenarios covered (specs: product-catalog + product-images + product-reporting):
 *
 * create:
 *   - product is created with isActive=true, moderationStatus=OK (publish-on-create)
 *   - throws CategoryNotFoundError when categoryId is inactive or missing
 *
 * findAll (Slice 3 — image mapping):
 *   - maps image rows to { id, position, url } with s3Key absent
 *   - orders images by position ASC (Prisma include.orderBy contract)
 *   - returns images: [] when product has no images
 *   - url is derived via toImageUrl(s3Key)
 *
 * findById:
 *   - returns product when owned by producer and not deleted
 *   - throws ProductNotFoundError when not owned (404-no-leak)
 *   - throws ProductNotFoundError when soft-deleted
 *
 * findById (Slice 3 — image mapping):
 *   - maps image rows to { id, position, url } with s3Key absent
 *   - returns images: [] when product has no images
 *
 * update:
 *   - updates fields when product is owned
 *   - throws ProductNotFoundError when not owned (404-no-leak)
 *   - blocks isActive=false when active OrderLines exist (409)
 *
 * softDelete:
 *   - throws ProductNotFoundError when not owned (404-no-leak)
 *   - throws ProductHasActiveOrdersError when non-terminal OrderLines exist
 *   - soft-deletes (sets deletedAt) when no active orders
 *
 * report:
 *   - sets moderationStatus=REPORTED on first report (OK product)
 *   - is idempotent: returns unchanged row when already REPORTED
 *   - throws ProductNotFoundError when product is REMOVED
 *
 * Spec references:
 *   product-catalog  §"Publish-on-create lifecycle", §"RBAC-scoped ownership",
 *                    §"Soft-delete guard against active order lines",
 *                    §"Reactive-moderation data layer",
 *                    §"Producer product responses include images array"
 *   product-images   §"Wire shape", §"Deterministic ordering",
 *                    §"URL derivation", §"Empty images state"
 *   product-reporting §"Report endpoint", §"Second report is idempotent",
 *                     §"Report on removed product rejected"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      product: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      category: { findFirst: vi.fn() },
      orderLine: { count: vi.fn() },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock image-url utility (Slice 3)
// We let toImageUrl run via the env mock (no spy needed — integration inside unit).
// env is already seeded with S3_PUBLIC_BASE_URL in vitest.config.ts.
// ---------------------------------------------------------------------------

import type { ModerationStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/shared/utils/prisma";
import {
  CategoryNotFoundError,
  ProductHasActiveOrdersError,
  ProductNotFoundError,
} from "@/shared/errors/errors";
import * as productsService from "@/modules/products/services/products.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "product_001",
    producerId: "prod_001",
    categoryId: "cat_001",
    name: "Aceite de Oliva",
    description: "Aceite artesanal.",
    price: new Decimal("12.50"),
    stock: 100,
    lowStockThreshold: 5,
    isActive: true,
    ingredients: null,
    allergens: [],
    weight: null,
    presentation: null,
    reportedAt: null,
    moderationStatus: "OK" as ModerationStatus,
    reportReason: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    // Slice 3: Prisma include returns images array; default to empty for pre-existing tests.
    images: [] as Array<{ id: string; position: number; s3Key: string; createdAt: Date }>,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// create
// ===========================================================================

describe("productsService.create", () => {
  it("creates product with isActive=true, moderationStatus=OK (publish-on-create)", async () => {
    const created = makeProduct();

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          category: { findFirst: vi.fn().mockResolvedValue({ id: "cat_001", isActive: true }) },
          product: { create: vi.fn().mockResolvedValue(created) },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await productsService.create("prod_001", {
      categoryId: "cat_001",
      name: "Aceite de Oliva",
      description: "Aceite artesanal.",
      price: 12.5,
      stock: 100,
    });

    expect(result.isActive).toBe(true);
    expect(result.moderationStatus).toBe("OK");
    expect(result.id).toBe("product_001");
  });

  it("throws CategoryNotFoundError when categoryId does not exist or is inactive", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          category: { findFirst: vi.fn().mockResolvedValue(null) }, // category not found
          product: { create: vi.fn() },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.create("prod_001", {
        categoryId: "cat_unknown",
        name: "Aceite",
        description: "Desc",
        price: 10,
        stock: 0,
      }),
    ).rejects.toThrow(CategoryNotFoundError);
  });
});

// ===========================================================================
// findById
// ===========================================================================

describe("productsService.findById", () => {
  it("returns product when owned by producer and not deleted", async () => {
    const product = makeProduct();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(product);

    const result = await productsService.findById("prod_001", "product_001");

    expect(result.id).toBe("product_001");
    expect(result.producerId).toBe("prod_001");
  });

  it("throws ProductNotFoundError when product belongs to another producer (404-no-leak)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(null);

    await expect(productsService.findById("prod_attacker", "product_001")).rejects.toThrow(
      ProductNotFoundError,
    );
  });
});

// ===========================================================================
// findAll — Slice 3: image mapping
// ===========================================================================

describe("productsService.findAll — image mapping (Slice 3)", () => {
  it("maps image rows to { id, position, url } — s3Key MUST NOT appear in output", async () => {
    const imageRow = {
      id: "img_001",
      position: 0,
      s3Key: "producers/p1/products/prod1/img/abc",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const productWithImages = {
      ...makeProduct(),
      images: [imageRow],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([productWithImages]);

    const results = await productsService.findAll("prod_001");

    expect(results).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const img = results[0]!.images[0]!;

    // Required fields
    expect(img.id).toBe("img_001");
    expect(img.position).toBe(0);
    expect(img.url).toBe("https://test-cdn.example.com/producers/p1/products/prod1/img/abc");

    // s3Key MUST NOT be present
    expect(img).not.toHaveProperty("s3Key");
  });

  it("asserts Prisma include.images orderBy is [{ position: 'asc' }, { createdAt: 'asc' }] (DB-level ordering contract)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAll("prod_001");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.include.images.orderBy).toEqual([
      { position: "asc" },
      { createdAt: "asc" },
    ]);
  });

  it("returns images: [] for a product that has no images", async () => {
    const productNoImages = {
      ...makeProduct(),
      images: [],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([productNoImages]);

    const results = await productsService.findAll("prod_001");

    expect(results).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(results[0]!.images).toEqual([]);
  });

  it("url is derived via toImageUrl: base + key joined with single slash", async () => {
    const imageRow = {
      id: "img_002",
      position: 1,
      s3Key: "/leading/slash/key.jpg",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    };
    const productWithImages = {
      ...makeProduct(),
      images: [imageRow],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([productWithImages]);

    const results = await productsService.findAll("prod_001");

    // Leading slash on key should be stripped → exactly one slash between base and key
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(results[0]!.images[0]!.url).toBe(
      "https://test-cdn.example.com/leading/slash/key.jpg",
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(results[0]!.images[0]!).not.toHaveProperty("s3Key");
  });
});

// ===========================================================================
// findById — Slice 3: image mapping
// ===========================================================================

describe("productsService.findById — image mapping (Slice 3)", () => {
  it("maps image rows to { id, position, url } — s3Key MUST NOT appear in output", async () => {
    const imageRow = {
      id: "img_101",
      position: 2,
      s3Key: "producers/p1/img/xyz.jpg",
      createdAt: new Date("2026-01-05T00:00:00Z"),
    };
    const productWithImages = {
      ...makeProduct(),
      images: [imageRow],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(productWithImages);

    const result = await productsService.findById("prod_001", "product_001");

    expect(result.images).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const img = result.images[0]!;
    expect(img.id).toBe("img_101");
    expect(img.position).toBe(2);
    expect(img.url).toBe("https://test-cdn.example.com/producers/p1/img/xyz.jpg");
    expect(img).not.toHaveProperty("s3Key");
  });

  it("returns images: [] for a product that has no images", async () => {
    const productNoImages = {
      ...makeProduct(),
      images: [],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(productNoImages);

    const result = await productsService.findById("prod_001", "product_001");

    expect(result.images).toEqual([]);
  });
});

// ===========================================================================
// update
// ===========================================================================

describe("productsService.update", () => {
  it("updates product fields when owned by producer", async () => {
    const updated = makeProduct({ name: "Updated Name" });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct()),
            update: vi.fn().mockResolvedValue(updated),
          },
          orderLine: { count: vi.fn().mockResolvedValue(0) },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await productsService.update("prod_001", "product_001", {
      name: "Updated Name",
    });

    expect(result.name).toBe("Updated Name");
  });

  it("throws ProductNotFoundError when product not owned (404-no-leak)", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn(),
          },
          orderLine: { count: vi.fn() },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.update("prod_attacker", "product_001", { name: "Hacked" }),
    ).rejects.toThrow(ProductNotFoundError);
  });

  it("throws ProductHasActiveOrdersError when setting isActive=false with active orders", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct()),
            update: vi.fn(),
          },
          orderLine: { count: vi.fn().mockResolvedValue(2) }, // active orders
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.update("prod_001", "product_001", { isActive: false }),
    ).rejects.toThrow(ProductHasActiveOrdersError);
  });
});

// ===========================================================================
// softDelete
// ===========================================================================

describe("productsService.softDelete", () => {
  it("throws ProductNotFoundError when product does not belong to producer (404-no-leak)", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn(),
          },
          orderLine: { count: vi.fn() },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.softDelete("prod_attacker", "product_001"),
    ).rejects.toThrow(ProductNotFoundError);
  });

  it("throws ProductHasActiveOrdersError when non-terminal OrderLines exist", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct()),
            update: vi.fn(),
          },
          orderLine: {
            count: vi.fn().mockResolvedValue(1), // active order lines
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.softDelete("prod_001", "product_001"),
    ).rejects.toThrow(ProductHasActiveOrdersError);
  });

  it("sets deletedAt and soft-deletes when no active orders", async () => {
    const deletedProduct = makeProduct({ deletedAt: new Date() });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn().mockResolvedValue(deletedProduct);
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct()),
            update: mockUpdate,
          },
          orderLine: {
            count: vi.fn().mockResolvedValue(0),
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        expect(mockUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "product_001" },
            data: expect.objectContaining({ deletedAt: expect.any(Date) }),
          }),
        );
        return res;
      },
    );

    await productsService.softDelete("prod_001", "product_001");
  });
});

// ===========================================================================
// report
// ===========================================================================

describe("productsService.report", () => {
  it("sets moderationStatus=REPORTED on first report (OK product)", async () => {
    const reportedAt = new Date();
    const updated = makeProduct({
      moderationStatus: "REPORTED" as ModerationStatus,
      reportedAt,
      reportReason: "spam",
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct({ moderationStatus: "OK" })),
            update: vi.fn().mockResolvedValue(updated),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await productsService.report("product_001", "spam");

    expect(result.moderationStatus).toBe("REPORTED");
    expect(result.reportedAt).toBeInstanceOf(Date);
    expect(result.reportReason).toBe("spam");
  });

  it("returns existing row unchanged when already REPORTED (idempotent)", async () => {
    const firstReportedAt = new Date("2026-01-10T00:00:00Z");
    const alreadyReported = makeProduct({
      moderationStatus: "REPORTED" as ModerationStatus,
      reportedAt: firstReportedAt,
      reportReason: "spam",
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn();
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(alreadyReported),
            update: mockUpdate,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        // MUST NOT call update for idempotent case
        expect(mockUpdate).not.toHaveBeenCalled();
        return res;
      },
    );

    const result = await productsService.report("product_001", "duplicate");

    expect(result.moderationStatus).toBe("REPORTED");
    expect(result.reportedAt?.getTime()).toBe(firstReportedAt.getTime());
    expect(result.reportReason).toBe("spam"); // first reason preserved
  });

  it("throws ProductNotFoundError when product is REMOVED (treated as invisible)", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(null), // REMOVED products not found
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(productsService.report("product_removed", "spam")).rejects.toThrow(
      ProductNotFoundError,
    );
  });
});
