import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const port = 3101;
const baseURL = `http://127.0.0.1:${port}`;
const screenshotsDir = join("docs", "screenshots");
const dataFile = join("test-results", "demo-tasks.json");

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/tasks`);
      if (response.ok) return;
    } catch {
      // server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("E2E demo server did not start in time.");
}

async function send(page: Page, text: string, expected: string): Promise<void> {
  await page.getByLabel("消息", { exact: true }).fill(text);
  await page.getByLabel("发送消息", { exact: true }).click();
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll(".message.assistant")].some((node) =>
        node.textContent?.includes(value),
      ),
    expected,
  );
  await page.waitForTimeout(250);
}

async function main(): Promise<void> {
  await mkdir(screenshotsDir, { recursive: true });
  await rm(dataFile, { force: true });

  const server = spawn(process.execPath, ["e2e/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      E2E_PORT: String(port),
      E2E_TASKS_FILE: dataFile,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForServer();
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: screenshotsDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    const video = page.video();

    await page.goto(baseURL);
    await page.getByLabel("消息", { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshotsDir, "01-main.png"), fullPage: true });

    await page.getByLabel("任务标题", { exact: true }).fill("准备项目演示");
    await page.getByLabel("任务优先级", { exact: true }).selectOption("high");
    await page.getByLabel("截止日期", { exact: true }).fill("2026-12-01");
    await page.getByRole("button", { name: "添加任务", exact: true }).click();
    await page
      .getByTestId(/^task-row-/)
      .filter({ hasText: "准备项目演示" })
      .waitFor();
    await page
      .getByTestId(/^task-row-/)
      .filter({ hasText: "准备项目演示" })
      .getByRole("button", { name: "子任务", exact: true })
      .click();
    await page.getByLabel("任务标题", { exact: true }).fill("整理演示脚本");
    await page.getByRole("button", { name: "添加任务", exact: true }).click();
    await page.getByText("整理演示脚本", { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshotsDir, "06-task-panel.png"), fullPage: true });

    await send(page, "帮我记一下买牛奶", "已创建任务「买牛奶」");
    await page.screenshot({ path: join(screenshotsDir, "02-create.png"), fullPage: true });

    await send(page, "再记一条取快递", "已创建任务「取快递」");
    await send(page, "我有哪些任务？", "- [ ] 买牛奶");
    await page.screenshot({ path: join(screenshotsDir, "03-query.png"), fullPage: true });

    await send(page, "牛奶买好了", "已把「买牛奶」标记为完成");
    await page.screenshot({ path: join(screenshotsDir, "04-complete.png"), fullPage: true });

    await send(page, "取快递这条删掉吧", "已删除任务「取快递」");
    await page.screenshot({ path: join(screenshotsDir, "05-delete.png"), fullPage: true });

    await context.close();
    if (video) {
      const videoPath = await video.path();
      await rename(videoPath, join(screenshotsDir, "demo.webm"));
    }
  } finally {
    await browser?.close();
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.log("Captured screenshots and video in docs/screenshots/.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo capture failed.");
  process.exitCode = 1;
});
