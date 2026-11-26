import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface Task {
  id: string;
  title: string;
  done: boolean;
}

async function listTasks(request: APIRequestContext): Promise<Task[]> {
  const response = await request.get("/api/tasks");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Task[];
}

async function seedTask(request: APIRequestContext, title: string): Promise<Task> {
  const response = await request.post("/api/tasks", { data: { title } });
  expect(response.status()).toBe(201);
  return (await response.json()) as Task;
}

async function openChat(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel("消息", { exact: true }).fill(text);
  await page.getByLabel("发送消息", { exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  const tasks = await listTasks(request);
  for (const task of tasks) {
    const response = await request.delete(`/api/tasks/${task.id}`);
    expect(response.status()).toBe(204);
  }
});

test("E2E 创建任务：自然语言 → Agent 工具 → TaskStore", async ({ page, request }) => {
  await openChat(page);
  await sendMessage(page, "帮我记一下买牛奶");

  await expect(page.locator(".message.assistant").last()).toContainText("已创建任务「买牛奶」");
  const tasks = await listTasks(request);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ title: "买牛奶", done: false });
});

test("E2E 查询任务：工具结果返回真实清单", async ({ page, request }) => {
  await seedTask(request, "买牛奶");
  await openChat(page);
  await sendMessage(page, "我有哪些任务？");

  await expect(page.locator(".message.assistant").last()).toContainText("- [ ] 买牛奶");
  expect(await listTasks(request)).toHaveLength(1);
});

test("E2E 完成任务：名称匹配后真实更新状态", async ({ page, request }) => {
  await seedTask(request, "买牛奶");
  await openChat(page);
  await sendMessage(page, "牛奶买好了");

  await expect(page.locator(".message.assistant").last()).toContainText("已把「买牛奶」标记为完成");
  const tasks = await listTasks(request);
  expect(tasks[0]).toMatchObject({ title: "买牛奶", done: true });
});

test("E2E 删除任务：真实删除且从清单移除", async ({ page, request }) => {
  await seedTask(request, "取快递");
  await openChat(page);
  await sendMessage(page, "取快递这条删掉吧");

  await expect(page.locator(".message.assistant").last()).toContainText("已删除任务「取快递」");
  expect(await listTasks(request)).toHaveLength(0);
});

test("E2E 不存在的任务：返回 not_found 且不修改数据", async ({ page, request }) => {
  await seedTask(request, "买牛奶");
  await openChat(page);
  await sendMessage(page, "删除不存在的任务");

  await expect(page.locator(".message.assistant").last()).toContainText("没有找到「不存在的任务」");
  const tasks = await listTasks(request);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.done).toBe(false);
});

test("E2E 重复任务名称：返回歧义且不擅自完成", async ({ page, request }) => {
  await seedTask(request, "买牛奶");
  await seedTask(request, "买牛奶");
  await openChat(page);
  await sendMessage(page, "完成买牛奶");

  await expect(page.locator(".message.assistant").last()).toContainText("找到多条匹配「买牛奶」");
  await expect(page.locator(".message.assistant").last()).toContainText("第 1 条");
  const tasks = await listTasks(request);
  expect(tasks).toHaveLength(2);
  expect(tasks.every((task) => task.done === false)).toBe(true);
});

test("E2E 模型超时/异常：返回安全兜底，不影响任务数据", async ({ page, request }) => {
  await openChat(page);
  await sendMessage(page, "模拟模型错误");

  await expect(page.locator(".message.assistant").last()).toContainText(
    "模型请求超时，请稍后再试。",
  );
  expect(await listTasks(request)).toHaveLength(0);
});

test("E2E API 无效输入与不存在任务", async ({ request }) => {
  const invalidTitle = await request.post("/api/tasks", { data: { title: "   " } });
  expect(invalidTitle.status()).toBe(400);

  const missingPatch = await request.patch("/api/tasks/not-found", { data: { done: true } });
  expect(missingPatch.status()).toBe(404);

  const missingDelete = await request.delete("/api/tasks/not-found");
  expect(missingDelete.status()).toBe(404);

  const invalidChat = await request.post("/api/chat", { data: { messages: [] } });
  expect(invalidChat.status()).toBe(400);
});
