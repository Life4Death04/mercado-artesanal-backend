/**
 * Base error class for the application error hierarchy.
 *
 * All domain errors MUST extend AppError. The central errorMiddleware
 * is the single place that converts AppError subclasses into RFC 7807
 * Problem Details wire responses — controllers and services MUST throw,
 * not respond directly.
 *
 * Semantic code registry (per error-handling spec):
 *   UNAUTHORIZED, FORBIDDEN, ONBOARDING_REQUIRED, NOT_FOUND,
 *   ROLE_ALREADY_SET, NIF_ALREADY_REGISTERED, VALIDATION_FAILED,
 *   UNKNOWN_CATEGORY, INVALID_DEFAULT_TRANSITION, INTERNAL_ERROR,
 *   PRODUCT_INACTIVE, QUANTITY_EXCEEDS_STOCK, NOT_IMPLEMENTED.
 *
 * Wire shape (RFC 7807):
 *   { type, title, status, detail, code, instance, errors? }
 */

export type ErrorCode =
  // Cycle 1
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "ONBOARDING_REQUIRED"
  | "NOT_FOUND"
  | "ROLE_ALREADY_SET"
  | "NIF_ALREADY_REGISTERED"
  | "VALIDATION_FAILED"
  | "UNKNOWN_CATEGORY"
  | "INVALID_DEFAULT_TRANSITION"
  | "ADDRESS_DEFAULT_CONFLICT"
  | "INTERNAL_ERROR"
  // Cycle 2 additions
  | "PRODUCT_NOT_FOUND"
  | "INSUFFICIENT_STOCK"
  | "PRODUCT_HAS_ACTIVE_ORDERS"
  | "PRODUCER_HAS_ACTIVE_ORDERS"
  | "INVALID_ORDER_TRANSITION"
  | "DELIVERY_MODE_NOT_FOUND"
  | "IMAGE_UPLOAD_INVALID"
  | "CATEGORY_NOT_FOUND"
  // Cycle 3 additions
  | "PRODUCT_INACTIVE"
  | "QUANTITY_EXCEEDS_STOCK"
  | "NOT_IMPLEMENTED"
  // Cycle 4 additions — orders slice (consumer-purchase-flow 2/3)
  | "EMPTY_CART_CHECKOUT"
  | "CART_ITEM_NOT_AVAILABLE"
  // Cycle 5 additions — payments slice (consumer-purchase-flow 3/3)
  | "PAYMENT_INTENT_CREATION_FAILED"
  | "WEBHOOK_SIGNATURE_INVALID";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  instance: string;
  errors?: Array<{ path: string; message: string }>;
}

/**
 * Abstract base for all typed application errors.
 *
 * Subclasses MUST declare `code`, `status`, and `title` as readonly literals.
 * The `typeSlug` getter derives the RFC 7807 `type` URI from `code` so the
 * slug never drifts from the registry (e.g. NOT_FOUND → /errors/not-found).
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;
  abstract readonly title: string;

  readonly detail: string;
  readonly cause?: unknown;

  constructor(detail: string, cause?: unknown) {
    super(detail);
    this.name = this.constructor.name;
    this.detail = detail;
    this.cause = cause;
    // Restore prototype chain for `instanceof` checks across compilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Derives the RFC 7807 `type` URI from the semantic error code.
   * Example: "NOT_FOUND" → "/errors/not-found"
   */
  get typeSlug(): string {
    return `/errors/${this.code.toLowerCase().replace(/_/g, "-")}`;
  }
}
