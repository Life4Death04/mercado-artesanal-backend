import { afterEach, describe, expect, it, vi } from "vitest";

import { Auth0AdminClient, type Auth0AdminConfig } from "@/shared/auth0/admin-client";
const config: Auth0AdminConfig = {
  domain: "tenant.eu.auth0.com",
  m2mClientId: "m2m-client",
  m2mClientSecret: "never-disclose-this-secret",
  applicationClientId: "application-client",
  connection: "Username-Password-Authentication",
  timeoutMs: 100,
};
const token = () => json({ access_token: "management-token", expires_in: 3600 });
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
afterEach(() => vi.useRealTimers());
describe("Auth0AdminClient", () => {
  it("creates an owned identity with a server-generated password and safe payload", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ user_id: "auth0|1", email: "admin@example.com" }, 201));
    const client = new Auth0AdminClient(config, fetchMock);

    const identity = await client.createAdminIdentity({
      email: " Admin@Example.COM ",
      operationId: "invite-1",
      givenName: " Ada ",
      familyName: "Lovelace",
    });
    const tokenCall = JSON.stringify(fetchMock.mock.calls[0]);
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://tenant.eu.auth0.com/oauth/token");
    expect(tokenCall).toContain("https://tenant.eu.auth0.com/api/v2/");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://tenant.eu.auth0.com/api/v2/users");
    expect(body).toMatchObject({
      connection: config.connection,
      email: "admin@example.com",
      email_verified: false,
      given_name: "Ada",
      family_name: "Lovelace",
      app_metadata: { adminInvitationOperationId: "invite-1" },
    });
    expect(String(body.password).length).toBeGreaterThan(40);
    expect(identity).toEqual({ userId: "auth0|1", email: "admin@example.com" });
    expect(JSON.stringify(identity)).not.toContain(String(body.password));
  });
  it("caches tokens and single-flights concurrent acquisition", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>((url) =>
      String(url).endsWith("/oauth/token") ? pending : Promise.resolve(json([])),
    );
    const client = new Auth0AdminClient(config, fetchMock);
    const first = client.findOwnedIdentity("a@example.com", "one");
    const second = client.findOwnedIdentity("b@example.com", "two");
    release(token());
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    await client.findOwnedIdentity("c@example.com", "three");
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token")),
    ).toHaveLength(1);
  });
  it.each([
    [409, "conflict"],
    [400, "rejected"],
  ] as const)(
    "classifies create HTTP %i as %s without exposing provider bodies or credentials",
    async (status, kind) => {
      const raw = "raw-provider-secret";
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(token())
        .mockResolvedValueOnce(json({ error: raw }, status));
      const client = new Auth0AdminClient(config, fetchMock);
      const error = await client
        .createAdminIdentity({ email: "a@example.com", operationId: "op" })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status });
      expect(String(error)).not.toContain(raw);
      expect(String(error)).not.toContain(config.m2mClientSecret);
      expect(String(error)).not.toContain("management-token");
    },
  );
  it("classifies network failures and timeouts as ambiguous without retrying", async () => {
    const network = new Auth0AdminClient(
      config,
      vi.fn<typeof fetch>().mockRejectedValue(new Error("socket secret")),
    );
    await expect(network.findOwnedIdentity("a@example.com", "op")).rejects.toMatchObject({
      kind: "ambiguous",
      operation: "acquire token",
    });
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const timed = new Auth0AdminClient(config, fetchMock).findOwnedIdentity("a@example.com", "op");
    const assertion = expect(timed).rejects.toMatchObject({ kind: "ambiguous" });
    await vi.advanceTimersByTimeAsync(config.timeoutMs);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("finds ownership and deletes only after exact ownership confirmation", async () => {
    const owned = {
      user_id: "auth0|owned",
      email: "ADMIN@example.com",
      app_metadata: { adminInvitationOperationId: "op-1" },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json([{ user_id: "auth0|other", email: "admin@example.com" }, owned]))
      .mockResolvedValueOnce(
        json({ ...owned, app_metadata: { adminInvitationOperationId: "other" } }),
      )
      .mockResolvedValueOnce(json(owned))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new Auth0AdminClient(config, fetchMock);
    await expect(client.findOwnedIdentity(" Admin@Example.com ", "op-1")).resolves.toEqual({
      userId: "auth0|owned",
      email: "admin@example.com",
    });
    await expect(client.deleteOwnedIdentity("auth0|owned", "op-1")).resolves.toBe(false);
    await expect(client.deleteOwnedIdentity("auth0|owned", "op-1")).resolves.toBe(true);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });
  it("accepts the Authentication API plain-text password email response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("We've just sent you an email", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    await expect(
      new Auth0AdminClient(config, fetchMock).requestPasswordSetupEmail(" Admin@Example.com "),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://tenant.eu.auth0.com/dbconnections/change_password");
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: config.applicationClientId,
      email: "admin@example.com",
      connection: config.connection,
    });
    expect(init?.headers).not.toHaveProperty("authorization");
  });
});
