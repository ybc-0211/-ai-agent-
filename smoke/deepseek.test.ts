import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTodoAgent,
  deepSeekModelCall,
  type ChatMessage,
  type ModelCall,
} from "../server/agent.ts";
import { createJsonTaskStore } from "../server/task-store.ts";

const MAX_MODEL_CALLS = 2;
const MAX_OUTPUT_TOKENS = 256;

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function describeSmokeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const status = errorStatus(error);
  if (name === "APIConnectionTimeoutError" || name.includes("Timeout")) {
    return "真实 API Smoke 失败：模型请求超时（客户端超时 60 秒）。";
  }
  if (status === 401) {
    return "真实 API Smoke 失败：鉴权失败（401），请检查 DEEPSEEK_API_KEY。";
  }
  if (status === 429) {
    return "真实 API Smoke 失败：请求被限流（429），请稍后重试。";
  }
  if (status !== undefined && status >= 500) {
    return `真实 API Smoke 失败：DeepSeek 服务端错误（${status}）。`;
  }
  return `真实 API Smoke 失败：模型调用异常（${name}）。`;
}

test("真实 DeepSeek Smoke：完成一次自然语言创建任务并落库", { timeout: 120_000 }, async (t) => {
  if (!process.env.DEEPSEEK_API_KEY) {
    t.skip(
      "未配置 DEEPSEEK_API_KEY，真实 Smoke 已安全跳过；本地请配置 .env，CI 请配置 Actions Secret。",
    );
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "todo-deepseek-smoke-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  let calls = 0;
  let modelError: unknown;
  const callModel: ModelCall = async (messages) => {
    calls += 1;
    if (calls > MAX_MODEL_CALLS) {
      throw new Error(`Smoke 超过最大模型调用次数（${MAX_MODEL_CALLS}）。`);
    }
    try {
      return await deepSeekModelCall(messages, { maxOutputTokens: MAX_OUTPUT_TOKENS });
    } catch (error) {
      modelError = error;
      throw error;
    }
  };

  const agent = createTodoAgent({ tasks, callModel });
  const messages: ChatMessage[] = [{ role: "user", content: "帮我记一下买牛奶" }];
  const reply = await agent(messages);

  assert.ok(calls >= 1, "模型未被调用。");
  assert.ok(calls <= MAX_MODEL_CALLS, `模型调用次数超过上限（${MAX_MODEL_CALLS}）。`);
  if (modelError) {
    assert.fail(describeSmokeError(modelError));
  }

  const saved = tasks.list();
  assert.equal(saved.length, 1, "真实模型没有通过工具创建任务。");
  assert.match(saved[0]?.title ?? "", /买牛奶/, "任务标题与用户意图不一致。");
  assert.match(reply, /已创建任务/, "服务端没有根据真实工具结果返回成功确认。");
});
