import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const app = createApp({
    tasks: createJsonTaskStore(filename),
    async reply(messages) {
      conversations.push(messages);
      return "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false, priority: "medium" });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, custom: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("任务 API 支持优先级、截止日期、筛选和重新打开", async (t) => {
  const { request } = await startTestApp(t);
  const created = await request("POST", "/api/tasks", {
    title: "写报告",
    priority: "high",
    dueDate: "2026-12-01",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, {
    id: created.body.id,
    title: "写报告",
    done: false,
    priority: "high",
    dueDate: "2026-12-01",
  });

  const low = await request("POST", "/api/tasks", { title: "倒垃圾", priority: "low" });
  assert.equal(low.status, 201);
  const highOpen = await request("GET", "/api/tasks?status=open&priority=high");
  assert.deepEqual(highOpen.body, [created.body]);

  const completed = await request("PATCH", `/api/tasks/${created.body.id}`, { done: true });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.done, true);
  assert.deepEqual((await request("GET", "/api/tasks?status=completed")).body, [completed.body]);

  const reopened = await request("PATCH", `/api/tasks/${created.body.id}`, { done: false });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.done, false);

  const edited = await request("PATCH", `/api/tasks/${created.body.id}`, {
    title: "写季度报告",
    priority: "low",
    dueDate: null,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, "写季度报告");
  assert.equal(edited.body.priority, "low");
  assert.equal(edited.body.dueDate, null);
});

test("任务 API 支持子任务并级联删除", async (t) => {
  const { request } = await startTestApp(t);
  const parent = await request("POST", "/api/tasks", { title: "准备面试" });
  const child = await request("POST", "/api/tasks", {
    title: "复习算法",
    parentId: parent.body.id,
    priority: "high",
  });
  assert.equal(child.status, 201);
  assert.equal(child.body.parentId, parent.body.id);

  assert.equal((await request("GET", "/api/tasks")).body.length, 2);
  assert.deepEqual(await request("DELETE", `/api/tasks/${parent.body.id}`), {
    status: 204,
    body: null,
  });
  assert.deepEqual((await request("GET", "/api/tasks")).body, []);
});

test("任务 API 拒绝无效优先级、截止日期和父任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal(
    (await request("POST", "/api/tasks", { title: "无效", priority: "urgent" })).status,
    400,
  );
  assert.equal(
    (await request("POST", "/api/tasks", { title: "无效", dueDate: "2026-02-30" })).status,
    400,
  );
  assert.equal(
    (await request("POST", "/api/tasks", { title: "无效", parentId: "missing" })).status,
    400,
  );
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});
