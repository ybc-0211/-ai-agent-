import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { createTodoAgent, type ModelCall } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

async function createStore(t: TestContext): Promise<TaskStore> {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createJsonTaskStore(join(directory, "tasks.json"));
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id = "call_1",
): ChatCompletionMessageToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function rawToolCall(name: string, args: string, id = "call_1"): ChatCompletionMessageToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function assistantMessage(
  content: string | null,
  toolCalls?: ChatCompletionMessageToolCall[],
): ChatCompletionMessage {
  return toolCalls
    ? { role: "assistant", content, refusal: null, tool_calls: toolCalls }
    : { role: "assistant", content, refusal: null };
}

interface ScriptedModel {
  callModel: ModelCall;
  calls: ChatCompletionMessageParam[][];
}

function respondMessage(
  claimed: "none" | "create" | "complete" | "delete" | "query",
): ChatCompletionMessage {
  return assistantMessage(null, [toolCall("respond", { claimed_action: claimed }, "respond_1")]);
}

function scriptModel(responses: ChatCompletionMessage[]): ScriptedModel {
  const calls: ChatCompletionMessageParam[][] = [];
  let index = 0;
  return {
    calls,
    async callModel(messages) {
      calls.push(messages.map((message) => ({ ...message })));
      const response = responses[index];
      index += 1;
      if (!response) throw new Error("测试脚本中的模型响应已用完。");
      return response;
    },
  };
}

async function replyWith(
  tasks: TaskStore,
  responses: ChatCompletionMessage[],
  text = "你好",
): Promise<{ answer: string; calls: ChatCompletionMessageParam[][] }> {
  const { callModel, calls } = scriptModel(responses);
  const agent = createTodoAgent({ tasks, callModel });
  const answer = await agent([{ role: "user", content: text }]);
  return { answer, calls };
}

function toolContents(messages: ChatCompletionMessageParam[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") return [];
    return [JSON.parse(message.content) as Record<string, unknown>];
  });
}

test("创建任务：收到真实创建结果并生成确定性确认", async (t) => {
  const tasks = await createStore(t);
  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("create_task", { title: " 买牛奶 " })]),
      respondMessage("create"),
    ],
    "帮我记一下买牛奶",
  );

  assert.match(answer, /已创建任务「买牛奶」/);
  assert.match(answer, /- \[ \] 买牛奶/);
  assert.doesNotMatch(answer, /模型自己的话/);
  assert.deepEqual(
    tasks.list().map(({ title, done }) => ({ title, done })),
    [{ title: "买牛奶", done: false }],
  );
});

test("创建任务：支持优先级和截止日期", async (t) => {
  const tasks = await createStore(t);
  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [
        toolCall("create_task", {
          title: "写报告",
          priority: "high",
          dueDate: "2026-12-01",
        }),
      ]),
      respondMessage("create"),
    ],
    "记一下高优先级报告，截止 12 月 1 日",
  );

  assert.match(answer, /已创建任务「写报告」/);
  assert.match(answer, /高优先级/);
  assert.match(answer, /截止 2026-12-01/);
  assert.equal(tasks.list()[0]?.priority, "high");
  assert.equal(tasks.list()[0]?.dueDate, "2026-12-01");
});

test("查询任务：返回真实清单且不产生修改", async (t) => {
  const tasks = await createStore(t);
  const milk = tasks.create("买牛奶");
  tasks.create("取快递");
  tasks.update(milk.id, { done: true });

  const { answer, calls } = await replyWith(
    tasks,
    [assistantMessage(null, [toolCall("list_tasks", {})]), respondMessage("query")],
    "我有哪些任务？",
  );

  assert.match(answer, /- \[x\] 买牛奶/);
  assert.match(answer, /- \[ \] 取快递/);
  assert.doesNotMatch(answer, /已创建|已删除|已把/);
  assert.equal(tasks.list().length, 2);

  const payload = toolContents(calls[1] ?? [])[0];
  const listed = payload?.tasks as Array<Record<string, unknown>>;
  assert.equal(listed.length, 2);
  assert.equal(
    listed.every((task) => !("id" in task)),
    true,
  );
});

test("完成任务：按名称匹配并确认状态确实变更", async (t) => {
  const tasks = await createStore(t);
  const milk = tasks.create("买牛奶");
  tasks.create("取快递");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { name: "牛奶" }, "call_2")]),
      respondMessage("complete"),
    ],
    "牛奶买好了",
  );

  assert.match(answer, /已把「买牛奶」标记为完成/);
  assert.equal(tasks.list().find((task) => task.id === milk.id)?.done, true);
  assert.equal(tasks.list().find((task) => task.title === "取快递")?.done, false);
});

test("删除任务：按名称匹配并确认真实删除", async (t) => {
  const tasks = await createStore(t);
  tasks.create("取快递");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("delete_task", { name: "取快递" }, "call_2")]),
      respondMessage("delete"),
    ],
    "取快递这条删掉吧",
  );

  assert.match(answer, /已删除任务「取快递」/);
  assert.deepEqual(tasks.list(), []);
});

test("必须先查询：未调用 list_tasks 时拒绝完成和删除", async (t) => {
  const tasks = await createStore(t);
  const milk = tasks.create("买牛奶");

  const { answer, calls } = await replyWith(
    tasks,
    [
      assistantMessage(null, [
        toolCall("complete_task", { name: "买牛奶" }, "call_1"),
        toolCall("delete_task", { name: "买牛奶" }, "call_2"),
      ]),
      respondMessage("none"),
    ],
    "牛奶买好了",
  );

  assert.match(answer, /需要先查询任务清单/);
  const payloads = toolContents(calls[1] ?? []);
  assert.deepEqual(
    payloads.map((payload) => payload.code),
    ["not_listed", "not_listed"],
  );
  assert.equal(tasks.list().find((task) => task.id === milk.id)?.done, false);
});

test("必须先查询：协议性拒绝在后续正确执行后不再展示", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("complete_task", { name: "买牛奶" })]),
      assistantMessage(null, [toolCall("list_tasks", {}, "call_2")]),
      assistantMessage(null, [toolCall("complete_task", { name: "买牛奶" }, "call_3")]),
      respondMessage("none"),
    ],
    "完成买牛奶",
  );

  assert.match(answer, /已把「买牛奶」标记为完成/);
  assert.doesNotMatch(answer, /需要先查询任务清单/);
  assert.equal(tasks.list()[0]?.done, true);
});

test("找不到任务：返回 not_found 并复述当前清单", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { name: "不存在" }, "call_2")]),
      respondMessage("none"),
    ],
    "把不存在的任务完成",
  );

  assert.match(answer, /没有找到「不存在」/);
  assert.match(answer, /- \[ \] 买牛奶/);
  assert.doesNotMatch(answer, /已把/);
});

test("同名歧义：返回候选且不修改任何任务", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("delete_task", { name: "买牛奶" }, "call_2")]),
      respondMessage("none"),
    ],
    "牛奶买好了",
  );

  assert.match(answer, /找到多条匹配「买牛奶」/);
  assert.match(answer, /第 1 条/);
  assert.match(answer, /第 2 条/);
  assert.match(answer, /请告诉我第几条/);
  assert.equal(tasks.list().length, 2);
  assert.equal(tasks.list().filter((task) => task.done).length, 0);
});

test("同名歧义：用户明确第 2 条后按真实任务执行", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [
        toolCall("complete_task", { name: "买牛奶", occurrence: 2 }, "call_2"),
      ]),
      respondMessage("complete"),
    ],
    "把第二条买牛奶标记完成",
  );

  assert.match(answer, /已把「买牛奶」标记为完成/);
  assert.deepEqual(
    tasks.list().map(({ done }) => done),
    [false, true],
  );
});

test("同名歧义：用户未指定第几条时，模型传 occurrence 也会被拒绝", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [
        toolCall("complete_task", { name: "买牛奶", occurrence: 1 }, "call_2"),
      ]),
      respondMessage("none"),
    ],
    "牛奶买好了",
  );

  assert.match(answer, /找到多条匹配「买牛奶」/);
  assert.equal(tasks.list().filter((task) => task.done).length, 0);
});

test("同名歧义：occurrence 越界时不修改任务", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [
        toolCall("delete_task", { name: "买牛奶", occurrence: 3 }, "call_2"),
      ]),
      respondMessage("none"),
    ],
    "删除第三条买牛奶",
  );

  assert.match(answer, /找到多条匹配「买牛奶」/);
  assert.equal(tasks.list().length, 2);
});

test("服务端不接受 id：complete_task 传 id 会被拒绝", async (t) => {
  const tasks = await createStore(t);
  const milk = tasks.create("买牛奶");

  const { answer, calls } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { id: milk.id }, "call_2")]),
      respondMessage("none"),
    ],
    "完成买牛奶",
  );

  assert.match(answer, /未能完成操作/);
  const payload = toolContents(calls.at(-1) ?? []).at(-1);
  assert.equal(payload?.code, "invalid_name");
  assert.equal(tasks.list()[0]?.done, false);
});

test("参数错误：非法 JSON 和无效标题都不会写入任务", async (t) => {
  const tasks = await createStore(t);
  const { answer, calls } = await replyWith(
    tasks,
    [
      assistantMessage(null, [
        rawToolCall("create_task", "{not json", "call_1"),
        toolCall("create_task", { title: " " }, "call_2"),
      ]),
      respondMessage("none"),
    ],
    "记一下",
  );

  assert.match(answer, /未能完成操作/);
  assert.doesNotMatch(answer, /已创建/);
  assert.equal(tasks.list().length, 0);
  const payloads = toolContents(calls.at(-1) ?? []);
  assert.deepEqual(
    payloads.map((payload) => payload.code),
    ["invalid_json", "invalid_title"],
  );
});

test("未知工具：返回失败且不产生修改", async (t) => {
  const tasks = await createStore(t);
  const { answer } = await replyWith(
    tasks,
    [assistantMessage(null, [toolCall("rename_task", { name: "买牛奶" })]), respondMessage("none")],
    "重命名任务",
  );

  assert.match(answer, /工具调用失败：未知工具/);
  assert.equal(tasks.list().length, 0);
});

test("存储读取异常：返回失败而不是抛出 500", async (t) => {
  t.mock.method(console, "error", () => {});
  const tasks = await createStore(t);
  const broken: TaskStore = {
    ...tasks,
    list() {
      throw new Error("读取失败");
    },
  };

  const { answer } = await replyWith(
    broken,
    [assistantMessage(null, [toolCall("list_tasks", {})]), respondMessage("none")],
    "看看清单",
  );

  assert.match(answer, /读取任务清单失败/);
});

test("模型调用失败：返回友好提示而不是抛出 500", async (t) => {
  t.mock.method(console, "error", () => {});
  const tasks = await createStore(t);
  const callModel: ModelCall = async () => {
    throw new Error("网络错误");
  };
  const agent = createTodoAgent({ tasks, callModel });
  assert.equal(
    await agent([{ role: "user", content: "你好" }]),
    "抱歉，模型服务暂时不可用，请稍后再试。",
  );

  const missingKey: ModelCall = async () => {
    throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  };
  const agentWithoutKey = createTodoAgent({ tasks, callModel: missingKey });
  assert.equal(
    await agentWithoutKey([{ role: "user", content: "你好" }]),
    "请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。",
  );
});

test("模型错误分类：超时、401、429、5xx 返回明确提示", async (t) => {
  t.mock.method(console, "error", () => {});
  const tasks = await createStore(t);

  async function replyFor(error: unknown): Promise<string> {
    const callModel: ModelCall = async () => {
      throw error;
    };
    return createTodoAgent({ tasks, callModel })([{ role: "user", content: "你好" }]);
  }

  const timeout = new Error("timed out");
  timeout.name = "APIConnectionTimeoutError";
  assert.equal(await replyFor(timeout), "模型请求超时，请稍后再试。");
  assert.equal(
    await replyFor(Object.assign(new Error("unauthorized"), { status: 401 })),
    "模型鉴权失败，请检查 DEEPSEEK_API_KEY 配置。",
  );
  assert.equal(
    await replyFor(Object.assign(new Error("rate limited"), { status: 429 })),
    "模型请求过于频繁，请稍后再试。",
  );
  assert.equal(
    await replyFor(Object.assign(new Error("server error"), { status: 503 })),
    "模型服务暂时异常，请稍后再试。",
  );
});

test("多轮工具调用：list -> complete，工具消息按顺序回填", async (t) => {
  const tasks = await createStore(t);
  const milk = tasks.create("买牛奶");
  const seen: ChatCompletionMessageParam[][] = [];

  const callModel: ModelCall = async (messages) => {
    seen.push(messages.map((message) => ({ ...message })));
    if (seen.length === 1) return assistantMessage(null, [toolCall("list_tasks", {})]);
    if (seen.length === 2) {
      return assistantMessage(null, [toolCall("complete_task", { name: "买牛奶" }, "call_2")]);
    }
    return respondMessage("complete");
  };

  const agent = createTodoAgent({ tasks, callModel });
  const answer = await agent([{ role: "user", content: "牛奶买好了" }]);

  assert.match(answer, /已把「买牛奶」标记为完成/);
  assert.equal(tasks.list().find((task) => task.id === milk.id)?.done, true);
  assert.equal(seen.length, 3);
  assert.deepEqual(
    (seen[2] ?? []).map((message) => message.role),
    ["system", "user", "assistant", "tool", "assistant", "tool"],
  );
});

test("假成功防护：只查询却声称删除，不返回成功确认", async (t) => {
  const tasks = await createStore(t);
  tasks.create("取快递");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      respondMessage("delete"),
      respondMessage("query"),
    ],
    "取快递这条删掉吧",
  );

  assert.doesNotMatch(answer, /已删除/);
  assert.match(answer, /- \[ \] 取快递/);
  assert.equal(tasks.list().length, 1);
});

test("假成功防护：只查询后任务请求 respond none 会被要求补调工具", async (t) => {
  const tasks = await createStore(t);
  tasks.create("取快递");

  const { answer, calls } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      respondMessage("none"),
      assistantMessage(null, [toolCall("delete_task", { name: "取快递" }, "call_2")]),
      respondMessage("delete"),
    ],
    "取快递这条删掉吧",
  );

  assert.match(answer, /已删除任务「取快递」/);
  assert.equal(tasks.list().length, 0);
  const firstError = toolContents(calls[2] ?? []).at(-1);
  assert.equal(firstError?.code, "task_required");
});

test("假成功防护：工具失败却声称成功，不返回成功确认", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { name: "不存在" }, "call_2")]),
      respondMessage("complete"),
      respondMessage("none"),
    ],
    "完成买牛奶",
  );

  assert.match(answer, /没有找到「不存在」/);
  assert.doesNotMatch(answer, /已把/);
  assert.equal(tasks.list()[0]?.done, false);
});

test("无工具调用：反复输出自然语言不会被当成成功", async (t) => {
  const tasks = await createStore(t);
  const responses = Array.from({ length: 6 }, () => assistantMessage("已创建任务「买牛奶」。"));
  const { answer, calls } = await replyWith(tasks, responses, "帮我记一下买牛奶");

  assert.equal(calls.length, 6);
  assert.doesNotMatch(answer, /已创建/);
  assert.equal(tasks.list().length, 0);
});

test("无工具调用：respond 声称创建/完成/删除但无对应结果时拒绝", async (t) => {
  for (const action of ["create", "complete", "delete"] as const) {
    const tasks = await createStore(t);
    tasks.create("买牛奶");

    const { answer, calls } = await replyWith(
      tasks,
      [respondMessage(action), respondMessage("query")],
      "操作买牛奶",
    );

    assert.doesNotMatch(answer, /已创建|已把|已删除/);
    assert.equal(tasks.list().length, 1);
    assert.equal(tasks.list()[0]?.done, false);
    const toolMessages = toolContents(calls[1] ?? []);
    assert.equal(toolMessages.at(-1)?.code, "not_executed");
  }
});

test("无工具调用：respond 声称查询时返回服务端真实清单", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");

  const { answer } = await replyWith(tasks, [respondMessage("query")], "我有哪些任务");

  assert.match(answer, /- \[ \] 买牛奶/);
});

test("无工具调用：任务请求用 respond none 结束会被要求补调工具", async (t) => {
  const tasks = await createStore(t);
  const { answer, calls } = await replyWith(
    tasks,
    [
      respondMessage("none"),
      assistantMessage(null, [toolCall("list_tasks", {}, "call_1")]),
      assistantMessage(null, [toolCall("create_task", { title: "买牛奶" }, "call_2")]),
      respondMessage("create"),
    ],
    "帮我记一下买牛奶",
  );

  assert.match(answer, /已创建任务「买牛奶」/);
  assert.equal(tasks.list().length, 1);
  assert.equal(calls.length, 4);
  const firstError = toolContents(calls[1] ?? []).at(-1);
  assert.equal(firstError?.code, "task_required");
});

test("无工具调用：普通聊天 respond none 返回固定安全文案", async (t) => {
  const tasks = await createStore(t);
  const { answer, calls } = await replyWith(tasks, [respondMessage("none")], "你好");

  assert.equal(answer, "我在。你可以让我创建、查询、完成或删除待办任务。");
  assert.equal(calls.length, 1);
});

test("假成功防护：已有工具报告时，模型纯自然语言不会成为成功回复", async (t) => {
  const tasks = await createStore(t);
  tasks.create("取快递");

  const { answer, calls } = await replyWith(
    tasks,
    [assistantMessage(null, [toolCall("list_tasks", {})]), assistantMessage("已删除「取快递」。")],
    "取快递这条删掉吧",
  );

  assert.doesNotMatch(answer, /已删除/);
  assert.match(answer, /- \[ \] 取快递/);
  assert.equal(calls.length, 2);
  assert.equal(tasks.list().length, 1);
});

test("respond 参数非法时返回结构化错误并允许重试", async (t) => {
  const tasks = await createStore(t);
  const { answer, calls } = await replyWith(
    tasks,
    [assistantMessage(null, [rawToolCall("respond", "{bad json")]), respondMessage("none")],
    "你好",
  );

  assert.equal(answer, "我在。你可以让我创建、查询、完成或删除待办任务。");
  assert.equal(calls.length, 2);
  const firstError = toolContents(calls[1] ?? []).at(-1);
  assert.equal(firstError?.code, "invalid_response");
});

test("多工具部分成功：分别输出真实成功与失败", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {}, "call_1")]),
      assistantMessage(null, [
        toolCall("create_task", { title: "买面包" }, "call_2"),
        toolCall("complete_task", { name: "不存在" }, "call_3"),
      ]),
      respondMessage("none"),
    ],
    "创建买面包并完成不存在的任务",
  );

  assert.match(answer, /已创建任务「买面包」/);
  assert.match(answer, /没有找到「不存在」/);
  assert.equal(tasks.list().length, 2);
});

test("部分匹配多个任务：返回歧义且不修改", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶（超市）");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("delete_task", { name: "牛奶" }, "call_2")]),
      respondMessage("none"),
    ],
    "删除牛奶",
  );

  assert.match(answer, /找到多条匹配「牛奶」/);
  assert.match(answer, /第 1 条/);
  assert.match(answer, /第 2 条/);
  assert.equal(tasks.list().length, 2);
});

test("匹配边界 1：短任务名不会被更长的用户描述反向匹配", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { name: "买牛奶和面包" }, "call_2")]),
      respondMessage("none"),
    ],
    "完成买牛奶和面包",
  );

  assert.match(answer, /没有找到「买牛奶和面包」/);
  assert.equal(tasks.list()[0]?.done, false);
});

test("匹配边界 2：完全匹配优先于相似匹配", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶和面包");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { name: "买牛奶和面包" }, "call_2")]),
      respondMessage("none"),
    ],
    "完成买牛奶和面包",
  );

  assert.match(answer, /已把「买牛奶和面包」标记为完成/);
  assert.deepEqual(
    tasks.list().map(({ title, done }) => ({ title, done })),
    [
      { title: "买牛奶", done: false },
      { title: "买牛奶和面包", done: true },
    ],
  );
});

test("匹配边界 3：同名任务必须由用户确认", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("delete_task", { name: "买牛奶" }, "call_2")]),
      respondMessage("none"),
    ],
    "删除买牛奶",
  );

  assert.match(answer, /找到多条匹配「买牛奶」/);
  assert.match(answer, /请告诉我第几条/);
  assert.equal(tasks.list().length, 2);
});

test("匹配边界 4：多个相似任务必须由用户确认", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶和面包");
  tasks.create("买牛奶和水果");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { name: "买牛奶" }, "call_2")]),
      respondMessage("none"),
    ],
    "完成买牛奶",
  );

  assert.match(answer, /找到多条匹配「买牛奶」/);
  assert.match(answer, /请告诉我第几条/);
  assert.equal(tasks.list().filter((task) => task.done).length, 0);
});

test("匹配边界 5：不存在匹配任务时不执行完成或删除", async (t) => {
  const tasks = await createStore(t);
  tasks.create("买牛奶");

  const { answer } = await replyWith(
    tasks,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [
        toolCall("complete_task", { name: "买书" }, "call_2"),
        toolCall("delete_task", { name: "买笔" }, "call_3"),
      ]),
      respondMessage("none"),
    ],
    "完成买书并删除买笔",
  );

  assert.match(answer, /没有找到「买书」/);
  assert.match(answer, /没有找到「买笔」/);
  assert.equal(tasks.list().length, 1);
  assert.equal(tasks.list()[0]?.done, false);
});

test("MAX_TOOL_CALLS：达到上限后停止且不谎报成功", async (t) => {
  const tasks = await createStore(t);
  const twelveLists = Array.from({ length: 12 }, (_, index) =>
    toolCall("list_tasks", {}, `call_${index + 1}`),
  );
  const { answer, calls } = await replyWith(
    tasks,
    [
      assistantMessage(null, twelveLists),
      assistantMessage(null, [toolCall("create_task", { title: "买牛奶" }, "call_13")]),
    ],
    "做点事",
  );

  assert.equal(calls.length, 2);
  assert.match(answer, /已达到单轮工具调用上限（12 次）/);
  assert.doesNotMatch(answer, /已创建/);
  assert.equal(tasks.list().length, 0);
});

test("MAX_STEPS：持续工具调用达到步数上限", async (t) => {
  const tasks = await createStore(t);
  const responses = Array.from({ length: 6 }, (_, index) =>
    assistantMessage(null, [toolCall("list_tasks", {}, `call_${index + 1}`)]),
  );
  const { answer, calls } = await replyWith(tasks, responses, "看看清单");

  assert.match(answer, /已达到单轮步骤上限/);
  assert.equal(calls.length, 6);
});

test("执行结果校验：创建后未确认时返回失败", async (t) => {
  const tasks = await createStore(t);
  const broken: TaskStore = {
    ...tasks,
    create(title) {
      return { id: "fake-id", title, done: false };
    },
    list() {
      return [];
    },
  };

  const { answer } = await replyWith(
    broken,
    [
      assistantMessage(null, [toolCall("create_task", { title: "买牛奶" })]),
      respondMessage("none"),
    ],
    "创建买牛奶",
  );

  assert.match(answer, /任务创建后未能确认/);
  assert.doesNotMatch(answer, /已创建/);
});

test("执行结果校验：完成状态未确认时返回失败", async (t) => {
  const tasks = await createStore(t);
  const milk = tasks.create("买牛奶");
  const broken: TaskStore = {
    ...tasks,
    list() {
      return [{ id: milk.id, title: milk.title, done: false }];
    },
    update() {
      return { id: milk.id, title: milk.title, done: true };
    },
  };

  const { answer } = await replyWith(
    broken,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("complete_task", { name: "买牛奶" }, "call_2")]),
      respondMessage("none"),
    ],
    "完成买牛奶",
  );

  assert.match(answer, /未能确认任务已完成/);
  assert.doesNotMatch(answer, /已把/);
});

test("执行结果校验：删除后仍存在时返回失败", async (t) => {
  const tasks = await createStore(t);
  const milk = tasks.create("买牛奶");
  const broken: TaskStore = {
    ...tasks,
    list() {
      return [{ id: milk.id, title: milk.title, done: false }];
    },
    remove() {
      return true;
    },
  };

  const { answer } = await replyWith(
    broken,
    [
      assistantMessage(null, [toolCall("list_tasks", {})]),
      assistantMessage(null, [toolCall("delete_task", { name: "买牛奶" }, "call_2")]),
      respondMessage("none"),
    ],
    "删除买牛奶",
  );

  assert.match(answer, /未能确认任务已删除/);
  assert.doesNotMatch(answer, /已删除任务「买牛奶」/);
});

test("聊天接口：使用 agent 工厂完成一次创建任务", async (t) => {
  const tasks = await createStore(t);
  const { callModel } = scriptModel([
    assistantMessage(null, [toolCall("create_task", { title: "买牛奶" })]),
    respondMessage("create"),
  ]);
  const app = createApp({ reply: createTodoAgent({ tasks, callModel }), tasks });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "帮我记一下买牛奶" }] }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { reply: string };
  assert.match(body.reply, /已创建任务「买牛奶」/);
  assert.match(body.reply, /- \[ \] 买牛奶/);
  assert.deepEqual(
    tasks.list().map(({ title, done }) => ({ title, done })),
    [{ title: "买牛奶", done: false }],
  );
});
