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
import "dotenv/config";
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
// Deps injection interface — allows unit-testing without a real DB
// ---------------------------------------------------------------------------

export interface CreateAdminDeps {
  countAdmins: () => Promise<number>;
  createUser: (data: {
    email: string;
    auth0Sub: string;
    firstName: string;
    lastName: string;
    emailVerified: boolean;
    role: "ADMIN";
  }) => Promise<{ id: string }>;
  stderr: (msg: string) => void;
  stdout: (msg: string) => void;
  exit: (code: number) => never;
}

// ---------------------------------------------------------------------------
// Core logic — injectable for testing
// ---------------------------------------------------------------------------

export async function runCreateAdmin(
  argv: string[],
  deps: CreateAdminDeps,
): Promise<void> {
  // Step 1: Parse and validate CLI arguments.
  // Zod runs BEFORE the prisma singleton is accessed (spec ordering).
  let rawValues: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({
      args: argv,
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
    deps.stderr(`Error parsing arguments: ${String(parseErr)}\n`);
    deps.stderr(
      "Usage: npm run create-admin -- --email <email> --auth0-sub <sub> [--first-name <name>] [--last-name <name>]\n",
    );
    deps.exit(1);
  }

  const validation = ArgsSchema.safeParse(rawValues);
  if (!validation.success) {
    deps.stderr(
      "Usage: npm run create-admin -- --email <email> --auth0-sub <sub> [--first-name <name>] [--last-name <name>]\n",
    );
    // Print each field error so the operator knows exactly what is wrong.
    for (const issue of validation.error.issues) {
      deps.stderr(`  ${issue.path.join(".") || "root"}: ${issue.message}\n`);
    }
    deps.exit(1);
  }

  const args = validation.data;

  // Step 2: Guard — reject if an active admin already exists.
  const existing = await deps.countAdmins();
  if (existing > 0) {
    deps.stderr(
      "An active admin already exists. Refer to docs/admin-recovery.md for recovery procedures.\n",
    );
    deps.exit(2);
  }

  // Step 3: Create the admin user.
  const user = await deps.createUser({
    email: args.email,
    auth0Sub: args["auth0-sub"],
    firstName: args["first-name"],
    lastName: args["last-name"],
    emailVerified: false,
    role: "ADMIN",
  });

  deps.stdout(`Admin created: id=${user.id}\n`);
  deps.exit(0);
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

// Guard: skip auto-run when this module is imported (e.g. by unit tests).
// In CJS output (module: node16 + .ts extension), `require.main === module`
// is true only when the file is the Node.js entry point, not when imported.
if (require.main === module) {
  runCreateAdmin(process.argv.slice(2), {
    countAdmins: () => prisma.user.count({ where: { role: "ADMIN", deletedAt: null } }),
    createUser: (data) => prisma.user.create({ data }),
    stderr: (msg) => process.stderr.write(msg),
    stdout: (msg) => process.stdout.write(msg),
    exit: (code) => process.exit(code),
  }).catch((err: unknown) => {
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
    process.exit(3);
  });
}
