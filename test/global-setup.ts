// Applies migrations to the dedicated test database (non-destructive). Tests truncate their own rows.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://sandalez:sandalez@localhost:5433/sandalez_test?schema=public";
  execSync("pnpm exec prisma migrate deploy", {
    cwd: fileURLToPath(new URL("../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
