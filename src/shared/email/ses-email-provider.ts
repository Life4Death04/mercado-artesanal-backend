/**
 * SES SDK boundary — the ONLY file allowed to import `@aws-sdk/client-ses`
 * (design "SES test isolation", mirrors `src/shared/s3/s3-client.ts` isolating
 * all AWS SDK imports in one module — see also the global
 * `vi.mock("@aws-sdk/client-ses")` in tests/setup.ts).
 *
 * Imports only TYPES from `email-provider.ts` (`import type`), which are
 * erased at compile time — this keeps the boundary a one-way runtime
 * dependency (email-provider.ts -> this file) with zero circular import risk.
 *
 * Validated once by a real sandbox send (Phase 6, `scripts/validate-ses.ts`,
 * `size:exception` candidate) — this file only wires the adapter; no real
 * send happens in Phase 2 or under `npm test` (SDK is globally mocked).
 *
 * Spec reference: sdd/notifications/spec — "SES Adapter Validated Once".
 * Design reference: sdd/notifications/design — "Provider: mirror StripeClient".
 */
import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";

import type { EmailMessage, EmailProvider } from "@/shared/email/email-provider";

/**
 * Placeholder verified sender identity. SES sandbox mode requires the
 * `Source` address to be a verified identity — Phase 6's sandbox validation
 * script is where this gets exercised against a real (or scrubbed) SES
 * account. Not sourced from `env` per design (Phase 2 introduces only
 * `EMAIL_PROVIDER`); revisit if a later phase needs it configurable.
 */
const SES_SOURCE_EMAIL = "notifications@mercado-artesanal.example";

const CHARSET = "UTF-8";

export class SesEmailProvider implements EmailProvider {
  private readonly client: SESClient;
  private readonly sourceEmail: string;

  constructor(options: { region?: string; sourceEmail?: string } = {}) {
    // Region resolution mirrors src/shared/s3/s3-client.ts's getS3Client().
    this.client = new SESClient({ region: options.region ?? process.env["AWS_REGION"] ?? "eu-west-1" });
    this.sourceEmail = options.sourceEmail ?? process.env["SES_SENDER_EMAIL"] ?? SES_SOURCE_EMAIL;
  }

  async send(message: EmailMessage): Promise<void> {
    const command = new SendEmailCommand({
      Source: this.sourceEmail,
      Destination: { ToAddresses: [message.to] },
      Message: {
        Subject: { Charset: CHARSET, Data: message.subject },
        Body: { Text: { Charset: CHARSET, Data: message.body } },
      },
    });

    await this.client.send(command);
  }
}
