/**
 * Unit tests — Cycle 2 AppError subclasses (TDD — RED phase)
 *
 * Spec reference:
 *   error-handling §"New Cycle 2 AppError subclasses"
 *   error-handling §"Subclass exported and typed"
 *   error-handling §"ImageUploadInvalidError never echoes the s3Key"
 *
 * Covers all 8 new subclasses introduced in Cycle 2:
 *   ProductNotFoundError       404  PRODUCT_NOT_FOUND
 *   InsufficientStockError     409  INSUFFICIENT_STOCK
 *   ProductHasActiveOrdersError 409  PRODUCT_HAS_ACTIVE_ORDERS
 *   ProducerHasActiveOrdersError 409  PRODUCER_HAS_ACTIVE_ORDERS
 *   InvalidOrderTransitionError 409  INVALID_ORDER_TRANSITION
 *   DeliveryModeNotFoundError  404  DELIVERY_MODE_NOT_FOUND
 *   ImageUploadInvalidError    400  IMAGE_UPLOAD_INVALID
 *   CategoryNotFoundError      404  CATEGORY_NOT_FOUND
 */
import { describe, expect, it } from "vitest";

import {
  CategoryNotFoundError,
  DeliveryModeNotFoundError,
  ImageUploadInvalidError,
  InsufficientStockError,
  InvalidOrderTransitionError,
  ProductHasActiveOrdersError,
  ProductNotFoundError,
  ProducerHasActiveOrdersError,
} from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// ProductNotFoundError — 404 PRODUCT_NOT_FOUND
// ---------------------------------------------------------------------------

describe("ProductNotFoundError", () => {
  it("carries code PRODUCT_NOT_FOUND, status 404, and correct title", () => {
    const err = new ProductNotFoundError("Product not found");

    expect(err.code).toBe("PRODUCT_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.title).toBe("Product not found");
    expect(err.typeSlug).toBe("/errors/product-not-found");
  });

  it("is an instance of Error (instanceof check works across targets)", () => {
    const err = new ProductNotFoundError("missing");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProductNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// InsufficientStockError — 409 INSUFFICIENT_STOCK
// ---------------------------------------------------------------------------

describe("InsufficientStockError", () => {
  it("carries code INSUFFICIENT_STOCK, status 409, and correct title", () => {
    const err = new InsufficientStockError("Insufficient stock");

    expect(err.code).toBe("INSUFFICIENT_STOCK");
    expect(err.status).toBe(409);
    expect(err.title).toBe("Insufficient stock");
    expect(err.typeSlug).toBe("/errors/insufficient-stock");
  });

  it("round-trips as per spec scenario: 409 with code and type slug", () => {
    // Spec scenario: "New Cycle 2 error round-trips"
    // GIVEN a service throws new InsufficientStockError()
    // THEN status MUST be 409 and code MUST be "INSUFFICIENT_STOCK"
    const err = new InsufficientStockError("Not enough units");
    expect(err.status).toBe(409);
    expect(err.code).toBe("INSUFFICIENT_STOCK");
    expect(err.typeSlug).toBe("/errors/insufficient-stock");
  });
});

// ---------------------------------------------------------------------------
// ProductHasActiveOrdersError — 409 PRODUCT_HAS_ACTIVE_ORDERS
// ---------------------------------------------------------------------------

describe("ProductHasActiveOrdersError", () => {
  it("carries code PRODUCT_HAS_ACTIVE_ORDERS, status 409, and correct title", () => {
    const err = new ProductHasActiveOrdersError("Product has active orders");

    expect(err.code).toBe("PRODUCT_HAS_ACTIVE_ORDERS");
    expect(err.status).toBe(409);
    expect(err.title).toBe("Product has active orders");
    expect(err.typeSlug).toBe("/errors/product-has-active-orders");
  });

  it("is an instance of Error", () => {
    expect(new ProductHasActiveOrdersError("x")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// ProducerHasActiveOrdersError — 409 PRODUCER_HAS_ACTIVE_ORDERS
// ---------------------------------------------------------------------------

describe("ProducerHasActiveOrdersError", () => {
  it("carries code PRODUCER_HAS_ACTIVE_ORDERS, status 409, and correct title", () => {
    const err = new ProducerHasActiveOrdersError("Producer has active orders");

    expect(err.code).toBe("PRODUCER_HAS_ACTIVE_ORDERS");
    expect(err.status).toBe(409);
    expect(err.title).toBe("Producer has active orders");
    expect(err.typeSlug).toBe("/errors/producer-has-active-orders");
  });

  it("is an instance of Error", () => {
    expect(new ProducerHasActiveOrdersError("x")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// InvalidOrderTransitionError — 409 INVALID_ORDER_TRANSITION
// ---------------------------------------------------------------------------

describe("InvalidOrderTransitionError", () => {
  it("carries code INVALID_ORDER_TRANSITION, status 409, and correct title", () => {
    const err = new InvalidOrderTransitionError("Invalid order transition");

    expect(err.code).toBe("INVALID_ORDER_TRANSITION");
    expect(err.status).toBe(409);
    expect(err.title).toBe("Invalid order transition");
    expect(err.typeSlug).toBe("/errors/invalid-order-transition");
  });

  it("is an instance of Error", () => {
    expect(new InvalidOrderTransitionError("x")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// DeliveryModeNotFoundError — 404 DELIVERY_MODE_NOT_FOUND
// ---------------------------------------------------------------------------

describe("DeliveryModeNotFoundError", () => {
  it("carries code DELIVERY_MODE_NOT_FOUND, status 404, and correct title", () => {
    const err = new DeliveryModeNotFoundError("Delivery mode not found");

    expect(err.code).toBe("DELIVERY_MODE_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.title).toBe("Delivery mode not found");
    expect(err.typeSlug).toBe("/errors/delivery-mode-not-found");
  });

  it("is an instance of Error", () => {
    expect(new DeliveryModeNotFoundError("x")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// ImageUploadInvalidError — 400 IMAGE_UPLOAD_INVALID
// ---------------------------------------------------------------------------

describe("ImageUploadInvalidError", () => {
  it("carries code IMAGE_UPLOAD_INVALID, status 400, and correct title", () => {
    const err = new ImageUploadInvalidError("Image upload invalid");

    expect(err.code).toBe("IMAGE_UPLOAD_INVALID");
    expect(err.status).toBe(400);
    expect(err.title).toBe("Image upload invalid");
    expect(err.typeSlug).toBe("/errors/image-upload-invalid");
  });

  it("detail MUST NOT echo s3Key (spec: ImageUploadInvalidError never echoes the s3Key)", () => {
    // Spec scenario: "ImageUploadInvalidError never echoes the s3Key"
    // GIVEN a presign request with mimeType "image/gif" and s3Key "producers/P1/img/x.gif"
    // THEN the 400 response body MUST NOT contain the s3Key substring
    const s3Key = "producers/P1/img/x.gif";
    const err = new ImageUploadInvalidError("Unsupported mime type");

    // The detail MUST NOT contain the s3Key — PII-safety rule
    expect(err.detail).not.toContain(s3Key);
    expect(err.detail).not.toContain("producers/");
    expect(err.detail).not.toContain(".gif");
  });

  it("is an instance of Error", () => {
    expect(new ImageUploadInvalidError("x")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// CategoryNotFoundError — 404 CATEGORY_NOT_FOUND
// ---------------------------------------------------------------------------

describe("CategoryNotFoundError", () => {
  it("carries code CATEGORY_NOT_FOUND, status 404, and correct title", () => {
    const err = new CategoryNotFoundError("Category not found");

    expect(err.code).toBe("CATEGORY_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.title).toBe("Category not found");
    expect(err.typeSlug).toBe("/errors/category-not-found");
  });

  it("is an instance of Error", () => {
    expect(new CategoryNotFoundError("x")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Triangulation — all subclasses share typeSlug derivation invariant
// ---------------------------------------------------------------------------

describe("Cycle 2 subclasses — typeSlug derivation invariant", () => {
  it.each([
    [new ProductNotFoundError("x"), "/errors/product-not-found"],
    [new InsufficientStockError("x"), "/errors/insufficient-stock"],
    [new ProductHasActiveOrdersError("x"), "/errors/product-has-active-orders"],
    [new ProducerHasActiveOrdersError("x"), "/errors/producer-has-active-orders"],
    [new InvalidOrderTransitionError("x"), "/errors/invalid-order-transition"],
    [new DeliveryModeNotFoundError("x"), "/errors/delivery-mode-not-found"],
    [new ImageUploadInvalidError("x"), "/errors/image-upload-invalid"],
    [new CategoryNotFoundError("x"), "/errors/category-not-found"],
  ])("%s derives typeSlug = %s", (err, expectedSlug) => {
    expect(err.typeSlug).toBe(expectedSlug);
  });
});
