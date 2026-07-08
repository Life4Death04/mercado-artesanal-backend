/**
 * Admin bootstrap CLI — create the first admin user.
 *
 * Usage:
 *   npm run create-admin -- --email <email> --auth0-sub <sub> [--first-name <name>] [--last-name <name>]
 *
 * Exit codes (spec: admin-bootstrap §"create-admin CLI script", design §18):
 *   0 — success
 *   1 — argument validation failed (missing required flags or invalid values)
 *   2 — an active admin already exists; see docs/admin-recovery.md
 *   3 — unexpected error (DB connection, write failure, etc.)
 *
 * Spec invariants (LOCKED):
 *   - Zod validates arguments BEFORE any DB connection is opened (spec ordering).
 *   - If any User with role=ADMIN and deletedAt=null already exists, the script
 *     MUST exit 2 without creating a new user.
 *   - No flag may bypass the "one admin" guard; recovery requires SQL (docs/admin-recovery.md).
 *
 * Spec references:
 *   admin-bootstrap §"create-admin CLI script"
 *   design §18 — authoritative pseudocode
 *   ADR-006 — least-privilege admin creation
 */
import { parseArgs } from "node:util";

import { z } from "zod";

import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Argument validation schema (Zod)
// Parsed BEFORE any DB connection per spec ordering requirement.
// ---------------------------------------------------------------------------

const ArgsSchema = z.object({
  email: z.string().email({ message: "--email must be a valid email address" }),
  "auth0-sub": z.string().min(1, { message: "--auth0-sub must not be empty" }),
  "first-name": z.string().default("Admin"),
  "last-name": z.string().default("User"),
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: Parse and validate CLI arguments.
  // Zod runs BEFORE the prisma singleton is accessed (spec ordering).
  let rawValues: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        email: { type: "string" },
        "auth0-sub": { type: "string" },
        "first-name": { type: "string" },
        "last-name": { type: "string" },
      },
      strict: true, // unknown flags → throws
    });
    rawValues = parsed.values;
  } catch (parseErr) {
    process.stderr.write(`Error parsing arguments: ${String(parseErr)}\n`);
    process.stderr.write(
      "Usage: npm run create-admin -- --email <email> --auth0-sub <sub> [--first-name <name>] [--last-name <name>]\n",
    );
    process.exit(1);
  }

  const validation = ArgsSchema.safeParse(rawValues);
  if (!validation.success) {
    process.stderr.write(
      "Usage: npm run create-admin -- --email <email> --auth0-sub <sub> [--first-name <name>] [--last-name <name>]\n",
    );
    // Print each field error so the operator knows exactly what is wrong.
    for (const issue of validation.error.issues) {
      process.stderr.write(`  ${issue.path.join(".") || "root"}: ${issue.message}\n`);
    }
    process.exit(1);
  }

  const args = validation.data;

  // Step 2: Guard — reject if an active admin already exists.
  const existing = await prisma.user.count({ where: { role: "ADMIN", deletedAt: null } });
  if (existing > 0) {
    process.stderr.write(
      "An active admin already exists. Refer to docs/admin-recovery.md for recovery procedures.\n",
    );
    process.exit(2);
  }

  // Step 3: Create the admin user.
  const user = await prisma.user.create({
    data: {
      email: args.email,
      auth0Sub: args["auth0-sub"],
      firstName: args["first-name"],
      lastName: args["last-name"],
      emailVerified: false,
      role: "ADMIN",
    },
  });

  process.stdout.write(`Admin created: id=${user.id}\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`Unexpected error: ${String(err)}\n`);
  process.exit(3);
});
