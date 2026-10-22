# Mini Agent

一个用于学习 Agent 架构的 TypeScript 编码助手。项目自行实现模型与工具之间的循环，用 Pi TUI 提供终端界面，并提供经典 CLI 和 HTTP/SSE 接口。

界面通过 `AgentClient` 发送结构化命令、订阅事件。Agent 核心负责模型调用与工具执行，应用运行时负责会话、配置、审批和持久化。接入 Web、桌面或 App 时，可以复用这套接口。学习代码建议从 [ARCHITECTURE.md](./ARCHITECTURE.md) 开始。

当前版本 **1.1.0**：增加任务状态、模型结束原因、结构化执行结果和验证记录。版本变化见 [CHANGELOG.md](./CHANGELOG.md)。

## 环境与启动

- Node.js **22.19.0 或更高版本**，以及 npm。
- TUI 需要支持 ANSI 的交互终端，例如 Windows Terminal。
- 在线模型需要对应的 API Key；本地服务按供应商要求配置。

```bash
npm install
npm run dev
```

其他入口：

```bash
npm run dev:classic   # 经典 readline CLI
npm run server        # HTTP/SSE 后端，默认 127.0.0.1:3000
npm run demo          # 离线演示基本模型/工具循环，不调用在线模型
```

全局使用：

```bash
npm link
cd /path/to/project
mini-agent
```

`mini-agent --classic` 使用经典 CLI。启动目录默认是主工作区；可以通过 `AGENT_WORKSPACE` 覆盖。非 TTY 或 `TERM=dumb` 时，TUI 入口自动使用经典 CLI，支持管道输入。

## 模型和 API Key

复制 `.env.example` 为 `.env`，填写需要的密钥。真实 `.env` 已被 Git 忽略。

当前支持 DeepSeek、OpenAI、Anthropic、Gemini、Qwen、Kimi、GLM、SiliconFlow、Groq、Ollama 和自定义 OpenAI 兼容服务。首次启动默认 DeepSeek；具体默认模型见 `src/core/providers.ts`。模型列表优先在线发现，失败时提供备用列表和手动输入。

也可以在 TUI 输入：

```text
/model
/key deepseek
```

密钥输入会遮挡显示，随后选择仅本次运行使用或保存到本机。保存位置默认是 `~/.config/mini-agent/credentials.json`，属于明文文件。临时密钥不会写入环境变量或会话。当前运行时中新输入的密钥优先使用；重新启动后，环境变量优先于已保存的凭据。

模型选择默认保存在 `~/.config/mini-agent/model-selection.json`。Ollama 和自定义服务可通过 `OLLAMA_BASE_URL`、`CUSTOM_BASE_URL` 等供应商变量设置地址。

## 终端交互

TUI 使用 [Pi TUI](https://github.com/earendil-works/pi/tree/main/packages/tui)，启动时展示由头像转换的 Unicode 点阵字符画，保存在 `src/presentation/assets/launch-art.txt`。图案按终端字符格等比缩放，窗口过小时使用简短标识。

默认使用备用屏幕：启动后显示独立界面，退出时恢复原终端。对话区支持应用内鼠标滚动，底部保留输入与提示区域。设置 `AGENT_TUI_SCREEN=regular` 可改用终端主屏幕及原生滚动缓冲区。

每条用户消息开始新一轮对话，以独立边框包住用户输入、助手回复和工具调用。边框按窗口宽度调整，流式回复和执行中的工具也显示在本轮框内；模型内部多次调用标为“第 N 步”。

| 内容           | 展示方式                                                |
| -------------- | ------------------------------------------------------- |
| 用户消息       | 绿色标签与正文，保留在对话区                            |
| 助手回复       | Markdown 正文，保留在对话区                             |
| Token 用量     | 每条助手回复下方的暗色文字                              |
| 思考耗时       | 请求中实时计时，回复下方保留本次或本轮累计耗时          |
| 工具执行       | 显示当前执行进度，每轮保留最近 5 条已完成调用及结果摘要 |
| 状态提示       | 底部原位替换，保留最新提示                              |
| 帮助和查询结果 | 输入框上方的临时面板，可翻页、关闭                      |
| 权限审批       | 单独的确认面板，显示参数或文件差异                      |

最终回复显示本轮所有成功模型调用返回的用量，包括上下文摘要调用；中间回复显示该次调用用量。供应商没有提供用量时会标明，部分调用缺少用量时会标注部分统计。Token 数随会话消息保存。终端无法单独缩小字号，因此使用暗色文字区分。

`Ctrl+O` 循环切换三种工具展示状态：**全部收起 → 最近五条（默认）→ 全部展示 → 全部收起**。全部收起时每轮只显示工具调用次数，包含正在执行的一次调用；默认状态显示当前执行进度和最近五条已完成记录，并标记折叠数量。`AGENT_TUI_MAX_TOOL_ENTRIES` 可调整默认状态的条数，须为正整数。展示切换作用于所有轮次，不修改完整历史和工具执行。已归档的完整工具结果仍可通过 `/outputs`、`/output` 查看。

思考计时从发起模型请求开始，到首段回复正文为止，包含网络等待；仅返回工具调用或非流式回复时，计到该次回复完成。工具执行和后续正文流式输出不计入；中间回复显示本次耗时，最终回复显示本轮累计值，并随会话保存。它是客户端观测的耗时，不是服务商报告的纯推理耗时。`Ctrl+I` 切换思考过程文本，耗时提示始终保留。

思考过程默认折叠；按一次 `Ctrl+I` 展开，再按一次收起。已收到的思考文本保留在当前界面的内存中，回复完成后仍可展开，长内容可滚动查看；展开时自动定位到最近的思考过程。文本不写入会话文件，切换、清空会话或重启后不保留。只展示模型接口实际返回的思考文本；未返回时会给出提示，已有耗时数字不代表模型提供了思考内容。

| 按键                      | 操作                                                     |
| ------------------------- | -------------------------------------------------------- |
| `Enter`                   | 发送；命令候选打开时确认候选                             |
| `Shift+Enter` / `Ctrl+J`  | 换行；不支持修饰键的终端也可用反斜杠后接 Enter           |
| `←` / `→`、`Home` / `End` | 移动输入光标                                             |
| `Backspace`               | 删除光标前的字符或完整 emoji                             |
| `Delete` / `Ctrl+D`       | 删除光标处的字符                                         |
| `↑` / `↓`                 | 空输入时浏览历史，候选打开时选择候选；多行输入时移动光标 |
| `Tab`                     | 命令、参数或文件路径补全                                 |
| `PgUp` / `PgDn`           | 回看对话；面板打开时翻页面板                             |
| `Ctrl+Home` / `Ctrl+End`  | 全屏模式中跳到对话顶部或底部                             |
| `Ctrl+Shift+F`            | 全屏模式中搜索对话，Esc 关闭搜索                         |
| `Ctrl+I`                  | 展开或收起思考过程，默认收起，耗时始终显示               |
| `Ctrl+O`                  | 工具记录：全部收起 / 最近五条（默认）/ 全部展示          |
| `Ctrl+C`                  | 执行中取消任务；空闲时先清空草稿，空草稿时退出           |
| `Esc`                     | 关闭候选、帮助、查询或确认面板                           |

输入 `/` 自动显示命令建议。`/permission`、`/thinking`、`/session` 等支持参数补全。历史输入仅保留在当前进程；会话消息持久保存。剪贴板、中文输入法定位和修饰键表现仍取决于实际终端。

支持扩展键盘协议的终端可以区分 `Ctrl+I` 和 Tab。传统终端会将两者编码为同一按键：任务执行中或空输入时切换思考过程；有输入草稿时保留 Tab 补全。也可以使用 `/thinking` 或兼容快捷键 `Ctrl+T` 切换思考过程。

## 斜杠命令

| 命令                                  | 用途                                           |
| ------------------------------------- | ---------------------------------------------- |
| `/help`                               | 按类型、命令、内容、示例纵向显示帮助           |
| `/model`、`/models`                   | 选择供应商和模型                               |
| `/model <provider> [model-id]`        | 选择指定供应商或模型                           |
| `/refresh-models`                     | 重新获取当前供应商的模型列表                   |
| `/key <provider>`                     | 配置密钥                                       |
| `/session`                            | 列出会话                                       |
| `/session <id>`                       | 切换或创建会话                                 |
| `/session delete <id>`                | 确认后删除会话及其专属数据                     |
| `/reset`                              | 清空当前对话和 Todo，保留长期记忆              |
| `/permission [read-only\|ask\|allow]` | 查看或切换权限                                 |
| `/dirs`、`/addDir <path>`             | 查看可写目录或申请目录授权                     |
| `/thinking [on\|collapse\|off]`       | 控制思考显示                                   |
| `/todos`、`/stats`、`/tools`          | 查看任务、统计和工具                           |
| `/task`                               | 查看本轮任务状态、结束原因、文件修改和检查结果 |
| `/memories [project\|global]`         | 查看长期记忆                                   |
| `/outputs`                            | 查看当前会话引用的归档输出                     |
| `/output <id> [offset]`               | 按字符偏移分页查看归档输出                     |
| `/close-output`                       | 关闭输出面板，也可按 Esc                       |
| `/exit`                               | 退出                                           |

会话 ID 是 1–64 位英文字母、数字、下划线或连字符。删除当前会话后自动切换；长期记忆和共享工具输出归档保留。经典 CLI 复用相同命令路由，以普通文本显示结果；`/model` 列出选项后通过完整命令选择，思考面板显示模式属于 TUI 功能。

## V1.1：任务状态与执行结果

每次发送消息创建一个独立任务，任务属于当前会话，并有自己的 `runId`。底部提示原位更新任务状态，`/task` 打开详细报告。

| 状态               | 含义                                                       |
| ------------------ | ---------------------------------------------------------- |
| `running`          | 正在请求模型或执行工具                                     |
| `waiting_approval` | 等待用户授权工具                                           |
| `completed`        | 模型正常返回最终回复，且没有未解决的授权拒绝或当前失败检查 |
| `failed`           | 请求或执行异常、输出截断、空回复、检查失败或保存失败       |
| `cancelled`        | 用户取消了本轮任务                                         |
| `blocked`          | 模型拒绝、服务商暂停生成，或工具未获授权                   |

模型适配器保留原始结束原因，并统一为 `stop`、`tool_calls`、`length`、`blocked`、`pause`、`error`、`unknown`。输出被截断、拒绝或暂停时，已收到的正文会保留并标记未完成，相关工具调用不会执行；断流保留已收到的正文。兼容服务未提供结束原因时记录 `unknown`，有有效正文的最终回复仍可结束任务。暂停状态目前需要用户再次发起请求。

执行结果包含回复摘要、工具提供的文件修改记录、命令退出码和日志位置、验证状态、已记录的未完成事项，以及本轮调用次数和 Token 用量。内置 `write_file` 提供文件记录；任意命令或 MCP 的全部文件副作用目前不能自动枚举，扩展工具需要实现 `Tool.evidence`。

**验证状态单独记录**：没有运行检查时为 `not_run`；只有实际执行、标记 `purpose: 'verification'` 的命令才计入验证。模型声称“检查通过”不会产生验证记录。同一命令以最后一次结果为准；检查后再次写文件，会使旧检查失去当前有效性，需要重新检查。仅在用户要求或授权时运行检查，且检查通过只表示这些命令通过，不代表任务语义已得到完整验收。

每个会话最后一条任务结果保存在 `.mini-agent/tasks/<session-id>.json`，切换会话或重启后可查看。重置或删除会话时同步删除。执行日志能提示异常中断；当前没有任务断点续跑，也不会自动重放写入操作。

## 多端接入

应用接口位于 `src/app/contracts.ts`：

```text
initialize()          获取初始状态
subscribe(listener)   订阅消息、流式进度、状态和审批事件
dispatch(command)     执行结构化命令
close()               释放当前客户端或宿主资源
```

TUI 和经典 CLI 使用进程内 `AgentRuntime`；浏览器或桌面前端可以使用 `HttpAgentClient`，也可以基于相同协议实现 IPC/WebSocket 适配器。

新客户端使用结构化任务接口：

```ts
const result = await client.dispatch({ type: 'tasks.run', input: '分析当前项目' });
console.log(result.status, result.summary, result.verification.status);

const task = await client.dispatch({ type: 'tasks.current' });
// subscribe() 中的 task 事件提供运行、审批和结束状态；快照也包含 task。
```

`tasks.run` 对执行失败、受阻或取消返回对应的 `TaskResult`；输入不合法或已有任务运行时仍拒绝请求。旧的 `run` 命令继续返回回复字符串，失败时拒绝 Promise。UI 仅消费这些数据，不参与模型循环和完成状态判定。

HTTP 后端提供：

| 接口                 | 用途                             |
| -------------------- | -------------------------------- |
| `GET /api/state`     | 当前状态快照                     |
| `GET /api/events`    | SSE 事件流，连接后先发送当前快照 |
| `POST /api/commands` | 接收经过校验的结构化命令         |

请求使用 `Authorization: Bearer <token>`。未设置 `AGENT_SERVER_TOKEN` 时，启动后端会生成并在终端显示本次令牌。浏览器接入时设置 `AGENT_CLIENT_ORIGIN` 为前端的完整 Origin。后端默认仅监听本机；跨设备访问需要部署后端及相应网络入口。

目前提供的是运行时、协议和适配器，尚未实现 Web、桌面或移动界面。同一后端中的客户端共享活动会话，一次只运行一个任务。同一个会话文件应由一个运行时负责写入；多用户服务需要在宿主层分配运行时与工作区。

## 工具、权限和上下文

- 文件工具支持目录浏览、分页读取、SHA-256 校验及写入。覆盖已有文件前必须读取并提交 `expectedSha256`；外部修改会产生冲突。
- `read-only` 拒绝写入、命令和外部 MCP 调用；`ask` 在写入前审批；`allow` 自动允许已授权目录内的内置写入。命令、额外目录和 MCP 调用仍需确认。
- Agent 可以管理 Todo、搜索会话、读写项目/全局长期记忆，并按需读取归档工具输出。
- 每次任务不设固定模型调用轮数上限：模型返回有效工具调用时继续执行，正常返回不含工具调用的最终回复时结束；用户取消、模型异常结束或执行报错也会停止。原有 `AGENT_MAX_STEPS` 配置已移除。
- 上下文窗口默认 **128k（131,072 Token）**，包含输入、工具定义和输出预留；默认预留 8,192 Token 输出及 8% 安全余量，因此可用输入预算小于 128k。可以召回记忆、裁剪工具结果，并在达到可用输入预算的 80% 时压缩完整旧轮次；当前轮次仍超出预算时会报错，原始历史保存在磁盘。模型实际容量较小时，使用 `AGENT_CONTEXT_WINDOW_OVERRIDE` 调低窗口。
- Settings、Skills 和 stdio MCP 支持全局及项目配置，项目配置优先。

文件权限是应用层策略，不是操作系统沙箱。获批程序和 MCP Server 的副作用无法完全被工作区路径检查约束。取消会停止后续调用，并尝试终止正在执行的命令进程树；已经发生的文件或外部副作用不会自动回滚。

## 配置与 Git

主工作区的 `.mini-agent/` 保存项目指令、配置、会话、记忆、Todo、压缩摘要、审批、执行日志、任务结果和工具输出。用户级配置位于 `~/.config/mini-agent/`，保存凭据、模型选择、全局记忆、Settings、Skills 和 MCP 配置。

应提交源码、测试、文档、`package.json`、`package-lock.json`、`.env.example`、格式配置和启动图案。真实 `.env`、`.mini-agent/`、`.agent-state/`、`.agent-command-logs/`、`node_modules/`、`.tmp/` 和构建输出保留在本地。

常用环境变量：

| 变量                                                             | 用途                                      |
| ---------------------------------------------------------------- | ----------------------------------------- |
| `AGENT_WORKSPACE`、`AGENT_SESSION_ID`                            | 工作区与启动会话                          |
| `AGENT_TUI_SCREEN`                                               | 默认全屏；`regular` 使用主屏幕            |
| `AGENT_TUI_MAX_TOOL_ENTRIES`                                     | 每轮已完成工具记录展示上限，默认 5        |
| `AGENT_MAX_INPUT_CHARS`                                          | 单次用户输入字符上限，默认 65536          |
| `AGENT_CONTEXT_WINDOW_OVERRIDE`、`AGENT_OUTPUT_RESERVE`          | 总上下文窗口与输出预留，默认 131072、8192 |
| `AGENT_CONTEXT_SUMMARIZE`、`AGENT_COMPACT_THRESHOLD`             | 摘要开关和压缩阈值                        |
| `AGENT_MODEL_STATE_FILE`、`AGENT_CREDENTIALS_FILE`               | 模型选择与凭据路径                        |
| `AGENT_MEMORY_FILE`、`AGENT_GLOBAL_MEMORY_FILE`                  | 项目与全局记忆路径                        |
| `AGENT_ARTIFACT_DIR`                                             | 工具输出归档目录                          |
| `MCP_COMMAND`、`MCP_ARGS_JSON`                                   | 额外 stdio MCP Server                     |
| `AGENT_SERVER_PORT`、`AGENT_SERVER_TOKEN`、`AGENT_CLIENT_ORIGIN` | HTTP 后端配置                             |

完整起始配置见 `.env.example`。

## 状态迁移

在目标项目目录使用：

```bash
mini-agent export --out ./project.magent
mini-agent inspect ./project.magent
mini-agent import ./project.magent
```

`--global` 包含全局状态；导入默认预览，确认后仅创建不存在的文件。迁移包不包含源代码、依赖和 API 凭据；MCP 默认禁用，外部目录授权需要重新核对。对话或工具结果也可能含有敏感内容；导出会检查常见密钥格式。

## 开发检查

```bash
npm run check
npm test
npm run format:check
npm run format
```

检查包含全部 TypeScript 源码、测试和工作区文件，以及 JavaScript 入口、迁移库和演示脚本的语法；启用了严格模式和未使用代码检查。测试包含核心、存储、权限、模型协议、迁移、运行时、HTTP/SSE、入口及无界面终端交互。在线模型和不同真实终端仍需按实际使用环境验证。
