/**
 * Unit tests — postgres-tools.ts (design threat matrix: PATH-relative
 * rejection, wrong-major rejection, symlink/non-executable rejection, shell
 * metacharacter literal handling).
 *
 * Runtime harness: real fake `sh` scripts (chmod +x) spawned via real
 * `spawn(shell:false)` under a real temp directory — no mocking of the
 * process boundary. Only `--version`/`--list`/`--file` behavior is faked;
 * the real `pg_dump`/`pg_restore` binaries are never invoked.
 *
 * Spec: admin-database-backups — "Trusted PostgreSQL runtime".
 */
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupOperationFailedError, BackupRuntimeUnavailableError } from "@/shared/errors/errors";
import {
  assertTrustedExecutable,
  dumpDatabase,
  listArchiveContents,
  parsePostgresUrl,
  restoreArchive,
} from "@/shared/database-backups/postgres-tools";

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "postgres-tools-test-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/** Writes a real, executable `sh` script and returns its absolute path. */
async function writeFakeTool(name: string, script: string): Promise<string> {
  const scriptPath = join(baseDir, name);
  await writeFile(scriptPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return scriptPath;
}

const FAKE_PG_DUMP_16 = `
if [ "$1" = "--version" ]; then
  echo "pg_dump (PostgreSQL) 16.4"
  exit 0
fi
outfile=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--file" ]; then outfile="$arg"; fi
  prev="$arg"
done
{
  echo "PGHOST=$PGHOST"
  echo "PGPORT=$PGPORT"
  echo "PGUSER=$PGUSER"
  echo "PGDATABASE=$PGDATABASE"
  echo "PASSFILE_MODE=$(stat -c %a "$PGPASSFILE")"
  echo "PASSFILE_CONTENTS=$(cat "$PGPASSFILE")"
} > "$outfile"
exit 0
`;

const FAKE_PG_RESTORE_16 = `
if [ "$1" = "--version" ]; then
  echo "pg_restore (PostgreSQL) 16.2"
  exit 0
fi
if [ "$1" = "--list" ]; then
  echo "ARCHIVE_ARG:$2"
  exit 0
fi
exit 0
`;

const LOOPBACK_SOURCE = {
  host: "127.0.0.1",
  port: 5432,
  user: "mercado",
  password: "secret-pass",
  database: "mercado_dev",
};

// ---------------------------------------------------------------------------
// RED — assertTrustedExecutable
// ---------------------------------------------------------------------------
describe("assertTrustedExecutable: RED coverage", () => {
  it("rejects a relative path without touching the filesystem", async () => {
    await expect(assertTrustedExecutable("pg_dump", "pg_dump")).rejects.toBeInstanceOf(
      BackupRuntimeUnavailableError,
    );
  });

  it("rejects a PATH-style relative directory path", async () => {
    await expect(assertTrustedExecutable("./bin/pg_dump", "pg_dump")).rejects.toBeInstanceOf(
      BackupRuntimeUnavailableError,
    );
  });

  it("rejects a symlinked executable", async () => {
    const real = await writeFakeTool("real-pg_dump", FAKE_PG_DUMP_16);
    const linkPath = join(baseDir, "linked-pg_dump");
    await symlink(real, linkPath);

    await expect(assertTrustedExecutable(linkPath, "pg_dump")).rejects.toBeInstanceOf(
      BackupRuntimeUnavailableError,
    );
  });

  it("rejects a non-executable regular file", async () => {
    const filePath = join(baseDir, "not-executable");
    await writeFile(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    await expect(assertTrustedExecutable(filePath, "pg_dump")).rejects.toBeInstanceOf(
      BackupRuntimeUnavailableError,
    );
  });

  it("rejects a wrong major version (15 instead of 16)", async () => {
    const execPath = await writeFakeTool(
      "pg_dump_v15",
      `if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 15.4"; exit 0; fi`,
    );

    await expect(assertTrustedExecutable(execPath, "pg_dump")).rejects.toBeInstanceOf(
      BackupRuntimeUnavailableError,
    );
  });

  it("accepts an absolute, regular, executable, major-16 tool", async () => {
    const execPath = await writeFakeTool("pg_dump_v16", FAKE_PG_DUMP_16);

    await expect(assertTrustedExecutable(execPath, "pg_dump")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RED — loopback-only URL parsing
// ---------------------------------------------------------------------------
describe("parsePostgresUrl: RED coverage", () => {
  it("rejects an invalid URL", () => {
    expect(() => parsePostgresUrl("not-a-url")).toThrow(BackupRuntimeUnavailableError);
  });

  it("rejects a non-postgres scheme", () => {
    expect(() => parsePostgresUrl("http://127.0.0.1:5432/db")).toThrow(
      BackupRuntimeUnavailableError,
    );
  });

  it("rejects a non-loopback host", () => {
    expect(() => parsePostgresUrl("postgres://u:p@db.example.com:5432/db")).toThrow(
      BackupRuntimeUnavailableError,
    );
  });

  it("accepts 127.0.0.1 (IPv4 loopback)", () => {
    const parsed = parsePostgresUrl("postgres://u:p@127.0.0.1:5433/mercado_test");
    expect(parsed).toMatchObject({ host: "127.0.0.1", port: 5433, database: "mercado_test" });
  });

  it("accepts localhost", () => {
    const parsed = parsePostgresUrl("postgres://u:p@localhost/mercado_dev");
    expect(parsed).toMatchObject({ host: "localhost", port: 5432 });
  });
});

// ---------------------------------------------------------------------------
// RED — shell metacharacter literal handling (spawn(shell:false) proof)
// ---------------------------------------------------------------------------
describe("listArchiveContents: shell metacharacter literal handling", () => {
  it("passes a metacharacter-laden archive path literally, never shell-interpreted", async () => {
    const execPath = await writeFakeTool("pg_restore_metachar", FAKE_PG_RESTORE_16);
    const markerPath = join(baseDir, `pwned-marker-${Date.now()}.txt`);
    const maliciousArchivePath = `/tmp/fake-archive.dump; touch ${markerPath}; echo`;

    const output = await listArchiveContents(execPath, maliciousArchivePath);

    expect(output).toContain(`ARCHIVE_ARG:${maliciousArchivePath}`);
    await expect(readFile(markerPath)).rejects.toThrow(); // proves `touch` never ran
  });

  it("throws BackupOperationFailedError when pg_restore --list exits non-zero", async () => {
    const execPath = await writeFakeTool("pg_restore_fail", `exit 1`);

    await expect(listArchiveContents(execPath, "/tmp/archive.dump")).rejects.toBeInstanceOf(
      BackupOperationFailedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Fixed vectors — dump/restore env + PGPASSFILE plumbing and cleanup
// ---------------------------------------------------------------------------
describe("dumpDatabase: fixed vectors and PGPASSFILE plumbing", () => {
  it("invokes pg_dump with fixed args and a 0600 PGPASSFILE, then removes it", async () => {
    const execPath = await writeFakeTool("pg_dump_env", FAKE_PG_DUMP_16);
    const outputPath = join(baseDir, "output.dump");

    await dumpDatabase(execPath, LOOPBACK_SOURCE, outputPath);

    const content = await readFile(outputPath, "utf8");
    expect(content).toContain("PGHOST=127.0.0.1");
    expect(content).toContain("PGPORT=5432");
    expect(content).toContain("PGUSER=mercado");
    expect(content).toContain("PGDATABASE=mercado_dev");
    expect(content).toContain("PASSFILE_MODE=600");
    expect(content).toContain("PASSFILE_CONTENTS=*:*:*:*:secret-pass");

    // Cleanup evidence: no leftover pgpass-* temp file after the call.
    const tmpEntries = await readdir(tmpdir());
    expect(tmpEntries.some((entry) => entry.startsWith("pgpass-"))).toBe(false);
  });

  it("throws BackupOperationFailedError and still cleans up when pg_dump exits non-zero", async () => {
    const execPath = await writeFakeTool("pg_dump_fail", `exit 1`);

    await expect(
      dumpDatabase(execPath, LOOPBACK_SOURCE, join(baseDir, "unused.dump")),
    ).rejects.toBeInstanceOf(BackupOperationFailedError);

    const tmpEntries = await readdir(tmpdir());
    expect(tmpEntries.some((entry) => entry.startsWith("pgpass-"))).toBe(false);
  });

  it("rejects an aborted dump only after the child has terminated", async () => {
    const readyPath = join(baseDir, "ready");
    const terminatedPath = join(baseDir, "terminated");
    const execPath = await writeFakeTool(
      "pg_dump_hung",
      `touch '${readyPath}'
trap "touch '${terminatedPath}'; exit 0" TERM
while :; do sleep 1; done`,
    );
    const controller = new AbortController();
    const failure = new BackupOperationFailedError("timed out");
    const dump = dumpDatabase(
      execPath,
      LOOPBACK_SOURCE,
      join(baseDir, "unused.dump"),
      controller.signal,
    );

    await vi.waitFor(() => expect(access(readyPath)).resolves.toBeUndefined());
    controller.abort(failure);

    await expect(dump).rejects.toBe(failure);
    await expect(access(terminatedPath)).resolves.toBeUndefined();
  });
});

describe("restoreArchive: fixed vectors", () => {
  it("invokes pg_restore with --dbname set to the target database", async () => {
    const execPath = await writeFakeTool(
      "pg_restore_dbname",
      `
prev=""
dbname=""
for arg in "$@"; do
  if [ "$prev" = "--dbname" ]; then dbname="$arg"; fi
  prev="$arg"
done
echo "DBNAME=$dbname"
exit 0
`,
    );

    await expect(
      restoreArchive(execPath, LOOPBACK_SOURCE, join(baseDir, "archive.dump")),
    ).resolves.toBeUndefined();
  });

  it("throws BackupOperationFailedError when pg_restore exits non-zero", async () => {
    const execPath = await writeFakeTool("pg_restore_fail2", `exit 1`);

    await expect(
      restoreArchive(execPath, LOOPBACK_SOURCE, join(baseDir, "archive.dump")),
    ).rejects.toBeInstanceOf(BackupOperationFailedError);
  });
});
