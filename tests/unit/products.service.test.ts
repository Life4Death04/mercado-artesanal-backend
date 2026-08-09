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
        updateMany: vi.fn(),
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
  InvalidModerationTransitionError,
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
    // admin-catalog WU1: moderation audit fields — distinct from reportReason (design Decision).
    moderatedBy: null as string | null,
    moderatedAt: null as Date | null,
    moderationReason: null as string | null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    // Slice 3: Prisma include returns images array; default to empty for pre-existing tests.
    images: [] as Array<{ id: string; position: number; s3Key: string; createdAt: Date }>,
    ...overrides,
  };
}

/**
 * Raw public-select Prisma row fixture (public-catalog capability).
 * Shape mirrors PUBLIC_PRODUCT_SELECT — a subset of Product plus nested
 * category/producer selections, NOT the full Product row.
 */
function makePublicProductRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "product_pub_001",
    name: "Miel de Romero",
    description: "Miel artesanal de romero.",
    price: new Decimal("10.00"),
    stock: 20,
    ingredients: null,
    allergens: [],
    weight: null,
    presentation: null,
    categoryId: "cat_001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    images: [] as Array<{ id: string; position: number; s3Key: string; createdAt: Date }>,
    category: { id: "cat_001", slug: "miel", name: "Miel" },
    producer: {
      id: "prod_001",
      businessName: "Apiarios del Sur",
      description: "Productor artesanal.",
      addressCity: "Sevilla",
      addressProvince: "Sevilla",
      addressCountry: "ES",
    },
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
// findAll — Slice 3: image count guarantee [PU-IMG-COUNT-LIST]
// ===========================================================================
// Spec: product-images §"All images returned regardless of count"
// Proves: service returns ALL N images — no implicit take/limit/cap applies.
// Mutation-verify: injecting `take: 5` into include.images makes this test
// fail with "expected 12 to deeply equal 12 → expected Array(5) to have length 12".

describe("productsService.findAll — image count guarantee (Slice 3)", () => {
  it("[PU-IMG-COUNT-LIST] returns ALL images regardless of count — no implicit cap (spec: all images returned)", async () => {
    const N = 12;
    const imageRows = Array.from({ length: N }, (_, i) => ({
      id: `img_count_${i}`,
      position: i,
      s3Key: `producers/p1/img/count_${i}.jpg`,
      createdAt: new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    }));
    const productWithImages = {
      ...makeProduct(),
      images: imageRows,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([productWithImages]);

    const results = await productsService.findAll("prod_001");

    // All N images must be present — no truncation, no cap
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(results[0]!.images).toHaveLength(N);

    // Every input id must be present in the output (identity check, order-agnostic)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const returnedIds = results[0]!.images.map((img) => img.id).sort();
    const expectedIds = imageRows.map((row) => row.id).sort();
    expect(returnedIds).toEqual(expectedIds);
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

  it("[PU-IMG-COUNT-DETAIL] returns ALL images regardless of count — no implicit cap (spec: all images returned)", async () => {
    // Spec: product-images §"All images returned regardless of count"
    // Mutation-verify: injecting `take: 5` into include.images makes this test
    // fail because result.images.length becomes 5, not 12.
    const N = 12;
    const imageRows = Array.from({ length: N }, (_, i) => ({
      id: `img_detail_count_${i}`,
      position: i,
      s3Key: `producers/p1/detail/count_${i}.jpg`,
      createdAt: new Date(`2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    }));
    const productWithImages = {
      ...makeProduct(),
      images: imageRows,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(productWithImages);

    const result = await productsService.findById("prod_001", "product_001");

    // All N images must be present — no truncation, no cap
    expect(result.images).toHaveLength(N);

    // Every input id must appear in the output (identity check, order-agnostic)
    const returnedIds = result.images.map((img) => img.id).sort();
    const expectedIds = imageRows.map((row) => row.id).sort();
    expect(returnedIds).toEqual(expectedIds);
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

// ===========================================================================
// findAllPublic (public-catalog capability)
// Spec: public-catalog §"PUB-R1", §"PUB-R3", §"PUB-R4"
// ===========================================================================

describe("productsService.findAllPublic", () => {
  it("[PUB-R3] applies the four-condition visibility where clause", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({
        deletedAt: null,
        isActive: true,
        moderationStatus: "OK",
        producer: { deletedAt: null },
      }),
    );
  });

  it("[PUB-R1] filters by categoryId when provided", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({ categoryId: "cat_002" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.where.categoryId).toBe("cat_002");
  });

  it("[PUB-R1] omits the categoryId filter when not provided", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.where.categoryId).toBeUndefined();
  });

  it("[PUB-R1] filters stock > 0 when available=true", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({ available: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.where.stock).toEqual({ gt: 0 });
  });

  it("[PUB-R1] does not filter stock when available is absent", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.where.stock).toBeUndefined();
  });

  it("[PUB-R1] orders by price asc when sort=asc", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({ sort: "asc" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ price: "asc" });
  });

  it("[PUB-R1] orders by price desc when sort=desc", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({ sort: "desc" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ price: "desc" });
  });

  it("[PUB-R4] select whitelist exposes producer SAFE fields only — PII excluded", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findAllPublic({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.select.producer.select).toEqual({
      id: true,
      businessName: true,
      description: true,
      addressCity: true,
      addressProvince: true,
      addressCountry: true,
    });
    expect(call.select.producer.select).not.toHaveProperty("nif");
    expect(call.select.producer.select).not.toHaveProperty("userId");
    expect(call.select.producer.select).not.toHaveProperty("addressLine1");
    expect(call.select.producer.select).not.toHaveProperty("addressLine2");
    expect(call.select.producer.select).not.toHaveProperty("addressPostalCode");
    expect(call.select.producer).not.toHaveProperty("include");
  });

  it("[PUB-R4] maps image rows to { id, position, url } — s3Key MUST NOT appear", async () => {
    const row = makePublicProductRow({
      images: [
        { id: "img_1", position: 0, s3Key: "products/x.jpg", createdAt: new Date() },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([row]);

    const results = await productsService.findAllPublic({});

    expect(results[0]!.images).toEqual([
      { id: "img_1", position: 0, url: "https://test-cdn.example.com/products/x.jpg" },
    ]);
    expect(results[0]!.images[0]).not.toHaveProperty("s3Key");
  });

  it("[PUB-R4] returns images: [] for a product with zero ProductImage rows", async () => {
    const row = makePublicProductRow({ images: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([row]);

    const results = await productsService.findAllPublic({});

    expect(results[0]!.images).toEqual([]);
  });

  it("[PUB-R4] maps producer to public-safe nested address shape", async () => {
    const row = makePublicProductRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([row]);

    const results = await productsService.findAllPublic({});

    expect(results[0]!.producer).toEqual({
      id: "prod_001",
      businessName: "Apiarios del Sur",
      description: "Productor artesanal.",
      address: { city: "Sevilla", province: "Sevilla", country: "ES" },
    });
    expect(results[0]!.category).toEqual({ id: "cat_001", slug: "miel", name: "Miel" });
  });
});

// ===========================================================================
// findPublicById (public-catalog capability)
// Spec: public-catalog §"PUB-R2", §"PUB-R3", §"PUB-R4"
// ===========================================================================

describe("productsService.findPublicById", () => {
  it("[PUB-R2,R3] applies id plus the four-condition visibility where clause", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(makePublicProductRow());

    await productsService.findPublicById("product_pub_001");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findFirst.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({
        id: "product_pub_001",
        deletedAt: null,
        isActive: true,
        moderationStatus: "OK",
        producer: { deletedAt: null },
      }),
    );
  });

  it("[PUB-R2] returns the public projection for a visible product", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(makePublicProductRow());

    const result = await productsService.findPublicById("product_pub_001");

    expect(result.id).toBe("product_pub_001");
    expect(result.category).toEqual({ id: "cat_001", slug: "miel", name: "Miel" });
    expect(result.images).toEqual([]);
  });

  it("[PUB-R2,R3] throws ProductNotFoundError (404-no-leak) when hidden or missing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(null);

    await expect(productsService.findPublicById("product_hidden")).rejects.toThrow(
      ProductNotFoundError,
    );
  });
});

// ===========================================================================
// moderate (admin-catalog capability — WU1, Phase 1: Moderation Foundation)
//
// Spec: admin-catalog §"Reversible audited moderation"
//   - remove:   REPORTED → REMOVED
//   - dismiss:  REPORTED → OK
//   - restore:  REMOVED  → OK
//   - Success MUST persist moderatedBy/moderatedAt/moderationReason, separate
//     from reportReason.
//   - Unsupported transition MUST be rejected WITHOUT changing status/audit data.
//
// Design: read-then-conditional-`updateMany` atomic guard — mirrors the exact
// pattern in orders.service.ts::cancelOrder (validate via an action table,
// then a conditional write constrained by the expected FROM status; zero
// updated rows means a race occurred and the call fails closed).
// ===========================================================================

describe("productsService.moderate", () => {
  it("[remove] transitions REPORTED→REMOVED and persists moderatedBy/moderatedAt/moderationReason", async () => {
    const reported = makeProduct({
      moderationStatus: "REPORTED" as ModerationStatus,
      reportReason: "spam",
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(reported),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await productsService.moderate(
      "product_001",
      "admin_001",
      "remove",
      "policy violation",
    );

    expect(result.moderationStatus).toBe("REMOVED");
    expect(result.moderatedBy).toBe("admin_001");
    expect(result.moderatedAt).toBeInstanceOf(Date);
    expect(result.moderationReason).toBe("policy violation");
    // reportReason MUST remain untouched — distinct from moderation audit data.
    expect(result.reportReason).toBe("spam");
  });

  it("[dismiss] transitions REPORTED→OK and persists audit fields", async () => {
    const reported = makeProduct({
      moderationStatus: "REPORTED" as ModerationStatus,
      reportReason: "spam",
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(reported),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await productsService.moderate(
      "product_001",
      "admin_002",
      "dismiss",
      "false positive",
    );

    expect(result.moderationStatus).toBe("OK");
    expect(result.moderatedBy).toBe("admin_002");
    expect(result.moderatedAt).toBeInstanceOf(Date);
    expect(result.moderationReason).toBe("false positive");
  });

  it("[restore] transitions REMOVED→OK and persists audit fields", async () => {
    const removed = makeProduct({
      moderationStatus: "REMOVED" as ModerationStatus,
      moderatedBy: "admin_001",
      moderatedAt: new Date("2026-01-05T00:00:00Z"),
      moderationReason: "policy violation",
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(removed),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await productsService.moderate(
      "product_001",
      "admin_003",
      "restore",
      "appeal accepted",
    );

    expect(result.moderationStatus).toBe("OK");
    expect(result.moderatedBy).toBe("admin_003");
    expect(result.moderatedAt).toBeInstanceOf(Date);
    expect(result.moderationReason).toBe("appeal accepted");
  });

  it("throws InvalidModerationTransitionError when action does not match current state (remove on OK product)", async () => {
    const okProduct = makeProduct({ moderationStatus: "OK" as ModerationStatus });
    const mockUpdateMany = vi.fn();

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(okProduct),
            updateMany: mockUpdateMany,
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.moderate("product_001", "admin_001", "remove", "policy violation"),
    ).rejects.toThrow(InvalidModerationTransitionError);

    // Fails fast on the pre-check — no write is even attempted.
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("throws InvalidModerationTransitionError when restore is requested on an OK product", async () => {
    const okProduct = makeProduct({ moderationStatus: "OK" as ModerationStatus });
    const mockUpdateMany = vi.fn();

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(okProduct),
            updateMany: mockUpdateMany,
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.moderate("product_001", "admin_001", "restore", "n/a"),
    ).rejects.toThrow(InvalidModerationTransitionError);

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("throws InvalidModerationTransitionError on a raced transition (updateMany count=0) — no second write is attempted", async () => {
    const reported = makeProduct({ moderationStatus: "REPORTED" as ModerationStatus });
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(reported),
            updateMany: mockUpdateMany,
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.moderate("product_001", "admin_001", "dismiss", "false positive"),
    ).rejects.toThrow(InvalidModerationTransitionError);

    // Exactly one conditional write attempted — the race is detected, not retried blindly.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("[mutation-verify] updateMany is constrained by the expected FROM status (conditional write prevents lost updates)", async () => {
    const reported = makeProduct({ moderationStatus: "REPORTED" as ModerationStatus });
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(reported),
            updateMany: mockUpdateMany,
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await productsService.moderate("product_001", "admin_001", "remove", "policy violation");

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "product_001", moderationStatus: "REPORTED" }),
        data: expect.objectContaining({
          moderationStatus: "REMOVED",
          moderatedBy: "admin_001",
          moderationReason: "policy violation",
        }),
      }),
    );
  });

  it("throws ProductNotFoundError when the product does not exist", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(null),
            updateMany: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      productsService.moderate("product_missing", "admin_001", "remove", "policy violation"),
    ).rejects.toThrow(ProductNotFoundError);
  });
});

// ===========================================================================
// findModerationQueue (admin-catalog capability — WU1)
// Spec: admin-catalog §"Moderation queue and detail" — "Reported queue is filtered"
// ===========================================================================

describe("productsService.findModerationQueue", () => {
  it("[Reported queue is filtered] filters by the requested moderationStatus", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findModerationQueue("REPORTED" as ModerationStatus);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.where.moderationStatus).toBe("REPORTED");
  });

  it("[Reported queue is filtered] maps rows to producer identity + report/audit fields", async () => {
    const row = {
      id: "product_reported_1",
      name: "Queso Curado",
      description: "Queso artesanal.",
      price: new Decimal("8.00"),
      stock: 15,
      moderationStatus: "REPORTED" as ModerationStatus,
      reportedAt: new Date("2026-02-01T00:00:00Z"),
      reportReason: "counterfeit",
      moderatedBy: null,
      moderatedAt: null,
      moderationReason: null,
      producer: { id: "prod_009", businessName: "Quesería del Valle" },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([row]);

    const results = await productsService.findModerationQueue("REPORTED" as ModerationStatus);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        id: "product_reported_1",
        moderationStatus: "REPORTED",
        reportReason: "counterfeit",
        producer: { id: "prod_009", businessName: "Quesería del Valle" },
      }),
    );
  });

  it("[select whitelist] producer projection excludes PII fields (nif, userId, address lines)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findMany.mockResolvedValueOnce([]);

    await productsService.findModerationQueue("REPORTED" as ModerationStatus);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockedPrisma.product as any).findMany.mock.calls[0][0];
    expect(call.select.producer.select).toEqual({ id: true, businessName: true });
    expect(call.select.producer.select).not.toHaveProperty("nif");
    expect(call.select.producer.select).not.toHaveProperty("userId");
    expect(call.select.producer.select).not.toHaveProperty("addressLine1");
  });
});

// ===========================================================================
// findAdminProductById (admin-catalog capability — WU1)
// Spec: admin-catalog §"Moderation queue and detail"
// ===========================================================================

describe("productsService.findAdminProductById", () => {
  it("returns moderation/detail projection with producer identity, report and audit fields", async () => {
    const row = {
      id: "product_001",
      name: "Aceite de Oliva",
      description: "Aceite artesanal.",
      price: new Decimal("12.50"),
      stock: 100,
      moderationStatus: "REMOVED" as ModerationStatus,
      reportedAt: new Date("2026-02-01T00:00:00Z"),
      reportReason: "spam",
      moderatedBy: "admin_001",
      moderatedAt: new Date("2026-02-02T00:00:00Z"),
      moderationReason: "policy violation",
      producer: { id: "prod_001", businessName: "Apiarios del Sur" },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(row);

    const result = await productsService.findAdminProductById("product_001");

    expect(result.reportReason).toBe("spam");
    expect(result.moderatedBy).toBe("admin_001");
    expect(result.moderationReason).toBe("policy violation");
    expect(result.producer).toEqual({ id: "prod_001", businessName: "Apiarios del Sur" });
  });

  it("throws ProductNotFoundError when the product does not exist", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.product as any).findFirst.mockResolvedValueOnce(null);

    await expect(productsService.findAdminProductById("product_missing")).rejects.toThrow(
      ProductNotFoundError,
    );
  });
});
