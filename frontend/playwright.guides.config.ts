import { defineConfig, devices } from "@playwright/test";

/**
 * Role guides (PDF): captures annotated screenshots from the dev stack and builds one PDF per role into
 * ../guides/. Same prerequisites as the e2e suite: Flask on :5050 (nipunacrm-dev) and Vite on :5173.
 *
 *   npx playwright test -c playwright.guides.config.ts demo-data          # once: realistic demo records
 *   npx playwright test -c playwright.guides.config.ts sales              # capture one role
 *   npx playwright test -c playwright.guides.config.ts build              # build every captured role's PDF
 *
 * Files end in .guide.ts so the regular e2e run (./e2e, *.spec.ts) never picks them up.
 */
export default defineConfig({
  testDir: "./e2e/guides",
  testMatch: /.*\.guide\.ts/,
  // one folder per run, so guides captured in parallel never wipe each other's traces
  outputDir: `test-results/guides-${process.pid}`,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:5173",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    trace: "retain-on-failure",
  },
});
