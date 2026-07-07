import express, { type Express } from "express";

/**
 * Creates and configures the Express application.
 *
 * Middleware stack (full wiring added in PR#2):
 *   helmet → cors → compression → express.json → pino-http
 *   → /health routes
 *   → /api/v1 routes (authenticate → loadUser → onboardingGate → requireRole → controller)
 *   → notFoundHandler
 *   → errorMiddleware
 *
 * IMPORTANT: This factory MUST NOT call app.listen().
 * The server entry-point (src/server.ts) owns the lifecycle so test harnesses
 * (Supertest) can mount the app in-memory without opening a TCP socket.
 */
export function createApp(): Express {
  const app = express();

  // TODO (PR#2): wire helmet, cors, compression, express.json, pino-http
  // TODO (PR#2): mount /health router
  // TODO (PR#2): mount /api/v1 router
  // TODO (PR#2): register notFoundHandler
  // TODO (PR#2): register errorMiddleware (4-arg — MUST be last)

  return app;
}
