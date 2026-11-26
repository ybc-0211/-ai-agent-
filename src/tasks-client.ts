export type Priority = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  done: boolean;
  priority?: Priority;
  dueDate?: string | null;
  parentId?: string;
}

export interface TaskFields {
  title?: string;
  done?: boolean;
  priority?: Priority;
  dueDate?: string | null;
  parentId?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : "任务请求失败。";
    throw new Error(message);
  }
  return body as T;
}

export async function listTasks(): Promise<Task[]> {
  return request<Task[]>("/api/tasks");
}

export async function createTask(fields: TaskFields & { title: string }): Promise<Task> {
  return request<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

export async function updateTask(id: string, fields: TaskFields): Promise<Task> {
  return request<Task>(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export async function deleteTask(id: string): Promise<void> {
  await request<void>(`/api/tasks/${id}`, { method: "DELETE" });
}
