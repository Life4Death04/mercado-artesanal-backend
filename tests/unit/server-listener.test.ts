import type { Server } from "node:http";

import type { Express } from "express";
import { describe, expect, it, vi } from "vitest";

import { listenForRequests } from "@/server-listener";
import { env } from "@/shared/utils/env";

describe("server listener", () => {
  it("binds the validated port on every network interface", () => {
    const server = {} as Server;
    const listen = vi.fn().mockReturnValue(server);
    const app = { listen } as unknown as Express;
    const onListening = vi.fn();

    const result = listenForRequests(app, env.PORT, onListening);

    expect(listen).toHaveBeenCalledWith(env.PORT, "0.0.0.0", onListening);
    expect(result).toBe(server);
  });
});
