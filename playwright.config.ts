import { defineConfig } from "@playwright/test";

/**
 * The browser tests (`pnpm e2e`): Chromium with the unpacked development build (`pnpm build:dev`)
 * loaded from dist/. They are skipped unless KNOWTARIUM_E2E_EXTENSION is set: `smoke` runs the
 * checks that need no server (the API is answered by the test), `full` adds the run against the
 * local sync API (http://localhost:8790) and web app (http://localhost:3005). See the README.
 */
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
});
