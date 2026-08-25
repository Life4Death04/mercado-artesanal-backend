import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN_ID = Date.now();
const DUPLICATE_DB = `mercado_test_invitation_duplicate_${RUN_ID}`;
const CLEAN_DB = `mercado_test_invitation_clean_${RUN_ID}`;
const TARGET_MIGRATION = "20260825000000_admin_invitations";
const migrationPath = path.join(process.cwd(), "prisma", "migrations", TARGET_MIGRATION);
const hiddenMigrationPath = path.join(process.cwd(), `.hidden-${TARGET_MIGRATION}`);
const migrationSql = readFileSync(path.join(migrationPath, "migration.sql"), "utf8");
const admin = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres:postgres@localhost:5433/mercado_test" } },
});
let dbReachable = false;

function dbUrl(name: string): string {
  return `postgresql://postgres:postgres@localhost:5433/${name}`;
}

function deploy(url: string): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}

beforeAll(async () => {
  try {
    await admin.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    return;
  }

  if (!existsSync(migrationPath)) throw new Error(`Missing migration: ${migrationPath}`);
  renameSync(migrationPath, hiddenMigrationPath);
  try {
    for (const name of [DUPLICATE_DB, CLEAN_DB]) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      deploy(dbUrl(name));
    }
  } finally {
    renameSync(hiddenMigrationPath, migrationPath);
  }
});

afterAll(async () => {
  if (existsSync(hiddenMigrationPath)) renameSync(hiddenMigrationPath, migrationPath);
  for (const name of [DUPLICATE_DB, CLEAN_DB]) {
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch {
      // Best-effort cleanup of disposable databases.
    }
  }
  await admin.$disconnect();
});

describe("admin invitation persistence migration", () => {
  it("keeps the duplicate audit and raw persistence invariants in the migration", () => {
    expect(migrationSql).toContain('GROUP BY LOWER("email")');
    expect(migrationSql).toContain("HAVING COUNT(*) > 1");
    expect(migrationSql).not.toContain('WHERE "deleted_at" IS NULL');
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users" (LOWER("email"))',
    );
    expect(migrationSql).toContain('CONSTRAINT "admin_invitations_email_lowercase_check"');
    expect(migrationSql).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
    expect(migrationSql).toContain("ON DELETE SET NULL ON UPDATE CASCADE");
  });

  it("rejects case-insensitive duplicates, including a soft-deleted user", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const db = new PrismaClient({ datasources: { db: { url: dbUrl(DUPLICATE_DB) } } });
    try {
      await db.user.createMany({
        data: [
          { auth0Sub: "auth0|active", email: "Admin@Example.com" },
          {
            auth0Sub: "auth0|deleted",
            email: "admin@example.COM",
            deletedAt: new Date(),
          },
        ],
      });

      expect(() => deploy(dbUrl(DUPLICATE_DB))).toThrow(/users_email_lower_key/);
    } finally {
      await db.$disconnect();
    }
  }, 60000);

  it("creates durable-operation constraints and the functional user-email index", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    deploy(dbUrl(CLEAN_DB));
    const db = new PrismaClient({ datasources: { db: { url: dbUrl(CLEAN_DB) } } });
    try {
      const creator = await db.user.create({
        data: { auth0Sub: "auth0|creator", email: "creator@example.com", role: "ADMIN" },
      });
      await expect(
        db.user.create({ data: { auth0Sub: "auth0|duplicate", email: "CREATOR@example.com" } }),
      ).rejects.toThrow();

      await db.$executeRawUnsafe(
        `INSERT INTO admin_invitations (id, request_key, email, created_by_id, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        "invitation-1",
        "request-1",
        "future.admin@example.com",
        creator.id,
      );
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO admin_invitations (id, request_key, email, created_by_id, updated_at)
           VALUES ($1, $2, $3, $4, now())`,
          "invitation-2",
          "request-1",
          "other@example.com",
          creator.id,
        ),
      ).rejects.toThrow();
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO admin_invitations (id, request_key, email, created_by_id, updated_at)
           VALUES ($1, $2, $3, $4, now())`,
          "invitation-3",
          "request-3",
          "Mixed@Example.com",
          creator.id,
        ),
      ).rejects.toThrow();

      const indexes = await db.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'admin_invitations'`;
      expect(indexes.map(({ indexname }) => indexname)).toEqual(
        expect.arrayContaining([
          "admin_invitations_request_key_key",
          "admin_invitations_status_next_attempt_at_idx",
          "admin_invitations_status_lease_expires_at_idx",
          "admin_invitations_created_by_id_created_at_id_idx",
        ]),
      );
    } finally {
      await db.$disconnect();
    }
  }, 60000);
});
