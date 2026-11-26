import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type Priority,
  type Task,
} from "./tasks-client.ts";

const priorityLabels: Record<Priority, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function priorityOf(task: Task): Priority {
  return task.priority ?? "medium";
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const parentOrder = Number(Boolean(a.parentId)) - Number(Boolean(b.parentId));
    if (parentOrder !== 0) return parentOrder;
    const priorityOrder = priorityRank[priorityOf(a)] - priorityRank[priorityOf(b)];
    if (priorityOrder !== 0) return priorityOrder;
    return (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
  });
}

export function TaskPanel({ refreshToken }: { refreshToken: number }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "completed">("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | Priority>("all");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [parentId, setParentId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("medium");
  const [editDueDate, setEditDueDate] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const titleInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks(await listTasks());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取任务失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  async function addTask(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    try {
      await createTask({
        title: title.trim(),
        priority,
        dueDate: dueDate || undefined,
        parentId: parentId || undefined,
      });
      setTitle("");
      setDueDate("");
      setParentId("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建任务失败。");
    }
  }

  async function toggleTask(task: Task) {
    try {
      await updateTask(task.id, { done: !task.done });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新任务失败。");
    }
  }

  async function removeTask(task: Task) {
    try {
      await deleteTask(task.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除任务失败。");
    }
  }

  function beginEdit(task: Task) {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditPriority(priorityOf(task));
    setEditDueDate(task.dueDate ?? "");
  }

  async function saveEdit() {
    if (!editingId || !editTitle.trim()) return;
    try {
      await updateTask(editingId, {
        title: editTitle.trim(),
        priority: editPriority,
        dueDate: editDueDate || null,
      });
      setEditingId(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存任务失败。");
    }
  }

  function startSubtask(parent: Task) {
    setParentId(parent.id);
    setTitle("");
    titleInput.current?.focus();
  }

  const visible = sortTasks(
    tasks.filter((task) => {
      if (statusFilter === "open" && task.done) return false;
      if (statusFilter === "completed" && !task.done) return false;
      if (priorityFilter !== "all" && priorityOf(task) !== priorityFilter) return false;
      return true;
    }),
  );
  const visibleIds = new Set(visible.map((task) => task.id));
  const roots = sortTasks(
    visible.filter((task) => !task.parentId || !visibleIds.has(task.parentId)),
  );
  const parentOptions = tasks.filter((task) => !task.parentId);

  function renderTask(task: Task, depth: number): ReactNode {
    const children = sortTasks(visible.filter((child) => child.parentId === task.id));
    const meta = [
      `${priorityLabels[priorityOf(task)]}优先级`,
      task.dueDate ? `截止 ${task.dueDate}` : "",
      depth > 0 ? "子任务" : "",
    ].filter(Boolean);

    return (
      <Fragment key={task.id}>
        <div
          className="task-row"
          data-testid={`task-row-${task.id}`}
          style={{ marginLeft: depth * 18 }}
        >
          {editingId === task.id ? (
            <div className="task-edit">
              <input
                aria-label="编辑任务标题"
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
              />
              <div className="task-edit-row">
                <select
                  aria-label="编辑任务优先级"
                  value={editPriority}
                  onChange={(event) => setEditPriority(event.target.value as Priority)}
                >
                  <option value="high">高优先级</option>
                  <option value="medium">中优先级</option>
                  <option value="low">低优先级</option>
                </select>
                <input
                  aria-label="编辑截止日期"
                  type="date"
                  value={editDueDate}
                  onChange={(event) => setEditDueDate(event.target.value)}
                />
                <button type="button" onClick={() => void saveEdit()}>
                  保存
                </button>
                <button type="button" className="secondary" onClick={() => setEditingId(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                type="checkbox"
                aria-label={
                  task.done ? `重新打开任务「${task.title}」` : `完成任务「${task.title}」`
                }
                checked={task.done}
                onChange={() => void toggleTask(task)}
              />
              <div className="task-main">
                <span className={task.done ? "task-title done" : "task-title"}>{task.title}</span>
                <small>{meta.join(" · ")}</small>
              </div>
              <div className="task-actions">
                <button type="button" className="link" onClick={() => beginEdit(task)}>
                  编辑
                </button>
                <button type="button" className="link" onClick={() => startSubtask(task)}>
                  子任务
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => void removeTask(task)}
                  aria-label={`删除任务「${task.title}」`}
                >
                  删除
                </button>
              </div>
            </>
          )}
        </div>
        {children.map((child) => renderTask(child, depth + 1))}
      </Fragment>
    );
  }

  return (
    <aside className="task-panel" aria-label="任务清单">
      <div className="task-head">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h2>任务清单</h2>
        </div>
        <button type="button" className="link" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      <form className="task-form" onSubmit={(event) => void addTask(event)}>
        <input
          ref={titleInput}
          aria-label="任务标题"
          placeholder={parentId ? "子任务标题…" : "新任务标题…"}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="task-form-row">
          <select
            aria-label="任务优先级"
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
          >
            <option value="high">高优先级</option>
            <option value="medium">中优先级</option>
            <option value="low">低优先级</option>
          </select>
          <input
            aria-label="截止日期"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </div>
        <select
          aria-label="父任务"
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
        >
          <option value="">作为顶层任务</option>
          {parentOptions.map((task) => (
            <option key={task.id} value={task.id}>
              子任务：{task.title}
            </option>
          ))}
        </select>
        <button type="submit" className="primary">
          添加任务
        </button>
      </form>

      <div className="task-filters">
        <select
          aria-label="状态筛选"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
        >
          <option value="all">全部状态</option>
          <option value="open">待完成</option>
          <option value="completed">已完成</option>
        </select>
        <select
          aria-label="优先级筛选"
          value={priorityFilter}
          onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}
        >
          <option value="all">全部优先级</option>
          <option value="high">高优先级</option>
          <option value="medium">中优先级</option>
          <option value="low">低优先级</option>
        </select>
      </div>

      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="task-empty">正在读取任务…</p>
      ) : visible.length === 0 ? (
        <p className="task-empty">当前筛选下没有任务。</p>
      ) : (
        <div className="task-list" role="list">
          {roots.map((task) => renderTask(task, 0))}
        </div>
      )}
    </aside>
  );
}
