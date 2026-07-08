/**
 * Unit tests — error-handling spec (PR#3).
 *
 * Scenarios covered:
 *   1. AppError serializes to RFC 7807 Problem Details with correct fields.
 *   2. Unknown/non-AppError becomes 500 INTERNAL_ERROR; raw message not exposed.
 *   3. Auth0 library errors (status:401, InvalidTokenError, UnauthorizedError name)
 *      are remapped to 401 UNAUTHORIZED.
 *   4. ZodError escape hatch → 422 VALIDATION_FAILED with issues mapped.
 *   5. ValidationFailedError includes errors[] in the wire response.
 *   6. PII safety: unknown error detail does NOT echo the raw message (RNF-05).
 *
 * Test harness:
 *   errorMiddleware is a pure function that accepts (err, req, res, next).
 *   We provide minimal mocks for req (with req.log) and a res spy.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/shared/errors/AppError";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { errorMiddleware } from "@/shared/middleware/errorMiddleware";

// ---------------------------------------------------------------------------
// Minimal request / response / next mocks
// ---------------------------------------------------------------------------

function buildReqMock(id = "req-test-id") {
  return {
    id,
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function buildResMock() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(mime: string) {
      res.headers["content-type"] = mime;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const nextMock = vi.fn();

// ---------------------------------------------------------------------------
// Scenario 1: AppError subclass → correct RFC 7807 shape
// ---------------------------------------------------------------------------

describe("Scenario 1 — AppError subclass serialized to RFC 7807", () => {
  it("NotFoundError produces 404 with correct code, type, title, detail, instance", () => {
    const req = buildReqMock("test-001");
    const res = buildResMock();
    const err = new NotFoundError("Address not found");

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    expect(res.body).toEqual({
      type: "/errors/not-found",
      title: "Not found",
      status: 404,
      detail: "Address not found",
      code: "NOT_FOUND",
      instance: "test-001",
    });
  });

  it("ForbiddenError produces 403 FORBIDDEN", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = new ForbiddenError("Role not permitted");

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(403);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("FORBIDDEN");
    expect(body["type"]).toBe("/errors/forbidden");
  });

  it("UnauthorizedError produces 401 UNAUTHORIZED", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = new UnauthorizedError("Invalid token");

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("UNAUTHORIZED");
  });

  it("logs at warn level for handled AppErrors", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = new NotFoundError("not found");

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(req.log.warn).toHaveBeenCalledOnce();
    expect(req.log.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Unknown error → 500 INTERNAL_ERROR; raw message not exposed
// ---------------------------------------------------------------------------

describe("Scenario 2 — Unknown error becomes 500 INTERNAL_ERROR (PII safety)", () => {
  it("non-AppError returns 500 INTERNAL_ERROR without echoing raw message", () => {
    const req = buildReqMock("test-002");
    const res = buildResMock();
    const err = new Error("db exploded: user=secret@internal.com password=hunter2");

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(500);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("INTERNAL_ERROR");
    expect(body["status"]).toBe(500);
    // The raw message MUST NOT appear in any field (RNF-05 PII safety)
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("db exploded");
    expect(bodyStr).not.toContain("secret@internal.com");
    expect(bodyStr).not.toContain("hunter2");
    expect(bodyStr).not.toContain("password");
    expect(body["detail"]).toBe("Unexpected error");
  });

  it("logs unknown error at error level with full error object", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = new Error("raw internal message");

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(req.log.error).toHaveBeenCalledOnce();
    // The error object itself is passed to the logger (full visibility internally)
    const [logArg] = req.log.error.mock.calls[0] as [{ err: Error }];
    expect(logArg.err).toBe(err);
  });

  it("instance field contains the request correlation ID", () => {
    const req = buildReqMock("correlation-xyz");
    const res = buildResMock();

    errorMiddleware(new Error("boom"), req as never, res as never, nextMock);

    const body = res.body as Record<string, unknown>;
    expect(body["instance"]).toBe("correlation-xyz");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Auth0 library error remapping (R-5 LOCKED)
// ---------------------------------------------------------------------------

describe("Scenario 3 — Auth0 library errors remapped to 401 UNAUTHORIZED (R-5)", () => {
  it("{ status: 401 } shape remapped to UnauthorizedError", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = { status: 401, message: "Unauthorized" };

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("UNAUTHORIZED");
  });

  it("{ name: 'InvalidTokenError' } shape remapped to UnauthorizedError", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = { name: "InvalidTokenError", message: "jwt malformed" };

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("UNAUTHORIZED");
    // The library message must NOT appear in the response
    expect(JSON.stringify(body)).not.toContain("jwt malformed");
  });

  it("{ name: 'UnauthorizedError' } shape remapped to our UnauthorizedError", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = { name: "UnauthorizedError", message: "jwt expired" };

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: ZodError escape hatch → 422 VALIDATION_FAILED
// ---------------------------------------------------------------------------

describe("Scenario 4 — ZodError escape hatch converts to 422 VALIDATION_FAILED", () => {
  it("ZodError is converted with mapped issues", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const zodErr = {
      name: "ZodError" as const,
      issues: [
        { path: ["email"], message: "Invalid email" },
        { path: ["name", "first"], message: "Required" },
      ],
    };

    errorMiddleware(zodErr, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("VALIDATION_FAILED");
    expect(body["errors"]).toEqual([
      { path: "email", message: "Invalid email" },
      { path: "name.first", message: "Required" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: ValidationFailedError includes errors[] in wire response
// ---------------------------------------------------------------------------

describe("Scenario 5 — ValidationFailedError includes errors array in response", () => {
  it("errors[] is included and code is VALIDATION_FAILED", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = new ValidationFailedError([
      { path: "email", message: "Must be a valid email" },
      { path: "nif", message: "NIF format invalid" },
    ]);

    errorMiddleware(err, req as never, res as never, nextMock);

    expect(res.statusCode).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(body["code"]).toBe("VALIDATION_FAILED");
    expect(body["errors"]).toEqual([
      { path: "email", message: "Must be a valid email" },
      { path: "nif", message: "NIF format invalid" },
    ]);
  });

  it("AppError subclasses without errors[] do NOT include errors field", () => {
    const req = buildReqMock();
    const res = buildResMock();
    const err = new NotFoundError("not found");

    errorMiddleware(err, req as never, res as never, nextMock);

    const body = res.body as Record<string, unknown>;
    expect("errors" in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: typeSlug derivation (AppError invariant)
// ---------------------------------------------------------------------------

describe("Scenario 6 — typeSlug derives correctly from code", () => {
  it.each([
    ["UnauthorizedError", new UnauthorizedError("x"), "/errors/unauthorized"],
    ["ForbiddenError", new ForbiddenError("x"), "/errors/forbidden"],
    ["NotFoundError", new NotFoundError("x"), "/errors/not-found"],
    ["ValidationFailedError", new ValidationFailedError([]), "/errors/validation-failed"],
  ] as [string, AppError, string][])(
    "%s → typeSlug = %s",
    (_label: string, err: AppError, expectedSlug: string) => {
      expect(err.typeSlug).toBe(expectedSlug);
    },
  );
});
