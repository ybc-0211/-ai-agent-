import { join } from "node:path";
import { createTodoAgent } from "../server/agent.ts";
import { createApp } from "../server/app.ts";
import { createJsonTaskStore } from "../server/task-store.ts";
import { e2eModel } from "./mock-model.ts";

const port = Number(process.env.E2E_PORT || 3100);
const dataFile = process.env.E2E_TASKS_FILE || join("test-results", "e2e-tasks.json");
const tasks = createJsonTaskStore(dataFile);
const app = createApp({
  reply: createTodoAgent({ tasks, callModel: e2eModel }),
  tasks,
});

app.listen(port, "127.0.0.1", () => {
  console.log(`E2E server listening on http://127.0.0.1:${port}`);
  console.log(`E2E data file: ${dataFile}`);
});
