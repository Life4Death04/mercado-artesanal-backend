/**
 * 404 fallback handler — catches any request that no router matched.
 *
 * Wiring position (per design §6, position 8):
 *   routes → notFoundHandler → errorMiddleware
 *
 * This is a regular (3-arg) middleware, not an error handler. It passes a
 * NotFoundError to next() so that errorMiddleware serializes it to RFC 7807.
 *
 * Spec reference: error-handling §"404 fallback for unrouted routes"
 */
import type { NextFunction, Request, Response } from "express";

import { NotFoundError } from "@/shared/errors/errors";

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}
