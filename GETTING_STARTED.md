# Todo Agent 本地开发指南

本指南覆盖从安装、配置到启动、测试的完整流程。所有命令均以项目根目录为工作目录。

## 1. 环境要求

| 项目             | 要求                                      |
| ---------------- | ----------------------------------------- |
| Node.js          | **24.12 或更高版本**                      |
| npm              | 随 Node.js 安装                           |
| 操作系统         | Windows、macOS 或 Linux                   |
| DeepSeek API Key | 真实对话需要；任务 API 和自动化测试不需要 |

检查版本：

```bash
node --version
npm --version
```

Node.js 24 可以直接运行本项目中的 `.ts` 文件，不需要安装 `ts-node` 或 `tsx`。

## 2. 获取项目

```bash
git clone https://github.com/ybc-0211/-ai-agent-.git
cd -ai-agent-
```

如果本地已经存在项目目录，直接进入项目根目录即可。

## 3. 安装依赖

```bash
npm ci
```

`npm ci` 会依据 `package-lock.json` 安装锁定版本。通常不需要手动执行 `npm install`。

## 4. 配置 DeepSeek API Key

### 4.1 创建 `.env`

macOS / Linux：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

也可以手动复制 `.env.example` 并重命名为 `.env`。

### 4.2 填写配置

```env
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=deepseek-flash
```

| 变量               | 是否必需         | 说明                          |
| ------------------ | ---------------- | ----------------------------- |
| `DEEPSEEK_API_KEY` | 真实模型调用必需 | 不要提交到 Git，不要写入前端  |
| `DEEPSEEK_MODEL`   | 可选             | 默认 `deepseek-flash`         |
| `PORT`             | 可选             | 默认 3000，只监听 `127.0.0.1` |

注意：

- 本文档中的 `your_deepseek_api_key` 是占位符，不是真实 Key。
- `.env` 已被 `.gitignore` 忽略；仓库中只保留 `.env.example`。
- 不要将真实 Key 粘贴到 README、Issue、日志或截图中。
- 没有 Key 时，任务 API 和 `npm test` 仍然可用；真实聊天会返回配置提示。

## 5. 启动开发服务

```bash
npm run dev
```

该命令会：

1. 通过 `predev` 执行 `npm run build`，生成 `dist/chat.js`；
2. 执行 `node --watch --env-file-if-exists=.env server/index.ts`；
3. 在 <http://127.0.0.1:3000> 提供页面和 API。

修改服务端 `.ts` 文件后，watch 会自动重启。修改 `src/` 下的前端 TSX 后，需要重新运行 `npm run build` 并刷新页面。

### 5.1 指定端口

```bash
# macOS / Linux
PORT=3001 npm run dev

# Windows PowerShell
$env:PORT=3001; npm run dev
```

### 5.2 生产式启动

```bash
npm run build
npm start
```

`npm start` 不会自动构建前端。若页面无法加载 `/assets/chat.js`，先执行 `npm run build`。

## 6. 测试与检查

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

E2E 首次运行前安装 Playwright Chromium：

```bash
npx playwright install chromium
```

当前测试情况：

- `server/agent.test.ts`：40 个 Mock Agent 测试；
- `server/app.test.ts`：4 个任务/聊天 API 测试；
- `e2e/todo.spec.ts`：8 个 Playwright E2E 测试；
- 共 52 个测试（44 个单元/API + 8 个 E2E），均不调用真实 DeepSeek API。
- E2E 使用 `e2e/server.ts` 和 `e2e/mock-model.ts`，覆盖真实浏览器到任务存储的完整链路。

格式检查：

```bash
npm run fmt:check
```

说明：

- 当前仓库中的 `AGENTS.md`、`SUBMIT.md` 等既有文档可能存在格式问题，`fmt:check` 可能失败；本次修改的三份文档已通过 oxfmt 检查。
- 不要直接运行 `npm run fmt`，因为它可能修改 `SUBMIT.md`；按照 `AGENTS.md`，该文件不应编辑。
- 代码质量门禁建议使用 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。

GitHub Actions 配置在 `.github/workflows/ci.yml`，在 `push` 和 `pull_request` 时运行上述检查、安装 Playwright Chromium 并执行 E2E；全仓 `fmt:check` 因上述既有文档基线作为非阻塞步骤运行。

## 7. 常见错误处理

| 现象                                        | 原因                                | 处理                                                 |
| ------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| 启动时报 TypeScript/语法相关错误            | Node.js 版本过低                    | 升级到 Node.js 24.12+                                |
| 聊天回复“请在 .env 中设置 DEEPSEEK_API_KEY” | 未配置 Key                          | 创建 `.env` 并填写 Key，重启服务                     |
| 聊天回复“模型服务暂时不可用”                | Key 无效、网络、超时或模型服务异常  | 检查 Key、网络和 DeepSeek 服务状态                   |
| 请求长时间无响应                            | 模型客户端 60 秒超时                | 检查网络或模型服务，稍后重试                         |
| Playwright 报找不到浏览器                   | 未安装 Chromium                     | 执行 `npx playwright install chromium`               |
| 3000 端口被占用                             | 端口冲突                            | 设置 `PORT` 后重启                                   |
| 页面能打开但 `/assets/chat.js` 404          | 前端未构建                          | 执行 `npm run build`                                 |
| 修改前端后页面没有变化                      | 只重启了服务端                      | 重新执行 `npm run build` 并刷新                      |
| `npm run fmt:check` 失败                    | 仓库既有 Markdown 格式问题          | 不要直接 `npm run fmt`；优先使用 test/typecheck/lint |
| 首次创建任务时报写入失败                    | 项目目录不可写                      | 确认项目根目录可写，或检查 `data/` 权限              |
| `git status` 出现 `todo/`                   | 未跟踪的独立仓库/目录，不属于本项目 | 不要提交它                                           |
| 任务查询为空                                | 尚未创建任务                        | 先通过聊天创建任务，或调用 `POST /api/tasks`         |

## 8. 数据与运行时文件

| 路径              | 说明                                            |
| ----------------- | ----------------------------------------------- |
| `data/tasks.json` | 首次创建任务时生成，保存全部任务；已被 Git 忽略 |
| `dist/chat.js`    | esbuild 生成的前端 bundle；已被 Git 忽略        |
| `.env`            | 本地 API Key 配置；已被 Git 忽略                |
| `node_modules/`   | 依赖目录；已被 Git 忽略                         |

浏览器中的聊天记录不会持久化；刷新页面会重新开始对话。任务数据会持久化到 `data/tasks.json`。

## 9. 相关文档

- [README](../README.md)
- [架构说明](architecture.md)
- [任务 API OpenAPI 定义](../server/openapi.yaml)
