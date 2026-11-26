import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

type Action = "create" | "complete" | "delete" | "query" | "chat";

let callSequence = 0;

function nextCallId(): string {
  callSequence += 1;
  return `e2e_call_${callSequence}`;
}

function toolCall(name: string, args: Record<string, unknown>): ChatCompletionMessageToolCall {
  return {
    id: nextCallId(),
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function assistantToolCalls(toolCalls: ChatCompletionMessageToolCall[]): ChatCompletionMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls,
  } as ChatCompletionMessage;
}

function assistantRespond(action: Exclude<Action, "chat"> | "none"): ChatCompletionMessage {
  return assistantToolCalls([toolCall("respond", { claimed_action: action })]);
}

function lastUserText(messages: ChatCompletionMessageParam[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  return message && typeof message.content === "string" ? message.content : "";
}

function allToolNames(messages: ChatCompletionMessageParam[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    return (message.tool_calls ?? []).flatMap((call) =>
      call.type === "function" ? [call.function.name] : [],
    );
  });
}

function hasTool(messages: ChatCompletionMessageParam[], name: string): boolean {
  return allToolNames(messages).includes(name);
}

function lastToolResult(
  messages: ChatCompletionMessageParam[],
): Record<string, unknown> | undefined {
  const message = [...messages].reverse().find((item) => item.role === "tool");
  if (!message || typeof message.content !== "string") return undefined;
  try {
    return JSON.parse(message.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractCreateName(text: string): string {
  const name = text
    .replace(/^.*?(?:创建任务|创建|新建|添加|记一下|记一条|记下|提醒我)\s*[:：]?\s*/, "")
    .replace(/[。！？!?]+$/g, "")
    .replace(/吧$/g, "")
    .trim();
  return name || "未命名任务";
}

function extractCompleteName(text: string): string {
  if (/(?:买好了|办好了|搞定了)$/.test(text)) {
    return text.replace(/(?:买好了|办好了|搞定了)$/, "").trim();
  }
  return text
    .replace(/^.*?(?:完成|做完|标记完成|标记)\s*/, "")
    .replace(/[。！？!?]+$/g, "")
    .trim();
}

function extractDeleteName(text: string): string {
  const suffixRemoved = text
    .replace(/\s*(?:这条|这个|该任务)?\s*(?:删除|删掉|移除)吧?$/g, "")
    .trim();
  if (suffixRemoved !== text.trim()) return suffixRemoved;
  return text
    .replace(/^(?:请|帮我)?\s*(?:删除|删掉|移除)\s*/, "")
    .replace(/[。！？!?]+$/g, "")
    .trim();
}

function detectAction(text: string): Action {
  if (/(?:查询|哪些|清单|列出|看看)/.test(text)) return "query";
  if (/(?:创建|新建|添加|记一下|记一条|记下|提醒我|再记一条)/.test(text)) return "create";
  if (/(?:完成|做完|标记|买好了|办好了|搞定了)/.test(text)) return "complete";
  if (/(?:删除|删掉|移除)/.test(text)) return "delete";
  return "chat";
}

export async function e2eModel(
  messages: ChatCompletionMessageParam[],
): Promise<ChatCompletionMessage> {
  const userText = lastUserText(messages);

  // 模拟模型超时/异常，用于验证 Agent 的错误兜底链路。
  if (userText.includes("模拟模型错误")) {
    const error = new Error("Request timed out");
    error.name = "APIConnectionTimeoutError";
    throw error;
  }

  const action = detectAction(userText);

  if (action === "query") {
    return hasTool(messages, "list_tasks")
      ? assistantRespond("query")
      : assistantToolCalls([toolCall("list_tasks", {})]);
  }

  if (action === "create") {
    return hasTool(messages, "create_task")
      ? assistantRespond("create")
      : assistantToolCalls([toolCall("create_task", { title: extractCreateName(userText) })]);
  }

  if (action === "complete" || action === "delete") {
    const toolName = action === "complete" ? "complete_task" : "delete_task";
    if (!hasTool(messages, "list_tasks")) {
      return assistantToolCalls([toolCall("list_tasks", {})]);
    }
    if (!hasTool(messages, toolName)) {
      const name =
        action === "complete" ? extractCompleteName(userText) : extractDeleteName(userText);
      return assistantToolCalls([toolCall(toolName, { name })]);
    }
    const result = lastToolResult(messages);
    return assistantRespond(result?.ok === true ? action : "none");
  }

  return assistantRespond("none");
}
