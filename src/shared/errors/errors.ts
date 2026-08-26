/**
 * Concrete AppError subclasses — one per registry code.
 *
 * Each subclass sets the `code`, `status`, and `title` as per the
 * error-handling spec registry. The `detail` message is passed by the
 * caller; the wire serializer (errorMiddleware) MUST NOT expose raw
 * Error.message to prevent PII leakage (RNF-05).
 *
 * Adding a new error condition MUST add a row to the spec registry AND
 * a matching class here — failing to do either breaks the invariant.
 */

import { AppError } from "./AppError";

// ---------------------------------------------------------------------------
// 401 — Missing, malformed, or invalid JWT
// ---------------------------------------------------------------------------

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly status = 401;
  readonly title = "Unauthorized";
}

// ---------------------------------------------------------------------------
// 403 — Authenticated but role is not allowed
// ---------------------------------------------------------------------------

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly status = 403;
  readonly title = "Forbidden";
}

// ---------------------------------------------------------------------------
// 403 — PENDING_ROLE user hits a non-allow-list route
// ---------------------------------------------------------------------------

export class OnboardingRequiredError extends AppError {
  readonly code = "ONBOARDING_REQUIRED" as const;
  readonly status = 403;
  readonly title = "Onboarding required";
}

// ---------------------------------------------------------------------------
// 404 — Resource does not exist or is soft-deleted
// ---------------------------------------------------------------------------

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Not found";
}

// ---------------------------------------------------------------------------
// 409 — Onboarding retried on a non-PENDING user
// ---------------------------------------------------------------------------

export class RoleAlreadySetError extends AppError {
  readonly code = "ROLE_ALREADY_SET" as const;
  readonly status = 409;
  readonly title = "Role already set";
}

// ---------------------------------------------------------------------------
// 409 — Producer wizard NIF collides with existing Producer
// ---------------------------------------------------------------------------

export class NifAlreadyRegisteredError extends AppError {
  readonly code = "NIF_ALREADY_REGISTERED" as const;
  readonly status = 409;
  readonly title = "NIF already registered";
}

// ---------------------------------------------------------------------------
// 422 — Zod body/query/params validation error
// ---------------------------------------------------------------------------

export class ValidationFailedError extends AppError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly status: 400 | 422;
  readonly title = "Validation failed";
  readonly errors: Array<{ path: string; message: string }>;

  constructor(
    errors: Array<{ path: string; message: string }>,
    detail = "Validation failed",
    status: 400 | 422 = 422,
  ) {
    super(detail);
    this.errors = errors;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 422 — Producer wizard references a categorySlug not in seed
// ---------------------------------------------------------------------------

export class UnknownCategoryError extends AppError {
  readonly code = "UNKNOWN_CATEGORY" as const;
  readonly status = 422;
  readonly title = "Unknown category";
}

// ---------------------------------------------------------------------------
// 422 — Consumer tries to demote current default address without promoting another
// ---------------------------------------------------------------------------

export class InvalidDefaultTransitionError extends AppError {
  readonly code = "INVALID_DEFAULT_TRANSITION" as const;
  readonly status = 422;
  readonly title = "Invalid default transition";
}

// ---------------------------------------------------------------------------
// 409 — DB-level partial unique index violation: two concurrent writes raced
//       to set isDefault=true for the same user. Client may retry.
// ---------------------------------------------------------------------------

export class AddressDefaultConflictError extends AppError {
  readonly code = "ADDRESS_DEFAULT_CONFLICT" as const;
  readonly status = 409;
  readonly title = "Address default conflict";
}

// ===========================================================================
// Cycle 2 additions — 8 new subclasses per error-handling spec registry
// ===========================================================================

// ---------------------------------------------------------------------------
// 404 — Product missing, soft-deleted, or not owned by the requesting producer
// ---------------------------------------------------------------------------

export class ProductNotFoundError extends AppError {
  readonly code = "PRODUCT_NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Product not found";
}

// ---------------------------------------------------------------------------
// 409 — decrementStock would drive Product.stock below 0
// ---------------------------------------------------------------------------

export class InsufficientStockError extends AppError {
  readonly code = "INSUFFICIENT_STOCK" as const;
  readonly status = 409;
  readonly title = "Insufficient stock";
}

// ---------------------------------------------------------------------------
// 409 — Soft-delete or isActive → false while non-terminal OrderLines exist
// ---------------------------------------------------------------------------

export class ProductHasActiveOrdersError extends AppError {
  readonly code = "PRODUCT_HAS_ACTIVE_ORDERS" as const;
  readonly status = 409;
  readonly title = "Product has active orders";
}

// ---------------------------------------------------------------------------
// 409 — Producer soft-delete while non-terminal SubOrders exist
// ---------------------------------------------------------------------------

export class ProducerHasActiveOrdersError extends AppError {
  readonly code = "PRODUCER_HAS_ACTIVE_ORDERS" as const;
  readonly status = 409;
  readonly title = "Producer has active orders";
}

// ---------------------------------------------------------------------------
// 409 — Fulfillment state machine rejects source→target for a SubOrder
// ---------------------------------------------------------------------------

export class InvalidOrderTransitionError extends AppError {
  readonly code = "INVALID_ORDER_TRANSITION" as const;
  readonly status = 409;
  readonly title = "Invalid order transition";
}

// ---------------------------------------------------------------------------
// 404 — DeliveryMode missing or not owned by the requesting producer
// ---------------------------------------------------------------------------

export class DeliveryModeNotFoundError extends AppError {
  readonly code = "DELIVERY_MODE_NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Delivery mode not found";
}

// ---------------------------------------------------------------------------
// 400 — Presign or confirm parameters violate mime/size/position policy.
//       PII-safety: detail MUST NOT include the s3Key, email, NIF, or JWT.
// ---------------------------------------------------------------------------

export class ImageUploadInvalidError extends AppError {
  readonly code = "IMAGE_UPLOAD_INVALID" as const;
  readonly status = 400;
  readonly title = "Image upload invalid";
}

// ---------------------------------------------------------------------------
// 404 — Product.categoryId references a non-existent product Category
// ---------------------------------------------------------------------------

export class CategoryNotFoundError extends AppError {
  readonly code = "CATEGORY_NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Category not found";
}

// ===========================================================================
// Cycle 3 additions — cart slice (consumer-purchase-flow 1/3)
// ===========================================================================

// ---------------------------------------------------------------------------
// 409 — POST /carrito/items when Product.isActive = false
//       Distinct from InsufficientStockError (owned by payments transactional decrement).
// ---------------------------------------------------------------------------

export class ProductInactiveError extends AppError {
  readonly code = "PRODUCT_INACTIVE" as const;
  readonly status = 409;
  readonly title = "Product inactive";
}

// ---------------------------------------------------------------------------
// 422 — POST or PATCH /carrito/items when quantity > Product.stock
//       Informational check (Decision 2, obs #882) — no stock reservation.
//       Distinct from InsufficientStockError (reserved for the hard decrement
//       inside the payments checkout transaction).
// ---------------------------------------------------------------------------

export class QuantityExceedsStockError extends AppError {
  readonly code = "QUANTITY_EXCEEDS_STOCK" as const;
  readonly status = 422;
  readonly title = "Quantity exceeds stock";
}

// ---------------------------------------------------------------------------
// 501 — Endpoint route is wired but the handler is not implemented yet.
//       Used by stub handlers introduced in a slice's foundation PR while
//       later PRs fill in real behavior. Ensures every stub response still
//       flows through errorMiddleware and uses the canonical RFC 7807
//       Problem Details envelope (application/problem+json).
// ---------------------------------------------------------------------------

export class NotImplementedError extends AppError {
  readonly code = "NOT_IMPLEMENTED" as const;
  readonly status = 501;
  readonly title = "Not implemented";

  constructor(detail = "Endpoint not implemented yet", cause?: unknown) {
    super(detail, cause);
  }
}

// ===========================================================================
// Cycle 4 additions — orders slice (consumer-purchase-flow 2/3)
// ===========================================================================

// ---------------------------------------------------------------------------
// 422 — createOrderFromPayment invoked with zero cart items
// ---------------------------------------------------------------------------

export class EmptyCartCheckoutError extends AppError {
  readonly code = "EMPTY_CART_CHECKOUT" as const;
  readonly status = 422;
  readonly title = "Empty cart checkout";
}

// ---------------------------------------------------------------------------
// 409 — any cart item unavailable at checkout (producer soft-deleted or
//       product inactive/soft-deleted) — all-or-nothing (design Decision 5).
//       Distinct from InsufficientStockError (stock shortfall, not availability).
// ---------------------------------------------------------------------------

export class CartItemNotAvailableError extends AppError {
  readonly code = "CART_ITEM_NOT_AVAILABLE" as const;
  readonly status = 409;
  readonly title = "Cart item not available";
}

// ===========================================================================
// Cycle 5 additions — payments slice (consumer-purchase-flow 3/3)
// ===========================================================================

// ---------------------------------------------------------------------------
// 502 — the Stripe PaymentIntent creation call fails or rejects.
//       No local state is written; detail MUST NOT leak Stripe internals.
// ---------------------------------------------------------------------------

export class PaymentIntentCreationError extends AppError {
  readonly code = "PAYMENT_INTENT_CREATION_FAILED" as const;
  readonly status = 502;
  readonly title = "Payment intent creation failed";
}

// ---------------------------------------------------------------------------
// 400 — POST /pagos/webhook signature verification fails (missing header or
//       Stripe HMAC mismatch over the raw body). Zero DB writes on this path
//       (payments.service.ts verifies BEFORE any event dispatch).
// ---------------------------------------------------------------------------

export class WebhookSignatureError extends AppError {
  readonly code = "WEBHOOK_SIGNATURE_INVALID" as const;
  readonly status = 400;
  readonly title = "Webhook signature invalid";
}

// ===========================================================================
// Cycle 6 additions — admin-catalog-control (admin cycle 1/3)
// ===========================================================================

// ---------------------------------------------------------------------------
// 409 — PATCH /admin/products/:id/moderation action does not match the
//       product's current moderationStatus (action-table rejection or a
//       raced conditional write that returned zero updated rows).
//       Status and audit fields are left unchanged.
// ---------------------------------------------------------------------------

export class InvalidModerationTransitionError extends AppError {
  readonly code = "INVALID_MODERATION_TRANSITION" as const;
  readonly status = 409;
  readonly title = "Invalid moderation transition";
}

// ---------------------------------------------------------------------------
// 409 — POST /admin/categories (or a PATCH that would derive a new slug)
//       collides with an existing Category.slug. Mapped from a Prisma P2002
//       unique-constraint violation on the `slug` column (per
//       NifAlreadyRegisteredError's P2002-to-409 pattern). No category is
//       created/updated when this is thrown.
// ---------------------------------------------------------------------------

export class CategorySlugConflictError extends AppError {
  readonly code = "CATEGORY_SLUG_CONFLICT" as const;
  readonly status = 409;
  readonly title = "Category slug conflict";
}

// ===========================================================================
// admin-incidents WU1 additions
// ===========================================================================

// ---------------------------------------------------------------------------
// 409 — PATCH /admin/incidents/:id/resolve targets an incident that is not
//       OPEN or already carries a resolution audit (existence check passed,
//       conditional `updateMany` on status=OPEN + null audit fields returned
//       count 0). A losing race maps here too. detail MUST NOT include the
//       original report/resolution reason, reporter email, or any protected
//       identifier — only a stable, non-mutating conflict signal.
//       Status and audit fields (resolver, reason, timestamp) are left
//       unchanged for both the raced loser and the repeated caller.
// ---------------------------------------------------------------------------

export class IncidentAlreadyResolvedError extends AppError {
  readonly code = "INCIDENT_ALREADY_RESOLVED" as const;
  readonly status = 409;
  readonly title = "Incident already resolved";
}

// ===========================================================================
// admin-user-management additions — account lifecycle error contract
// Spec: error-handling §"Account lifecycle error contract"
// ===========================================================================

// ---------------------------------------------------------------------------
// 403 — Deactivated or deleted identity denied on a protected operation.
//       detail MUST NOT expose email, subject, or profile data (PII safety).
// ---------------------------------------------------------------------------

export class AccountInactiveError extends AppError {
  readonly code = "ACCOUNT_INACTIVE" as const;
  readonly status = 403;
  readonly title = "Account inactive";

  constructor(detail = "Account is deactivated or deleted", cause?: unknown) {
    super(detail, cause);
  }
}

// ---------------------------------------------------------------------------
// 409 — An action attempts to restore a deletion tombstone (e.g. ADMIN
//       activation targeting an already-deleted account). Irreversible by
//       design — deletion MUST NEVER be undone.
// ---------------------------------------------------------------------------

export class AccountDeletedError extends AppError {
  readonly code = "ACCOUNT_DELETED" as const;
  readonly status = 409;
  readonly title = "Account deleted";

  constructor(detail = "Account has been permanently deleted", cause?: unknown) {
    super(detail, cause);
  }
}

// ---------------------------------------------------------------------------
// 409 — Account deletion requested while the consumer or producer owns any
//       active (non-terminal) order.
// ---------------------------------------------------------------------------

export class UserHasActiveOrdersError extends AppError {
  readonly code = "USER_HAS_ACTIVE_ORDERS" as const;
  readonly status = 409;
  readonly title = "User has active orders";

  constructor(detail = "Cannot delete a user with active orders", cause?: unknown) {
    super(detail, cause);
  }
}

// ===========================================================================
// admin-database-backups additions — backup/restore error contract
// ===========================================================================

// 404 — Backup ID does not exist, is tombstoned, or is corrupt/incomplete.
export class BackupNotFoundError extends AppError {
  readonly code = "BACKUP_NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Backup not found";
}

// 404 — Operation ID does not exist.
export class BackupOperationNotFoundError extends AppError {
  readonly code = "BACKUP_OPERATION_NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Backup operation not found";
}

// 409 — Backup fails checksum/list/major recheck before restore preparation.
export class BackupNotRestorableError extends AppError {
  readonly code = "BACKUP_NOT_RESTORABLE" as const;
  readonly status = 409;
  readonly title = "Backup not restorable";
}

// 409 — Global operation lease is already held by another mutation.
export class BackupOperationConflictError extends AppError {
  readonly code = "BACKUP_OPERATION_CONFLICT" as const;
  readonly status = 409;
  readonly title = "Backup operation conflict";
}

// 503 — Client 16 tooling missing, wrong major, or not executable.
export class BackupRuntimeUnavailableError extends AppError {
  readonly code = "BACKUP_RUNTIME_UNAVAILABLE" as const;
  readonly status = 503;
  readonly title = "Backup runtime unavailable";
}

// 500 — Runner/tool step failed after acceptance; detail MUST stay redacted.
export class BackupOperationFailedError extends AppError {
  readonly code = "BACKUP_OPERATION_FAILED" as const;
  readonly status = 500;
  readonly title = "Backup operation failed";
}

// 404 — Administrator invitation operation ID does not exist.
export class AdminInvitationOperationNotFoundError extends AppError {
  readonly code = "ADMIN_INVITATION_OPERATION_NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Admin invitation operation not found";
}

// 409 — A request key was replayed with different actor or invitation input.
export class AdminInvitationRequestConflictError extends AppError {
  readonly code = "ADMIN_INVITATION_REQUEST_CONFLICT" as const;
  readonly status = 409;
  readonly title = "Admin invitation request conflict";
}
