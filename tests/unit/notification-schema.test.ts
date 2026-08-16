/**
 * Unit tests — Notification schema foundation (notifications Phase 1, TDD — RED → GREEN).
 *
 * Strategy: no database mutation is allowed in Phase 1 (schema + migration file
 * only). Assertions therefore target two generated, DB-independent artifacts:
 *
 *   1. The Prisma Client DMMF (`Prisma.dmmf.datamodel`) — proves `schema.prisma`
 *      declares the `NotificationType` enum and `Notification` model exactly as
 *      designed, and regenerates correctly via `prisma generate`.
 *   2. The generated migration SQL file — proves `prisma migrate dev --create-only`
 *      produced a migration matching the schema (table, columns, FK, index)
 *      WITHOUT applying it to any database.
 *
 * Spec reference: sdd/notifications/spec — "Notification Type Contract".
 * Design reference: sdd/notifications/design — "Schema" section.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "../../prisma/migrations");

/**
 * Locate the `add_notifications` migration directory regardless of its
 * timestamp prefix (Prisma names migrations `{timestamp}_{name}`).
 */
function findNotificationMigrationSql(): string {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith("_add_notifications"))
    .map((d) => d.name);

  const dirName = dirs[0];
  if (!dirName) {
    throw new Error(
      "No migration directory ending in '_add_notifications' found under prisma/migrations",
    );
  }

  const sqlPath = join(MIGRATIONS_DIR, dirName, "migration.sql");
  return readFileSync(sqlPath, "utf-8");
}

// ---------------------------------------------------------------------------
// [S1] NotificationType enum — exact value set, in schema order
// ---------------------------------------------------------------------------
describe("NotificationType enum (DMMF)", () => {
  it("declares exactly the seven designed values, in order (admin-user-management adds ACCOUNT_ACTIVATED)", () => {
    const enumDef = Prisma.dmmf.datamodel.enums.find(
      (e) => e.name === "NotificationType",
    );

    expect(enumDef).toBeDefined();
    expect(enumDef!.values.map((v) => v.name)).toEqual([
      "PAYMENT_CONFIRMED",
      "ORDER_CREATED",
      "SUBORDER_STATUS_CHANGED",
      "TRACKING_ASSIGNED",
      "INCIDENT_REPORTED",
      "INCIDENT_RESOLVED",
      "ACCOUNT_ACTIVATED",
    ]);
  });
});

// ---------------------------------------------------------------------------
// [S2] Notification model — fields, mappings, relation, table name
// ---------------------------------------------------------------------------
describe("Notification model (DMMF)", () => {
  it("maps to table 'notifications' with the designed scalar fields", () => {
    const model = Prisma.dmmf.datamodel.models.find(
      (m) => m.name === "Notification",
    );

    expect(model).toBeDefined();
    expect(model!.dbName).toBe("notifications");

    const byName = Object.fromEntries(model!.fields.map((f) => [f.name, f]));

    expect(byName.userId).toMatchObject({
      type: "String",
      isRequired: true,
      dbName: "user_id",
    });
    expect(byName.type).toMatchObject({
      type: "NotificationType",
      isRequired: true,
    });
    expect(byName.title).toMatchObject({ type: "String", isRequired: true });
    expect(byName.body).toMatchObject({ type: "String", isRequired: true });
    expect(byName.data).toMatchObject({ type: "Json", isRequired: false });
    expect(byName.read).toMatchObject({
      type: "Boolean",
      isRequired: true,
      hasDefaultValue: true,
      default: false,
    });
    expect(byName.readAt).toMatchObject({
      type: "DateTime",
      isRequired: false,
      dbName: "read_at",
    });
    expect(byName.createdAt).toMatchObject({ dbName: "created_at" });
    expect(byName.updatedAt).toMatchObject({ dbName: "updated_at" });
  });

  it("relates to User with onDelete Cascade via userId, and User exposes the back-reference", () => {
    const notification = Prisma.dmmf.datamodel.models.find(
      (m) => m.name === "Notification",
    );
    const userRelation = notification!.fields.find((f) => f.name === "user");

    expect(userRelation).toMatchObject({
      kind: "object",
      type: "User",
      relationFromFields: ["userId"],
      relationOnDelete: "Cascade",
    });

    const user = Prisma.dmmf.datamodel.models.find((m) => m.name === "User");
    const backRef = user!.fields.find((f) => f.name === "notifications");

    expect(backRef).toMatchObject({
      kind: "object",
      type: "Notification",
      isList: true,
    });
  });
});

// ---------------------------------------------------------------------------
// [S3] Migration SQL — table, columns, FK cascade, composite index
// (proves the migration FILE was generated to match the schema — it is
// NEVER applied to a database in this test or in Phase 1 apply work)
// ---------------------------------------------------------------------------
describe("add_notifications migration SQL", () => {
  it("creates the notifications table with FK cascade and the (user_id, read) index", () => {
    const sql = findNotificationMigrationSql();

    expect(sql).toMatch(/CREATE TYPE "NotificationType"/);
    expect(sql).toMatch(/CREATE TABLE "notifications"/);
    expect(sql).toMatch(/"user_id"/);
    expect(sql).toMatch(/"read_at"/);
    expect(sql).toMatch(
      /FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\)[\s\S]*ON DELETE CASCADE/,
    );
    expect(sql).toMatch(/CREATE INDEX "notifications_user_id_read_idx"/);
  });
});
