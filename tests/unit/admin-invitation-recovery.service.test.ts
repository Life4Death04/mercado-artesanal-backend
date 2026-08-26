import { describe, expect, it, vi } from "vitest";

import {
  buildAdminInvitationAuth0Config,
  createAdminInvitationRecovery,
} from "@/modules/admin/services/admin-invitation-recovery.service";

function harness(runOnce = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)) {
  const immediate: Array<() => void> = [];
  let intervalTick: (() => void) | undefined;
  const unref = vi.fn();
  const reportFailure = vi.fn();
  const prepare = createAdminInvitationRecovery({
    runOnce,
    defer: (task) => immediate.push(task),
    every: (task, delayMs) => {
      expect(delayMs).toBe(2_000);
      intervalTick = task;
      return { unref };
    },
    reportFailure,
  });
  return { immediate, intervalTick: () => intervalTick!(), prepare, reportFailure, unref };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("admin invitation recovery runtime", () => {
  it("maps validated Auth0 settings without transforming their authority", () => {
    expect(
      buildAdminInvitationAuth0Config({
        AUTH0_DOMAIN: "tenant.example",
        AUTH0_M2M_CLIENT_ID: "m2m-id",
        AUTH0_M2M_CLIENT_SECRET: "m2m-secret",
        AUTH0_APPLICATION_CLIENT_ID: "application-id",
        AUTH0_DATABASE_CONNECTION: "database-connection",
        AUTH0_REQUEST_TIMEOUT_MS: 4_321,
      }),
    ).toEqual({
      domain: "tenant.example",
      m2mClientId: "m2m-id",
      m2mClientSecret: "m2m-secret",
      applicationClientId: "application-id",
      connection: "database-connection",
      timeoutMs: 4_321,
    });
  });

  it("schedules immediate and interval passes once, unreferences the interval, and returns early", () => {
    const runOnce = vi.fn<() => Promise<boolean>>(() => new Promise(() => undefined));
    const runtime = harness(runOnce);

    expect(runtime.prepare()).toBeUndefined();
    expect(runtime.prepare()).toBeUndefined();
    expect(runtime.immediate).toHaveLength(1);
    expect(runtime.unref).toHaveBeenCalledOnce();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("drains until empty while preventing concurrent ticks and yielding between operations", async () => {
    let release!: (worked: boolean) => void;
    const first = new Promise<boolean>((resolve) => (release = resolve));
    const runOnce = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const runtime = harness(runOnce);
    runtime.prepare();

    runtime.immediate.shift()!();
    runtime.intervalTick();
    expect(runOnce).toHaveBeenCalledOnce();

    release(true);
    await settle();
    expect(runtime.immediate).toHaveLength(1);
    expect(runOnce).toHaveBeenCalledOnce();

    runtime.immediate.shift()!();
    await settle();
    expect(runOnce).toHaveBeenCalledTimes(2);
    runtime.immediate.shift()!();
    await settle();
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it("contains failures without exposing the thrown value and permits a later pass", async () => {
    const runOnce = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("provider URL credential body"))
      .mockResolvedValueOnce(false);
    const runtime = harness(runOnce);
    runtime.prepare();

    runtime.immediate.shift()!();
    await settle();
    expect(runtime.reportFailure).toHaveBeenCalledWith();

    runtime.intervalTick();
    await settle();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
