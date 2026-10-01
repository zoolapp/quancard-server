import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dataDir = mkdtempSync(join(tmpdir(), "quancard-e2e-"));
export const E2E_SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token-0123456789abcdef";
/** Set E2E_BASE_URL (and E2E_SETUP_TOKEN) to run the story against an already running container. */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: external ?? "http://localhost:8788",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    ignoreHTTPSErrors: !!external,
  },
  webServer: external
    ? undefined
    : {
        command: "node apps/server/dist/main.js",
        url: "http://localhost:8788/healthz",
        reuseExistingServer: false,
        timeout: 30_000,
        env: {
          QC_SECRET: "ab".repeat(32),
          QC_SETUP_TOKEN: E2E_SETUP_TOKEN,
          QC_ALLOW_INSECURE_LOCALHOST: "1",
          QC_DATA_DIR: dataDir,
          QC_WEB_ROOT: "apps/web/dist",
          QC_PORT: "8788",
          QC_HOST: "127.0.0.1",
          QC_VERSION: "e2e",
        },
      },
});
