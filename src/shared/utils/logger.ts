/**
 * Shared pino logger with mandatory PII redaction.
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
import pino, { type Logger } from "pino";

import { env } from "./env";

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  redact: {
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
  },
});
