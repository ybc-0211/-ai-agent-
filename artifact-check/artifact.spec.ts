import { expect, test } from "@playwright/test";

test("artifact validation: controlled failure captures trace, screenshot and video", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("任务清单")).toBeVisible();
  await page.screenshot({ path: "test-results-artifact/intentional-failure.png" });

  // This assertion is intentionally false. This test must not run in normal CI.
  expect(false, "intentional artifact validation failure").toBe(true);
});
