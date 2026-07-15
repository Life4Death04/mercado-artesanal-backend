/**
 * Products routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   POST   /api/v1/producers/me/products
 *   GET    /api/v1/producers/me/products
 *   GET    /api/v1/producers/me/products/:id
 *   PATCH  /api/v1/producers/me/products/:id
 *   DELETE /api/v1/producers/me/products/:id
 *   POST   /api/v1/products/:id/report       ← authenticated, any role
 *
 * Auth chains (per design API surface table):
 *   Producer CRUD: authenticate → loadUser → onboardingGate → requireRole('PRODUCER')
 *   Report:        authenticate → loadUser → onboardingGate → requireRole('CONSUMER','PRODUCER','ADMIN')
 *
 * Spec references:
 *   product-catalog  §"RBAC-scoped ownership" — PRODUCER role
 *   product-reporting §"Report endpoint" — any authenticated user
 *   design — API surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as productsController from "../controllers/products.controller";

export const productsRouter: Router = Router();

// Producer-scoped guard
const producerGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("PRODUCER"),
];

// Authenticated any-role guard (consumer, producer, admin may report)
const authenticatedGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("CONSUMER", "PRODUCER", "ADMIN"),
];

// ---------------------------------------------------------------------------
// Producer CRUD routes
// ---------------------------------------------------------------------------

productsRouter.post(
  "/producers/me/products",
  ...producerGuard,
  productsController.createProduct,
);

productsRouter.get(
  "/producers/me/products",
  ...producerGuard,
  productsController.listProducts,
);

productsRouter.get(
  "/producers/me/products/:id",
  ...producerGuard,
  productsController.getProduct,
);

productsRouter.patch(
  "/producers/me/products/:id",
  ...producerGuard,
  productsController.updateProduct,
);

productsRouter.delete(
  "/producers/me/products/:id",
  ...producerGuard,
  productsController.deleteProduct,
);

// ---------------------------------------------------------------------------
// Report route — authenticated any role
// ---------------------------------------------------------------------------

productsRouter.post(
  "/products/:id/report",
  ...authenticatedGuard,
  productsController.reportProduct,
);
