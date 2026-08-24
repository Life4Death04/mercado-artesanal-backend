/**
 * One-off Amazon SES sandbox validation.
 *
 * Usage: EMAIL_PROVIDER=ses npm run validate-ses
 *
 * This command sends exactly one email after validating its required
 * configuration. It never retries. Output deliberately contains neither
 * credentials nor sender/recipient addresses.
 */
import "dotenv/config";

import { SesEmailProvider } from "@/shared/email/ses-email-provider";

const REQUIRED_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "SES_SENDER_EMAIL",
  "SES_RECIPIENT_EMAIL",
] as const;

export interface SesValidationConfig {
  region: string;
  sender: string;
  recipient: string;
}

export function parseSesValidationConfig(
  input: Record<string, string | undefined>,
): SesValidationConfig {
  if (input.EMAIL_PROVIDER !== "ses") {
    throw new Error("EMAIL_PROVIDER must be set to ses");
  }

  const missing = REQUIRED_KEYS.filter((key) => !input[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  return {
    region: input.AWS_REGION as string,
    sender: input.SES_SENDER_EMAIL as string,
    recipient: input.SES_RECIPIENT_EMAIL as string,
  };
}

export interface ValidateSesDeps {
  createProvider: (config: SesValidationConfig) => { send: (message: { to: string; subject: string; body: string }) => Promise<void> };
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export async function runSesValidation(
  input: Record<string, string | undefined>,
  deps: ValidateSesDeps,
): Promise<void> {
  const config = parseSesValidationConfig(input);
  const provider = deps.createProvider(config);

  await provider.send({
    to: config.recipient,
    subject: "Mercado Artesanal SES sandbox validation",
    body: "This is the single authorized SES sandbox validation message.",
  });
  deps.stdout("SES validation send accepted (one send attempted; identities redacted).\n");
}

if (require.main === module) {
  runSesValidation(process.env, {
    createProvider: ({ region, sender }) => new SesEmailProvider({ region, sourceEmail: sender }),
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`SES validation did not send: ${message}\n`);
    process.exit(1);
  });
}
