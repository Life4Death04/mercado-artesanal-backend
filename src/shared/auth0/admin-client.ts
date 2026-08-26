import { randomBytes } from "node:crypto";

import { normalizeEmail } from "@/shared/utils/normalize-email";

export type Auth0AdminErrorKind = "ambiguous" | "conflict" | "rejected";
export class Auth0AdminError extends Error {
  constructor(
    readonly kind: Auth0AdminErrorKind,
    readonly operation: string,
    readonly status?: number,
  ) {
    super(`Auth0 ${operation} ${kind}`);
    this.name = "Auth0AdminError";
  }
}
export interface Auth0AdminConfig {
  domain: string;
  m2mClientId: string;
  m2mClientSecret: string;
  applicationClientId: string;
  connection: string;
  timeoutMs: number;
}
export type AdminIdentity = { userId: string; email: string };
export interface CreateAdminIdentityInput {
  email: string;
  operationId: string;
  givenName?: string;
  familyName?: string;
}
const OWNER_KEY = "adminInvitationOperationId";
export class Auth0AdminClient {
  private token?: { value: string; expiresAt: number };
  private tokenFlight?: Promise<string>;
  constructor(
    private readonly config: Auth0AdminConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async createAdminIdentity(input: CreateAdminIdentityInput): Promise<AdminIdentity> {
    const email = normalizeEmail(input.email.trim());
    const body: Record<string, unknown> = {
      connection: this.config.connection,
      email,
      password: `${randomBytes(32).toString("base64url")}aA1!`,
      email_verified: false,
      app_metadata: { [OWNER_KEY]: input.operationId },
    };
    if (input.givenName) body.given_name = safeName(input.givenName);
    if (input.familyName) body.family_name = safeName(input.familyName);
    const response = await this.managementRequest("/api/v2/users", "create user", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.status !== 201) throw this.rejection("create user", response.status);
    return parseIdentity(await this.json(response, "create user"), "create user");
  }
  async findOwnedIdentity(email: string, operationId: string): Promise<AdminIdentity | null> {
    const canonical = normalizeEmail(email.trim());
    const response = await this.managementRequest(
      `/api/v2/users-by-email?email=${encodeURIComponent(canonical)}`,
      "find user",
    );
    if (response.status !== 200) throw this.rejection("find user", response.status);
    const value: unknown = await this.json(response, "find user", "rejected");
    if (!Array.isArray(value)) throw new Auth0AdminError("rejected", "find user");
    const users: unknown[] = value;
    const owned = users.find(
      (user) =>
        isOwned(user, operationId) &&
        typeof user.email === "string" &&
        normalizeEmail(user.email) === canonical,
    );
    return owned ? parseIdentity(owned, "find user", "rejected") : null;
  }
  async deleteOwnedIdentity(userId: string, operationId: string): Promise<boolean> {
    const path = `/api/v2/users/${encodeURIComponent(userId)}`;
    const read = await this.managementRequest(path, "read user");
    if (read.status === 404) return false;
    if (read.status !== 200) throw this.rejection("read user", read.status);
    const user = await this.json(read, "read user", "rejected");
    if (!isOwned(user, operationId) || user.user_id !== userId) return false;
    const deleted = await this.managementRequest(path, "delete user", { method: "DELETE" });
    if (deleted.status !== 204) throw this.rejection("delete user", deleted.status);
    return true;
  }
  async requestPasswordSetupEmail(email: string): Promise<void> {
    const response = await this.request("/dbconnections/change_password", "send password email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.applicationClientId,
        email: normalizeEmail(email.trim()),
        connection: this.config.connection,
      }),
    });
    if (response.status !== 200) throw this.rejection("send password email", response.status);
    if (!response.headers.get("content-type")?.startsWith("text/plain")) {
      throw new Auth0AdminError("ambiguous", "send password email");
    }
  }
  private async managementRequest(path: string, operation: string, init: RequestInit = {}) {
    const accessToken = await this.getToken();
    return this.request(path, operation, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    });
  }
  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    this.tokenFlight ??= this.loadToken().finally(() => {
      this.tokenFlight = undefined;
    });
    return this.tokenFlight;
  }
  private async loadToken(): Promise<string> {
    const response = await this.request("/oauth/token", "acquire token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.config.m2mClientId,
        client_secret: this.config.m2mClientSecret,
        audience: `https://${this.config.domain}/api/v2/`,
      }),
    });
    if (response.status !== 200) throw this.rejection("acquire token", response.status);
    const value = await this.json(response, "acquire token", "rejected");
    if (
      !isRecord(value) ||
      typeof value.access_token !== "string" ||
      typeof value.expires_in !== "number" ||
      value.expires_in <= 0
    ) {
      throw new Auth0AdminError("rejected", "acquire token");
    }
    this.token = {
      value: value.access_token,
      expiresAt: Date.now() + Math.max(0, value.expires_in * 1000 - 30_000),
    };
    return value.access_token;
  }
  private async request(path: string, operation: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await this.fetchImpl(`https://${this.config.domain}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch {
      throw new Auth0AdminError("ambiguous", operation);
    } finally {
      clearTimeout(timeout);
    }
  }
  private async json(
    response: Response,
    operation: string,
    malformedKind: Auth0AdminErrorKind = "ambiguous",
  ): Promise<unknown> {
    try {
      const value: unknown = await response.json();
      return value;
    } catch {
      throw new Auth0AdminError(malformedKind, operation);
    }
  }
  private rejection(operation: string, status: number) {
    return new Auth0AdminError(status === 409 ? "conflict" : "rejected", operation, status);
  }
}
function safeName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 150 || /[\u0000-\u001f\u007f]/.test(name))
    throw new TypeError("Invalid profile name");
  return name;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isOwned(value: unknown, operationId: string): value is Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.app_metadata)) return false;
  return value.app_metadata[OWNER_KEY] === operationId;
}
function parseIdentity(
  value: unknown,
  operation: string,
  malformedKind: Auth0AdminErrorKind = "ambiguous",
): AdminIdentity {
  if (!isRecord(value) || typeof value.user_id !== "string" || typeof value.email !== "string") {
    throw new Auth0AdminError(malformedKind, operation);
  }
  return { userId: value.user_id, email: normalizeEmail(value.email) };
}
