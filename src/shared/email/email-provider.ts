/**
 * Email provider boundary — mirrors
 * `src/modules/payments/services/stripe.client.ts`'s no-DI pattern:
 * an interface (the mock seam) + a module-level singleton + default-param
 * injection at call sites (`provider: EmailProvider = emailProvider`).
 *
 * `ConsoleEmailProvider` is the safe zero-AWS-risk default (design decision:
 * SES lives behind config, Console is the runtime default). `SesEmailProvider`
 * lives in its own file — see `ses-email-provider.ts`, the ONLY file allowed
 * to import `@aws-sdk/client-ses` (design "SES test isolation" /
 * "the only file importing @aws-sdk/client-ses"). That file imports this
 * module's TYPES only (`import type`), which are erased at compile time —
 * there is no runtime circular dependency between the two files.
 *
 * `createEmailProvider` is a pure factory taking the provider NAME directly
 * (not reading `env` internally) so tests can exercise every branch without
 * reloading the `env` module (strict-tdd "Extract-Before-Mock Rule"). The
 * singleton below is the only call site that reads `env.EMAIL_PROVIDER`.
 *
 * `dispatchEmails` is the best-effort, fire-after-commit dispatch primitive
 * (design Decision "Email dispatch: fire-after-commit best-effort"): a
 * per-message provider failure is caught + logged and NEVER thrown, so one
 * bad recipient can never affect sibling messages or roll back an
 * already-committed business write. Phase 2 establishes this generic
 * boundary; the wiring call sites (payments/orders/sub-orders seams) are
 * Phases 4-5.
 *
 * Spec reference: sdd/notifications/spec — domain "email-provider".
 * Design reference: sdd/notifications/design — "Provider: mirror StripeClient".
 */
import { SesEmailProvider } from "@/shared/email/ses-email-provider";
import type { Env } from "@/shared/utils/env";
import { env } from "@/shared/utils/env";
import { logger } from "@/shared/utils/logger";

// ---------------------------------------------------------------------------
// Interface — the mock seam
// ---------------------------------------------------------------------------

export interface EmailMessage {
  /** Recipient email address. Field name is intentionally NOT `email` — the
   * shared logger's global PII redact config (`*.email`) would otherwise
   * silently blank the recipient out of ConsoleEmailProvider's demo output,
   * defeating its purpose (visibly showing what would have been sent). */
  to: string;
  subject: string;
  body: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Console provider — logs, makes no external call
// ---------------------------------------------------------------------------

export class ConsoleEmailProvider implements EmailProvider {
  send(message: EmailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject },
      "[email:console] would send email (EMAIL_PROVIDER=console — no external call)",
    );
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Provider selection — pure factory, testable without mocking `env`
// ---------------------------------------------------------------------------

/**
 * Builds an `EmailProvider` for the given provider name. Pure function: no
 * side effects other than constructing the chosen adapter, so unit tests can
 * exercise both branches without reloading modules or mutating `process.env`.
 */
export function createEmailProvider(providerName: Env["EMAIL_PROVIDER"]): EmailProvider {
  switch (providerName) {
    case "ses":
      return new SesEmailProvider();
    case "console":
    default:
      return new ConsoleEmailProvider();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — resolved ONCE at import time from `env.EMAIL_PROVIDER`
// (mirrors `stripeClient`'s singleton in stripe.client.ts).
// ---------------------------------------------------------------------------

export const emailProvider: EmailProvider = createEmailProvider(env.EMAIL_PROVIDER);

// ---------------------------------------------------------------------------
// Best-effort dispatch — fire-after-commit, never throws
// ---------------------------------------------------------------------------

/**
 * Dispatches every message independently. A rejected `send()` is caught and
 * logged; it never throws to the caller and never prevents sibling messages
 * from being attempted (design "Best-Effort, Non-Blocking Dispatch").
 *
 * @param messages - Emails to send (e.g. mapped from `PendingEmail[]`).
 * @param provider - Defaults to the module singleton (StripeClient-style
 *   default-param injection); tests pass a fake provider directly.
 */
export async function dispatchEmails(
  messages: EmailMessage[],
  provider: EmailProvider = emailProvider,
): Promise<void> {
  await Promise.all(
    messages.map(async (message) => {
      try {
        await provider.send(message);
      } catch (err) {
        logger.error(
          { err, to: message.to },
          "[email] dispatch failed — best-effort, business write is unaffected",
        );
      }
    }),
  );
}
