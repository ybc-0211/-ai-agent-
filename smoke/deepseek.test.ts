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

test("真实 DeepSeek Smoke：完成一次自然语言创建任务并落库", { timeout: 120_000 }, async (t) => {
  if (!process.env.DEEPSEEK_API_KEY) {
    assert.fail("缺少 DEEPSEEK_API_KEY。本地请配置 .env，CI 请配置 Actions Secret 后手动运行。");
  }

  const directory = await mkdtemp(join(tmpdir(), "todo-deepseek-smoke-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  let calls = 0;
  const callModel: ModelCall = async (messages) => {
    calls += 1;
    if (calls > MAX_MODEL_CALLS) {
      throw new Error(`Smoke 超过最大模型调用次数（${MAX_MODEL_CALLS}）。`);
    }
    return deepSeekModelCall(messages);
  };

  const agent = createTodoAgent({ tasks, callModel });
  const messages: ChatMessage[] = [{ role: "user", content: "帮我记一下买牛奶" }];
  const reply = await agent(messages);

  assert.ok(calls >= 1, "模型未被调用。");
  assert.ok(calls <= MAX_MODEL_CALLS, `模型调用次数超过上限（${MAX_MODEL_CALLS}）。`);

  const saved = tasks.list();
  assert.equal(saved.length, 1, "真实模型没有通过工具创建任务。");
  assert.match(saved[0]?.title ?? "", /买牛奶/, "任务标题与用户意图不一致。");
  assert.match(reply, /已创建任务/, "服务端没有根据真实工具结果返回成功确认。");
});
