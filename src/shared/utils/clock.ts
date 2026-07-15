/**
 * Injectable clock for deterministic testing.
 *
 * Services that need the current time MUST accept a `clock` parameter
 * instead of calling `new Date()` directly. This guarantees test
 * reproducibility by allowing a fixed clock to be injected.
 *
 * Usage:
 *   // Production — uses real system time
 *   import { systemClock } from "@/shared/utils/clock";
 *   const result = await getRevenue(producerId, window, systemClock);
 *
 *   // Tests — inject a fixed clock for determinism
 *   const fixedClock = () => new Date("2026-01-01T00:00:00Z");
 *   const result = await getRevenue(producerId, window, fixedClock);
 *
 * Spec reference:
 *   sales-stats §Invariants — "Clock MUST be injected"
 *   sales-stats scenario "Deterministic clock in tests"
 *   design §"Sales-stats clock injection"
 */

/**
 * A clock is a zero-argument function that returns the current Date.
 * Injecting this instead of calling `new Date()` makes services testable
 * without mocking global constructors.
 */
export type Clock = () => Date;

/**
 * The default system clock — returns `new Date()` at call time.
 * Pass this as the default parameter value in production services.
 *
 * Tests MUST NOT use this clock — inject a fixed `() => new Date("...")` instead.
 */
export const systemClock: Clock = () => new Date();
