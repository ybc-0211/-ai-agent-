import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./artifact-check",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-artifact" }]],
  outputDir: "test-results-artifact",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on",
    screenshot: "on",
    video: "on",
  },
  webServer: {
    command: "npm run build && node e2e/server.ts",
    url: "http://127.0.0.1:3100/api/tasks",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
