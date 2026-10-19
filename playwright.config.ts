import { defineConfig, devices } from "@playwright/test";

// UI end-to-end tests against a running stack (pnpm dev:* or docker compose with the Meta mock).
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", ignoreHTTPSErrors: Boolean(process.env.E2E_IGNORE_HTTPS_ERRORS), screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /smoke/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /smoke/ },
  ],
});
