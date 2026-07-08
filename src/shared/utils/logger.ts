/**
 * Shared pino logger with mandatory PII redaction.
 *
 * Design choice — factory extraction (option a):
 *   We export `createLogger(opts)` alongside the existing `logger` singleton.
 *   The singleton remains unchanged in shape and behavior for the rest of the
 *   app; `createLogger` exists solely to allow test harnesses to pass a
 *   buffered writable destination and/or override NODE_ENV without module-
 *   level side-effects or environment mutation.
 *
 *   `REDACT_CONFIG` is a shared const so both the singleton and the factory
 *   reference the same redaction paths — drift between them is impossible.
 *
 *   `buildLoggerOptions` is a pure function that returns the exact
 *   `LoggerOptions` object for any given (env, level) pair. It is exported
 *   so unit tests can inspect the configuration object directly, without
 *   constructing a logger and without worker-thread concerns.
 *
 * - Development: pino-pretty transport for human-readable colourised output.
 * - Production / test: JSON to stdout (no transport overhead).
 *
 * Redaction paths (per structured-logging spec §PII redaction requirement):
 *   - req.headers.authorization   — JWT bearer token
 *   - req.headers.cookie          — session material
 *   - *.email                     — user email (GDPR)
 *   - *.auth0Sub                  — Auth0 subject identifier
 *   - *.password                  — any accidental password field
 *   - *.token / *.accessToken / *.idToken / *.refreshToken — JWT-shaped credentials
 *   - req.body.email              — email in POST bodies
 *   - req.body.password           — password in POST bodies
 *
 * Redaction is enforced at the logger level — callers cannot bypass it.
 * No other logger (console.log, winston, etc.) may be used in production paths.
 */
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

import { env } from "./env";

// ---------------------------------------------------------------------------
// Shared redact config — used by both the singleton and createLogger factory.
// Single source of truth: adding a path here protects ALL logger instances.
// ---------------------------------------------------------------------------
export const REDACT_CONFIG: pino.redactOptions = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    "*.email",
    "*.password",
    "*.auth0Sub",
    "*.token",
    "*.accessToken",
    "*.idToken",
    "*.refreshToken",
    "req.body.email",
    "req.body.password",
  ],
  censor: "[REDACTED]",
};

// ---------------------------------------------------------------------------
// Pure options builder — exported for unit-testing the configuration path
// without constructing a logger or spawning a worker thread.
//
// Returns the complete LoggerOptions that createLogger / the singleton pass
// to pino(). The transport field is set only for "development"; it is
// undefined for "production" and "test" so callers may safely pass a custom
// DestinationStream as pino's second argument.
// ---------------------------------------------------------------------------
export function buildLoggerOptions(
  nodeEnv: "development" | "production" | "test",
  level: string,
): LoggerOptions {
  return {
    level,
    transport:
      nodeEnv === "development"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:HH:MM:ss",
              ignore: "pid,hostname",
            },
          }
        : undefined,
    redact: REDACT_CONFIG,
  };
}

// ---------------------------------------------------------------------------
// Factory — lets test harnesses inject a buffered destination and/or a
// different NODE_ENV without touching process.env or the singleton.
// ---------------------------------------------------------------------------
export interface CreateLoggerOptions {
  /** Override the environment for transport selection. Defaults to process env. */
  env?: "development" | "production" | "test";
  /** Override the log level. Defaults to env.LOG_LEVEL from validated process.env. */
  level?: string;
  /** Custom writable destination (e.g. a Writable buffer for tests). */
  destination?: DestinationStream;
}

/**
 * Build a pino logger with the standard redaction and transport config.
 *
 * @param opts - Optional overrides for environment, level, and destination.
 *   - When `opts.destination` is provided and `opts.env !== "development"`,
 *     the logger writes to `opts.destination` instead of stdout — this is the
 *     primary test affordance.
 *   - When `opts.env === "development"`, the pino-pretty transport is
 *     configured as usual (destination is ignored because pino's transport
 *     option creates its own worker-thread stream).
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const nodeEnv = opts.env ?? env.NODE_ENV;
  const level = opts.level ?? env.LOG_LEVEL;

  const loggerOptions = buildLoggerOptions(nodeEnv, level);

  // When a custom destination is provided and we are NOT in development mode
  // (development uses a transport worker thread which owns its own stream),
  // pass the destination as the second argument to pino().
  if (opts.destination && nodeEnv !== "development") {
    return pino(loggerOptions, opts.destination);
  }

  return pino(loggerOptions);
}

/**
 * Application singleton logger — created once at boot, imported everywhere.
 * Shape and behavior are identical to the original export; nothing in the app
 * needs to change.
 */
export const logger: Logger = createLogger();
