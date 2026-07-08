/**
 * Auth routes — POST /auth/sync.
 *
 * Mounted at /api/v1 in src/app.ts, so the effective path is
 * POST /api/v1/auth/sync.
 *
 * Auth chain (design §5):
 *   authenticate → loadUser → onboardingGate → controller
 *
 * Rate limiter: applied per design §6 note — rate limiter for /api/v1/auth/*
 * only. Uses express-rate-limit with a 15-minute window / 10 requests per IP.
 *
 * Spec reference: user-profile §"POST /auth/sync"
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";

import { sync } from "../controllers/auth.controller";

export const authRouter: Router = Router();

// Auth-scoped rate limiter (design §6: rate limiter mounts inside auth router only).
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    type: "/errors/unauthorized",
    title: "Too many requests",
    status: 429,
    detail: "Too many requests from this IP, please try again after 15 minutes",
    code: "UNAUTHORIZED",
  },
});

authRouter.post("/auth/sync", authRateLimit, authenticate, loadUser, onboardingGate, sync);
