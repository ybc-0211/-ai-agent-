import type OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";
import type { TaskStore } from "./task-store.ts";
import { createTaskSchema } from "./tasks.ts";

export type { ChatMessage } from "../shared/chat.ts";

const MAX_STEPS = 6;
const MAX_TOOL_CALLS = 12;

const TASK_REQUEST_PATTERN =
  /创建|新建|添加|记一下|记一条|记下|提醒我|完成|做完|标记|删除|删掉|移除|查询|查看|列出|清单|待办|任务|买好了|办好了|搞定了|第\s*[0-9一二三四五六七八九十]+\s*(?:条|个|项|件)/;

const TASK_MUTATION_PATTERN =
  /创建|新建|添加|记一下|记一条|记下|提醒我|完成|做完|标记|删除|删掉|移除|买好了|办好了|搞定了|第\s*[0-9一二三四五六七八九十]+\s*(?:条|个|项|件)/;

const SYSTEM_PROMPT = `你是「小明」，一个中文待办清单智能体。你可以通过工具读取和修改用户的待办清单。

工作规则：
1. 涉及任务的操作必须调用工具，不要凭记忆或猜测回答；没有调用工具就不要声称已经创建、完成或删除。
2. 修改或删除任务前，必须先调用 list_tasks 获取最新清单；然后调用 complete_task 或 delete_task，并在 name 参数中传入用户所说的任务名称。工具不接受 id，不要编造或猜测任务 id。
3. 服务端会根据名称匹配真实任务：
   - 返回 code=not_found 时，明确告诉用户没有找到，并复述当前清单；
   - 返回 code=ambiguous 时，把候选按顺序告诉用户，请用户确认要操作第几条；只有用户明确说明后，才在下次调用传 occurrence（从 1 开始）。不要自行选择。
4. 创建任务不需要先查询；把用户的话提炼成简洁的任务标题（如「帮我记一下买牛奶」→「买牛奶」），不要添加用户没有提到的信息，标题不超过 200 字。
5. 一条消息里可能包含多个任务或多个操作，可以连续调用多个工具。
6. 工具返回 ok:false 时，根据错误提示修正；无法修正时向用户解释。
7. 只有工具返回 ok:true 才表示操作成功；不要根据猜测声称成功。最终确认由服务端根据真实工具结果生成。
8. 列表展示使用「- [ ] 未完成」「- [x] 已完成」。
9. 与待办无关的请求，简短说明你只能帮助管理待办。
10. 不编造任务、名称或操作结果。
11. 每轮最终必须调用 respond 工具提交结构化结果，不要直接输出自然语言。respond 只提交结果声明，不会执行任务操作；创建/完成/删除必须先调用对应工具，成功后再调用 respond。respond 的 claimed_action 必须与本轮真实工具结果一致：普通聊天用 none，查询用 query，任务修改用对应 action；没有成功工具结果时不得声明成功。用户可见文本由服务端根据真实结果生成。`;

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description:
        "列出当前所有任务及完成状态（只返回标题和完成状态，不返回 id）。查询清单，或在修改、删除任务前必须调用。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "创建一条新的待办任务。title 是提炼后的任务标题，1 至 200 个字符。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题，1 至 200 个字符" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description:
        "按任务名称把任务标记为已完成。调用前必须先 list_tasks。服务端会解析名称；找不到或同名多条会返回失败，不要猜测。仅当用户明确指定第几条时才传 occurrence。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "用户所说的任务名称，例如「买牛奶」" },
          occurrence: {
            type: "integer",
            minimum: 1,
            description: "可选；仅当用户明确指定第几条时填写，否则不要传",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description:
        "按任务名称永久删除任务。调用前必须先 list_tasks。服务端会解析名称；找不到或同名多条会返回失败，不要猜测。仅当用户明确指定第几条时才传 occurrence。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "用户所说的任务名称，例如「取快递」" },
          occurrence: {
            type: "integer",
            minimum: 1,
            description: "可选；仅当用户明确指定第几条时填写，否则不要传",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "respond",
      description:
        "结束本轮并提交结构化结果声明。respond 不会执行任务操作；创建/完成/删除必须先调用对应工具。每轮必须调用一次；claimed_action 必须与真实工具结果一致。用户可见文本由服务端根据真实结果生成。",
      parameters: {
        type: "object",
        properties: {
          claimed_action: {
            type: "string",
            enum: ["none", "create", "complete", "delete", "query"],
            description: "本轮实际完成的操作；普通聊天用 none",
          },
          task_name: {
            type: "string",
            description: "可选；本轮操作的目标任务名称",
          },
        },
        required: ["claimed_action"],
        additionalProperties: false,
      },
    },
  },
];

const taskNameSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  occurrence: z.number().int().min(1).optional(),
});

const respondSchema = z.strictObject({
  claimed_action: z.enum(["none", "create", "complete", "delete", "query"]),
  task_name: z.string().trim().min(1).max(200).optional(),
});

const CHAT_REPLY = "我在。你可以让我创建、查询、完成或删除待办任务。";
const RESPOND_REMINDER =
  "你必须调用 respond 工具提交本轮结构化结果（claimed_action 为 none/create/complete/delete/query），不要直接输出自然语言。任务操作必须先调用对应工具并通过真实结果确认。";

interface PublicTask {
  title: string;
  done: boolean;
}

interface TaskView extends PublicTask {
  id: string;
}

type TaskAction = "list" | "create" | "complete" | "delete";

type FailureCode =
  | "invalid_json"
  | "invalid_title"
  | "invalid_name"
  | "not_listed"
  | "not_found"
  | "ambiguous"
  | "store_error"
  | "not_executed"
  | "unknown_tool";

interface ToolReport {
  action: TaskAction | "unknown";
  ok: boolean;
  title?: string;
  code?: FailureCode;
  error?: string;
  candidates?: PublicTask[];
}

interface ToolExecution {
  content: string;
  report: ToolReport;
}

export type ModelCall = (messages: ChatCompletionMessageParam[]) => Promise<ChatCompletionMessage>;

interface TodoAgentOptions {
  tasks: TaskStore;
  callModel?: ModelCall;
}

interface ToolState {
  hasListed: boolean;
  lastUserMessage: string;
}

let client: OpenAI | undefined;

function modelClient(): OpenAI {
  client ??= getModelClient();
  return client;
}

async function deepSeekModelCall(
  messages: ChatCompletionMessageParam[],
): Promise<ChatCompletionMessage> {
  const completion = await modelClient().chat.completions.create({
    model,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    reasoning_effort: "none",
  });
  const message = completion.choices[0]?.message;
  if (!message) throw new Error("模型没有返回任何消息。");
  return message;
}

export function createTodoAgent({ tasks, callModel = deepSeekModelCall }: TodoAgentOptions) {
  return async function reply(messages: ChatMessage[]): Promise<string> {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.map(toModelMessage),
    ];
    const lastUserMessage =
      [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const toolState: ToolState = { hasListed: false, lastUserMessage };
    const reports: ToolReport[] = [];

    let toolCalls = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      let message: ChatCompletionMessage;
      try {
        message = await callModel(history);
      } catch (error) {
        if (reports.length > 0) {
          return buildReply(reports, tasks, "模型服务中断，以上是已经执行的操作。");
        }
        return modelErrorReply(error);
      }

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        if (reports.length > 0) return buildReply(reports, tasks);
        if (step + 1 >= MAX_STEPS) {
          if (isLikelyTaskRequest(toolState.lastUserMessage, tasks)) {
            return buildReply(
              [{ action: "list", ok: true }],
              tasks,
              "我没能生成有效的结构化结果。请再试一次。",
            );
          }
          return "抱歉，我没能生成有效的结构化结果。请再试一次。";
        }
        history.push({ role: "assistant", content: message.content });
        history.push({ role: "system", content: RESPOND_REMINDER });
        continue;
      }
      if (toolCalls + calls.length > MAX_TOOL_CALLS) {
        return buildReply(
          reports,
          tasks,
          `已达到单轮工具调用上限（${MAX_TOOL_CALLS} 次），后续操作未执行。`,
        );
      }
      toolCalls += calls.length;

      history.push({ role: "assistant", content: message.content, tool_calls: calls });
      for (const call of calls) {
        if (call.type === "function" && call.function.name === "respond") {
          const result = handleRespond(call, reports, tasks, toolState.lastUserMessage);
          if ("final" in result) return result.final;
          history.push({ role: "tool", tool_call_id: call.id, content: result.content });
          continue;
        }

        const execution = runTool(call, tasks, toolState);
        reports.push(execution.report);
        history.push({ role: "tool", tool_call_id: call.id, content: execution.content });
      }
    }

    if (reports.length > 0) {
      return buildReply(reports, tasks, "已达到单轮步骤上限，以上是已经执行的操作。");
    }
    if (isLikelyTaskRequest(toolState.lastUserMessage, tasks)) {
      return buildReply(
        [{ action: "list", ok: true }],
        tasks,
        "已达到单轮步骤上限，任务操作未能完成。",
      );
    }
    return "抱歉，我没能生成有效的结构化结果。请再试一次。";
  };
}

type RespondResult = { final: string } | { content: string };

function handleRespond(
  call: ChatCompletionMessageToolCall,
  reports: ToolReport[],
  tasks: TaskStore,
  lastUserMessage: string,
): RespondResult {
  if (call.type !== "function") {
    return { content: failJson({ code: "invalid_response", error: "不支持的调用类型。" }) };
  }

  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return {
      content: failJson({ code: "invalid_response", error: "respond 参数不是合法的 JSON。" }),
    };
  }

  const parsed = respondSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: failJson({ code: "invalid_response", error: "respond 参数不合法。" }),
    };
  }

  const action = parsed.data.claimed_action;
  if (action === "none") {
    if (reports.length > 0) {
      const hasMutationAttempt = reports.some(
        (report) => report.action !== "list" && report.action !== "unknown",
      );
      if (!hasMutationAttempt && TASK_MUTATION_PATTERN.test(lastUserMessage)) {
        return { content: taskRequiredContent() };
      }
      return { final: buildReply(reports, tasks) };
    }
    if (isLikelyTaskRequest(lastUserMessage, tasks)) {
      return { content: taskRequiredContent() };
    }
    return { final: CHAT_REPLY };
  }
  if (action === "query") {
    return {
      final:
        reports.length > 0
          ? buildReply(reports, tasks)
          : buildReply([{ action: "list", ok: true }], tasks),
    };
  }

  const succeeded = reports.some((report) => report.action === action && report.ok);
  if (succeeded) return { final: buildReply(reports, tasks) };

  const label = action === "create" ? "创建" : action === "complete" ? "完成" : "删除";
  const toolName =
    action === "create" ? "create_task" : action === "complete" ? "complete_task" : "delete_task";
  return {
    content: failJson({
      code: "not_executed",
      error: `你声明了${label}，但本轮没有成功的${label}工具结果。respond 不会修改任务；请立即调用 ${toolName} 完成操作，成功后再调用 respond。`,
    }),
  };
}

function toModelMessage(message: ChatMessage): ChatCompletionMessageParam {
  return message.role === "user"
    ? { role: "user", content: message.content }
    : { role: "assistant", content: message.content };
}

function runTool(
  call: ChatCompletionMessageToolCall,
  tasks: TaskStore,
  state: ToolState,
): ToolExecution {
  if (call.type !== "function") {
    return failure("unknown", "unknown_tool", "不支持的调用类型。");
  }

  const action = actionForTool(call.function.name);
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return failure(action, "invalid_json", "工具参数不是合法的 JSON。");
  }

  switch (call.function.name) {
    case "list_tasks": {
      try {
        const list = tasks.list().map(toView);
        state.hasListed = true;
        return {
          content: okJson({ tasks: list.map(toPublic) }),
          report: { action: "list", ok: true },
        };
      } catch (error) {
        console.error("读取任务清单失败", error);
        return failure("list", "store_error", "读取任务清单失败，请稍后重试。");
      }
    }

    case "create_task": {
      const parsed = createTaskSchema.safeParse(args);
      if (!parsed.success) {
        return failure("create", "invalid_title", "任务标题需要是 1 到 200 个字符。");
      }
      try {
        const created = tasks.create(parsed.data.title);
        const confirmed = tasks.list().find((task) => task.id === created.id);
        if (!confirmed) {
          return failure("create", "store_error", "任务创建后未能确认，请稍后重试。");
        }
        return success("create", confirmed.title);
      } catch (error) {
        console.error("创建任务失败", error);
        return failure("create", "store_error", "任务创建失败，请稍后重试。");
      }
    }

    case "complete_task":
    case "delete_task": {
      const taskAction = call.function.name === "complete_task" ? "complete" : "delete";
      const parsed = taskNameSchema.safeParse(args);
      if (!parsed.success) {
        return failure(taskAction, "invalid_name", "请提供要操作的任务名称。");
      }
      if (!state.hasListed) {
        return failure(taskAction, "not_listed", "需要先查询任务清单，再执行完成或删除操作。", {
          title: parsed.data.name,
        });
      }

      try {
        const all = tasks.list().map(toView);
        const candidates = findTaskCandidates(all, parsed.data.name);
        if (candidates.length === 0) {
          return failure(taskAction, "not_found", `没有找到「${parsed.data.name}」。`, {
            title: parsed.data.name,
            tasks: all,
          });
        }

        let target: TaskView;
        if (candidates.length > 1) {
          const occurrence = parsed.data.occurrence;
          const explicitOccurrence = parseOrdinal(state.lastUserMessage);
          if (!occurrence || occurrence !== explicitOccurrence) {
            return ambiguous(taskAction, parsed.data.name, candidates);
          }
          const index = occurrence - 1;
          if (index < 0 || index >= candidates.length) {
            return ambiguous(taskAction, parsed.data.name, candidates);
          }
          target = candidates[index] as TaskView;
        } else {
          if (parsed.data.occurrence && parsed.data.occurrence !== 1) {
            return ambiguous(taskAction, parsed.data.name, candidates);
          }
          target = candidates[0] as TaskView;
        }

        if (taskAction === "complete") {
          const updated = tasks.update(target.id, { done: true });
          const confirmed = tasks.list().find((task) => task.id === target.id);
          if (!updated || !confirmed || confirmed.done !== true) {
            return failure(taskAction, "store_error", "未能确认任务已完成，请稍后重试。", {
              title: target.title,
            });
          }
          return success("complete", confirmed.title);
        }

        const removed = tasks.remove(target.id);
        const stillExists = tasks.list().some((task) => task.id === target.id);
        if (!removed || stillExists) {
          return failure(taskAction, "store_error", "未能确认任务已删除，请稍后重试。", {
            title: target.title,
          });
        }
        return success("delete", target.title);
      } catch (error) {
        console.error("执行任务工具失败", error);
        return failure(taskAction, "store_error", "任务操作失败，请稍后重试。");
      }
    }

    default:
      return failure("unknown", "unknown_tool", `未知工具：${call.function.name}`);
  }
}

function actionForTool(name: string): TaskAction | "unknown" {
  switch (name) {
    case "list_tasks":
      return "list";
    case "create_task":
      return "create";
    case "complete_task":
      return "complete";
    case "delete_task":
      return "delete";
    default:
      return "unknown";
  }
}

function findTaskCandidates(tasks: TaskView[], name: string): TaskView[] {
  const query = normalizeName(name);
  const exact = tasks.filter((task) => normalizeName(task.title) === query);
  if (exact.length > 0) return exact;

  return tasks.filter((task) => normalizeName(task.title).includes(query));
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function isLikelyTaskRequest(message: string, tasks: TaskStore): boolean {
  if (TASK_REQUEST_PATTERN.test(message)) return true;
  try {
    const normalizedMessage = normalizeName(message);
    return tasks.list().some((task) => {
      const title = normalizeName(task.title);
      return title.length >= 2 && normalizedMessage.includes(title);
    });
  } catch {
    return false;
  }
}

function taskRequiredContent(): string {
  return failJson({
    code: "task_required",
    error:
      "这看起来是待办请求。请先调用 list_tasks，并使用对应任务工具完成操作；不要直接用 respond none 结束。",
  });
}

const CHINESE_ORDINALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseOrdinal(text: string): number | undefined {
  const match = text.match(/第\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:条|个|项|件)/);
  if (!match) return undefined;
  const token = match[1];
  if (!token) return undefined;
  if (/^[0-9]+$/.test(token)) return Number(token);
  return CHINESE_ORDINALS[token];
}

function success(action: Exclude<TaskAction, "list">, title: string): ToolExecution {
  const payload =
    action === "create"
      ? { action, task: { title, done: false } }
      : action === "complete"
        ? { action, task: { title, done: true } }
        : { action, deleted: title };
  return {
    content: okJson(payload),
    report: { action, ok: true, title },
  };
}

function ambiguous(action: TaskAction, title: string, candidates: TaskView[]): ToolExecution {
  return failure(action, "ambiguous", `找到多条匹配「${title}」的任务，请确认要操作哪一条。`, {
    title,
    candidates: candidates.map(toPublic),
  });
}

function failure(
  action: TaskAction | "unknown",
  code: FailureCode,
  error: string,
  options: { title?: string; candidates?: PublicTask[]; tasks?: TaskView[] } = {},
): ToolExecution {
  const content: Record<string, unknown> = { code, error };
  if (options.title) content.title = options.title;
  if (options.candidates) content.candidates = options.candidates;
  if (options.tasks) content.tasks = options.tasks.map(toPublic);

  return {
    content: failJson(content),
    report: {
      action,
      ok: false,
      code,
      error,
      ...(options.title ? { title: options.title } : {}),
      ...(options.candidates ? { candidates: options.candidates } : {}),
    },
  };
}

function isResolvedNotListed(report: ToolReport, reports: ToolReport[]): boolean {
  if (report.code !== "not_listed" || !report.title) return false;
  return reports.some(
    (other) =>
      other !== report &&
      other.action === report.action &&
      other.title === report.title &&
      (other.ok || other.code === "ambiguous" || other.code === "not_found"),
  );
}

function buildReply(reports: ToolReport[], tasks: TaskStore, note?: string): string {
  const lines: string[] = [];
  let taskRelated = false;

  for (const report of reports) {
    if (report.action === "unknown") {
      lines.push(`工具调用失败：${report.error ?? "未知错误"}`);
      continue;
    }

    if (isResolvedNotListed(report, reports)) continue;

    taskRelated = true;
    if (report.action === "list") {
      if (!report.ok) lines.push(`读取任务清单失败：${report.error ?? "未知错误"}`);
      continue;
    }

    if (report.ok) {
      if (report.action === "create") {
        lines.push(`已创建任务「${report.title ?? ""}」。`);
      } else if (report.action === "complete") {
        lines.push(`已把「${report.title ?? ""}」标记为完成。`);
      } else {
        lines.push(`已删除任务「${report.title ?? ""}」。`);
      }
      continue;
    }

    if (report.code === "ambiguous") {
      lines.push(`找到多条匹配「${report.title ?? ""}」的任务，请确认要操作哪一条：`);
      for (const [index, task] of (report.candidates ?? []).entries()) {
        lines.push(`- 第 ${index + 1} 条：${task.title}${task.done ? "（已完成）" : ""}`);
      }
      lines.push("请告诉我第几条，我再继续。");
    } else if (report.code === "not_found") {
      lines.push(`没有找到「${report.title ?? ""}」。`);
    } else if (report.code === "not_listed") {
      lines.push("需要先查询任务清单，再执行完成或删除操作。");
    } else if (
      report.code === "invalid_title" ||
      report.code === "invalid_name" ||
      report.code === "invalid_json"
    ) {
      lines.push(`未能完成操作：${report.error ?? "参数不合法"}`);
    } else if (report.code === "not_executed") {
      lines.push(`未执行操作：${report.error ?? "没有成功调用对应工具。"}`);
    } else {
      lines.push(`操作失败：${report.error ?? "未知错误"}`);
    }
  }

  if (taskRelated) {
    lines.push("", "当前清单：");
    try {
      const list = tasks.list();
      if (list.length === 0) {
        lines.push("（空）");
      } else {
        for (const task of list) {
          lines.push(`- [${task.done ? "x" : " "}] ${task.title}`);
        }
      }
    } catch (error) {
      console.error("读取任务清单失败", error);
      lines.push("（读取失败）");
    }
  }

  if (note) {
    if (lines.length > 0) lines.push("");
    lines.push(note);
  }

  return lines.join("\n").trim() || "操作未执行。";
}

function toView(task: { id: string; title: string; done: boolean }): TaskView {
  return { id: task.id, title: task.title, done: task.done };
}

function toPublic(task: PublicTask): PublicTask {
  return { title: task.title, done: task.done };
}

function okJson(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload });
}

function failJson(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, ...payload });
}

function modelErrorReply(error: unknown): string {
  if (error instanceof Error && error.message.includes("DEEPSEEK_API_KEY")) {
    console.error("未配置 DEEPSEEK_API_KEY，未调用模型。");
    return error.message;
  }
  console.error("调用模型失败", error);
  return "抱歉，模型服务暂时不可用，请稍后再试。";
}
