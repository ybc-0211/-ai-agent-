import { defineConfig, devices } from "@playwright/test";

const allBrowsers = process.env.E2E_ALL_BROWSERS === "1";
const projects = [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }];
if (allBrowsers) {
  projects.push(
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop WebKit"] } },
  );
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && node e2e/server.ts",
    url: "http://127.0.0.1:3100/api/tasks",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects,
});
