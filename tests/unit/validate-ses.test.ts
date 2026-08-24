import { describe, expect, it, vi } from "vitest";

import { parseSesValidationConfig, runSesValidation } from "../../scripts/validate-ses";

const COMPLETE_ENV = {
  EMAIL_PROVIDER: "ses",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  AWS_REGION: "eu-west-1",
  SES_SENDER_EMAIL: "sender@example.test",
  SES_RECIPIENT_EMAIL: "recipient@example.test",
};

describe("parseSesValidationConfig", () => {
  it("returns the non-secret send configuration when every required input is present", () => {
    expect(parseSesValidationConfig(COMPLETE_ENV)).toEqual({
      region: "eu-west-1",
      sender: "sender@example.test",
      recipient: "recipient@example.test",
    });
  });

  it("rejects a non-SES provider without exposing configuration values", () => {
    expect(() => parseSesValidationConfig({ ...COMPLETE_ENV, EMAIL_PROVIDER: "console" })).toThrow(
      "EMAIL_PROVIDER must be set to ses",
    );
  });

  it("reports absent required keys by name without exposing credential values", () => {
    expect(() =>
      parseSesValidationConfig({
        EMAIL_PROVIDER: "ses",
        AWS_ACCESS_KEY_ID: "test-access-key",
        SES_SENDER_EMAIL: "sender@example.test",
      }),
    ).toThrow("Missing required configuration: AWS_SECRET_ACCESS_KEY, AWS_REGION, SES_RECIPIENT_EMAIL");
  });

  it("performs exactly one send after configuration validation", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const createProvider = vi.fn(() => ({ send }));
    const stdout = vi.fn();

    await runSesValidation(COMPLETE_ENV, { createProvider, stdout, stderr: vi.fn() });

    expect(createProvider).toHaveBeenCalledWith({
      region: "eu-west-1",
      sender: "sender@example.test",
      recipient: "recipient@example.test",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith(
      "SES validation send accepted (one send attempted; identities redacted).\n",
    );
  });

  it("does not construct a provider when required configuration is absent", async () => {
    const createProvider = vi.fn();

    await expect(runSesValidation({ EMAIL_PROVIDER: "ses" }, { createProvider, stdout: vi.fn(), stderr: vi.fn() })).rejects.toThrow(
      "Missing required configuration",
    );
    expect(createProvider).not.toHaveBeenCalled();
  });
});
