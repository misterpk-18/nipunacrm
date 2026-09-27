import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the dev stack only: Flask on :5050 with APP_ENV=development
 * (nipunacrm-dev, seeded by `flask seed-dev`) and Vite on :5173. Start both first (see README).
 * Tests create records, so re-seed (`flask create-dev-db --yes && flask seed-dev`) for a clean run.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:5173", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
});
