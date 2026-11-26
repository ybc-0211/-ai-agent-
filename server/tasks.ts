import { Router } from "express";
import { z } from "zod";
import { dueDateSchema, prioritySchema, type Task, type TaskStore } from "./task-store.ts";

const taskFields = {
  priority: prioritySchema.optional(),
  dueDate: dueDateSchema.optional(),
  parentId: z.string().trim().min(1).max(200).optional(),
};

export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  ...taskFields,
});

const updateTaskSchema = createTaskSchema
  .partial()
  .extend({
    done: z.boolean().optional(),
    dueDate: dueDateSchema.nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

function isDescendant(tasks: Task[], parentId: string, taskId: string): boolean {
  const seen = new Set<string>();
  let current = tasks.find((task) => task.id === parentId);
  while (current && !seen.has(current.id)) {
    if (current.parentId === taskId) return true;
    seen.add(current.id);
    current = tasks.find((task) => task.id === current?.parentId);
  }
  return false;
}

function validateParent(
  tasks: Task[],
  parentId: string | undefined,
  taskId?: string,
): string | undefined {
  if (!parentId) return undefined;
  if (!tasks.some((task) => task.id === parentId)) return "父任务不存在。";
  if (taskId && (parentId === taskId || isDescendant(tasks, parentId, taskId))) {
    return "不能把任务移动到自身或自己的子任务下。";
  }
  return undefined;
}

function readFilter(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (req, res) => {
    const status = readFilter(req.query.status);
    const priority = readFilter(req.query.priority);
    if (status && !["all", "open", "completed"].includes(status)) {
      return res.status(400).json({ error: "status 必须是 all、open 或 completed。" });
    }
    if (priority && !["low", "medium", "high"].includes(priority)) {
      return res.status(400).json({ error: "priority 必须是 low、medium 或 high。" });
    }

    let list = tasks.list();
    if (status === "open") list = list.filter((task) => !task.done);
    if (status === "completed") list = list.filter((task) => task.done);
    if (priority) list = list.filter((task) => (task.priority ?? "medium") === priority);
    res.json(list);
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供 1 至 200 个字符的任务标题和有效字段。" });
    }

    const parentError = validateParent(tasks.list(), input.data.parentId);
    if (parentError) return res.status(400).json({ error: parentError });

    res.status(201).json(
      tasks.create(input.data.title, {
        priority: input.data.priority,
        dueDate: input.data.dueDate,
        parentId: input.data.parentId,
      }),
    );
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res
        .status(400)
        .json({ error: "请提供有效的 title、done、priority、dueDate 或 parentId。" });
    }

    const current = tasks.list();
    if (!current.some((task) => task.id === req.params.id)) {
      return res.status(404).json(taskNotFound);
    }
    const parentError = validateParent(current, input.data.parentId, req.params.id);
    if (parentError) return res.status(400).json({ error: parentError });

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
