import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface Task {
  id: string;
  title: string;
  done: boolean;
  priority?: "low" | "medium" | "high";
  dueDate?: string | null;
  parentId?: string;
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

test("E2E 任务面板：创建优先级、截止日期并刷新持久化", async ({ page, request }) => {
  await openChat(page);
  await page.getByLabel("任务标题", { exact: true }).fill("写报告");
  await page.getByLabel("任务优先级", { exact: true }).selectOption("high");
  await page.getByLabel("截止日期", { exact: true }).fill("2026-12-01");
  await page.getByRole("button", { name: "添加任务", exact: true }).click();

  await expect(page.getByTestId(/^task-row-/).filter({ hasText: "写报告" })).toBeVisible();
  let tasks = await listTasks(request);
  expect(tasks[0]).toMatchObject({
    title: "写报告",
    priority: "high",
    dueDate: "2026-12-01",
    done: false,
  });

  await page.reload();
  await expect(page.getByTestId(/^task-row-/).filter({ hasText: "写报告" })).toBeVisible();
  tasks = await listTasks(request);
  expect(tasks[0]?.title).toBe("写报告");
});

test("E2E 任务面板：完成、重新打开和状态/优先级筛选", async ({ page, request }) => {
  const high = await seedTask(request, "高优先级任务");
  await request.patch(`/api/tasks/${high.id}`, { data: { priority: "high" } });
  const low = await seedTask(request, "低优先级任务");
  await request.patch(`/api/tasks/${low.id}`, { data: { priority: "low" } });
  const completed = await seedTask(request, "已完成任务");
  await request.patch(`/api/tasks/${completed.id}`, { data: { done: true } });

  await openChat(page);
  await page.getByLabel("状态筛选", { exact: true }).selectOption("open");
  await expect(page.getByTestId(`task-row-${high.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-row-${completed.id}`)).toHaveCount(0);

  await page.getByLabel("优先级筛选", { exact: true }).selectOption("high");
  await expect(page.getByTestId(`task-row-${high.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-row-${low.id}`)).toHaveCount(0);

  await page.getByLabel("优先级筛选", { exact: true }).selectOption("all");
  await page.getByLabel(`完成任务「高优先级任务」`, { exact: true }).click();
  await page.getByLabel("状态筛选", { exact: true }).selectOption("completed");
  await expect(page.getByLabel(`重新打开任务「高优先级任务」`, { exact: true })).toBeVisible();
  expect((await listTasks(request)).find((task) => task.id === high.id)?.done).toBe(true);

  await page.getByLabel(`重新打开任务「高优先级任务」`, { exact: true }).click();
  await page.getByLabel("状态筛选", { exact: true }).selectOption("all");
  await expect(page.getByLabel(`完成任务「高优先级任务」`, { exact: true })).toBeVisible();
  expect((await listTasks(request)).find((task) => task.id === high.id)?.done).toBe(false);
});

test("E2E 任务面板：编辑任务和子任务新增/删除", async ({ page, request }) => {
  const parent = await seedTask(request, "准备面试");
  await openChat(page);

  const parentRow = page.getByTestId(`task-row-${parent.id}`);
  await parentRow.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("编辑任务标题", { exact: true }).fill("准备技术面试");
  await page.getByLabel("编辑任务优先级", { exact: true }).selectOption("high");
  await page.getByLabel("编辑截止日期", { exact: true }).fill("2026-12-15");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.getByTestId(`task-row-${parent.id}`)).toContainText("准备技术面试");
  let tasks = await listTasks(request);
  expect(tasks[0]).toMatchObject({
    title: "准备技术面试",
    priority: "high",
    dueDate: "2026-12-15",
  });

  await page.getByTestId(`task-row-${parent.id}`).getByRole("button", { name: "子任务" }).click();
  await page.getByLabel("任务标题", { exact: true }).fill("复习算法");
  await page.getByRole("button", { name: "添加任务", exact: true }).click();

  await expect(page.getByTestId(/^task-row-/).filter({ hasText: "复习算法" })).toBeVisible();
  tasks = await listTasks(request);
  const child = tasks.find((task) => task.title === "复习算法");
  expect(child?.parentId).toBe(parent.id);

  await page.getByLabel(`完成任务「复习算法」`, { exact: true }).click();
  await expect(page.getByLabel(`重新打开任务「复习算法」`, { exact: true })).toBeVisible();
  expect((await listTasks(request)).find((task) => task.title === "复习算法")?.done).toBe(true);

  await page.getByLabel(`删除任务「复习算法」`, { exact: true }).click();
  await expect(page.getByTestId(/^task-row-/).filter({ hasText: "复习算法" })).toHaveCount(0);
  expect((await listTasks(request)).some((task) => task.title === "复习算法")).toBe(false);
});
