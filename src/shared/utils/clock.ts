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

/**
 * Create a Date that is `offsetMs` milliseconds before the Date returned by `clock`.
 *
 * This helper centralises all `new Date(timestamp)` construction in the clock
 * module so that service files contain ZERO direct `new Date(...)` calls,
 * satisfying the clock-injection invariant:
 *   "Clock MUST be injected — the service MUST NOT call new Date() directly"
 *
 * Usage in services:
 *   const to = clock();
 *   const from = dateBeforeClock(clock, WINDOW_MS[window]);
 *   // Zero `new Date()` calls remain in the service file.
 *
 * Spec reference:
 *   sales-stats §Invariants — "Clock MUST be injected"
 */
export function dateBeforeClock(clock: Clock, offsetMs: number): Date {
  return new Date(clock().getTime() - offsetMs);
}
