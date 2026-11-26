import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const prioritySchema = z.enum(["low", "medium", "high"]);
export type Priority = z.infer<typeof prioritySchema>;

function isValidDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidDate, "截止日期必须是有效的 YYYY-MM-DD 日期。");

const storedTask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  priority: prioritySchema.optional(),
  dueDate: dueDateSchema.nullable().optional(),
  parentId: z.string().optional(),
});
const taskList = z.array(storedTask);
export type Task = z.infer<typeof storedTask>;
export type TaskChanges = Partial<
  Pick<Task, "title" | "done" | "priority" | "dueDate" | "parentId">
>;
export interface TaskFields {
  priority?: Priority;
  dueDate?: string;
  parentId?: string;
}

export interface TaskStore {
  list(): Task[];
  create(title: string, fields?: TaskFields): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title, fields = {}) {
      const task: Task = {
        id: randomUUID(),
        title,
        done: false,
        priority: fields.priority ?? "medium",
        ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
        ...(fields.parentId ? { parentId: fields.parentId } : {}),
      };
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, changes);
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      if (!tasks.some((task) => task.id === id)) return false;

      const removed = new Set([id]);
      let foundChild = true;
      while (foundChild) {
        foundChild = false;
        for (const task of tasks) {
          if (task.parentId && removed.has(task.parentId) && !removed.has(task.id)) {
            removed.add(task.id);
            foundChild = true;
          }
        }
      }

      save(tasks.filter((task) => !removed.has(task.id)));
      return true;
    },
  };
}
