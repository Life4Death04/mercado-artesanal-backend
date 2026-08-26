import { beforeEach, describe, expect, it, vi } from "vitest";

const { createUser } = vi.hoisted(() => ({ createUser: vi.fn() }));

vi.mock("@/shared/utils/prisma", () => ({
  prisma: { user: { create: createUser } },
}));

import * as userRepository from "@/shared/repositories/user.repository";

describe("user repository email writes", () => {
  beforeEach(() => {
    createUser.mockReset();
    createUser.mockResolvedValue({ id: "user-id" });
  });

  it("lowercases email at the persistence boundary", async () => {
    await userRepository.create({
      auth0Sub: "auth0|mixed-case",
      email: "Mixed.Case@Example.COM",
      emailVerified: true,
    });

    expect(createUser).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: "mixed.case@example.com" }),
    });
  });
});
