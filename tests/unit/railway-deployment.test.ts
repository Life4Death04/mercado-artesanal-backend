import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");

function readRootFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("Railway deployment contract", () => {
  it("builds the Dockerfile, deploys migrations first, and gates activation on readiness", () => {
    const config = JSON.parse(readRootFile("railway.json")) as {
      $schema: string;
      build: { builder: string; dockerfilePath: string };
      deploy: {
        preDeployCommand: string;
        healthcheckPath: string;
        healthcheckTimeout: number;
      };
    };

    expect(config.$schema).toBe("https://railway.com/railway.schema.json");
    expect(config.build).toEqual({ builder: "DOCKERFILE", dockerfilePath: "Dockerfile" });
    expect(config.deploy.preDeployCommand).toBe("npm run db:deploy");
    expect(config.deploy.preDeployCommand).not.toContain("npx");
    expect(config.deploy.healthcheckPath).toBe("/health/ready");
    expect(config.deploy.healthcheckTimeout).toBe(300);
  });

  it("ships the local Prisma CLI and migration inputs in the non-root runtime image", () => {
    const packageJson = JSON.parse(readRootFile("package.json")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const dockerfile = readRootFile("Dockerfile");
    const runtime = dockerfile.split("FROM base AS runtime\n")[1];

    expect(packageJson.scripts["db:deploy"]).toBe("prisma migrate deploy");
    expect(packageJson.dependencies.prisma).toBe(packageJson.dependencies["@prisma/client"]);
    expect(packageJson.devDependencies.prisma).toBeUndefined();
    expect(dockerfile).toMatch(/FROM base AS production-dependencies[\s\S]*npm ci --omit=dev/);
    expect(runtime).toBeDefined();
    expect(runtime).toContain(
      "COPY --from=production-dependencies /app/node_modules ./node_modules",
    );
    expect(runtime).toContain("prisma/schema.prisma ./prisma/schema.prisma");
    expect(runtime).toContain("prisma/migrations ./prisma/migrations");
    expect(runtime).toMatch(/USER node[\s\S]*CMD \["node", "dist\/server\.js"\]/);
  });

  it("retains the separately targetable migration image", () => {
    const dockerfile = readRootFile("Dockerfile");
    const migration = dockerfile
      .split("FROM base AS migration\n")[1]
      ?.split("FROM base AS runtime\n")[0];

    expect(migration).toBeDefined();
    expect(migration).toContain("COPY --from=dependencies /app/node_modules ./node_modules");
    expect(migration).toContain("prisma/migrations ./prisma/migrations");
    expect(migration).toContain(
      'CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"]',
    );
  });
});
