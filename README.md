# Mini Agent

一个用于学习和扩展的通用 Agent，使用 TypeScript / Node.js 开发。模型负责理解和行动，运行时负责目标、执行、权限、状态保存与交付检查；编码、研究、文档等任务通过工作流和工具表达。

当前为 **V1.2.0 开发版**。核心、执行调度、默认实现、宿主装配和 UI 已按职责拆分。TUI 是一个客户端，Web、桌面或 App 可以使用同一协议接入。

- [架构与代码阅读顺序](./ARCHITECTURE.md)
- [技术规划与版本路线](./doc/technical-roadmap.md)
- [模块替换与客户端开发](./doc/module-development.md)
- [工作流、工具和上下文配置](./doc/v1.2-usage.md)
- [更新记录](./CHANGELOG.md)

## 快速启动

需要 Node.js **22.19.0+** 和 npm。在项目目录执行：

```powershell
npm install
Copy-Item .env.example .env
```

只在首次配置时复制，已有 `.env` 应保留。编辑 `.env`，填写准备使用的提供方密钥，例如 `DEEPSEEK_API_KEY`。首次默认选择 DeepSeek，之后记住选择的模型。

```powershell
npm run dev
```

其他入口：

```powershell
npm run dev:classic  # 经典命令行，支持管道
npm run server       # HTTP 命令 + SSE 事件
npm run demo         # 无需 API Key 的 Agent 循环教学演示
```

`demo` 只演示模型与工具的消息循环，不运行完整 Task 工作流。TUI 在非交互终端会自动使用经典 CLI。

需要从其他工作目录启动时，可在源码目录运行 `npm link`，之后进入目标目录执行 `mini-agent` 或 `mini-agent --classic`。默认工作区是启动时的目录；密钥也可通过环境变量或 `/key <provider>` 配置。

## 当前能力

| 模块     | 已实现                                                                                  |
| -------- | --------------------------------------------------------------------------------------- |
| 模型     | 统一消息、工具调用、流式事件、用量与结束原因；OpenAI 兼容协议、Anthropic、Gemini 适配器 |
| 自主执行 | 模型 → 工具 → 观察结果 → 继续执行；直到模型正常完成，没有默认 15 轮限制                 |
| 工作流   | Agent、单次模型、工具、人工输入节点；输入输出绑定、条件边、串行循环                     |
| 任务     | Session → Task → Run → NodeRun；目标跨轮继续、计划确认、等待、取消、边界暂停、显式恢复  |
| 上下文   | 默认总窗口 131072 Token；输出预留、摘要、旧轮次裁剪、记忆与提示策略可配置               |
| 工具     | 工作区、文件、命令、记忆、历史、Todo、长输出读取；宿主自定义工具、配置别名、stdio MCP   |
| 验收     | 内核生成固定清单，检查交付文件是否齐全，缺失时返回执行阶段；纯回复标记不适用            |
| 可观测   | 模型/工具/上下文记录、调用证据、Token、耗时、状态修订与四层身份关联                     |
| UI 接口  | JSON 命令、快照和事件；本地 AgentClient 与 HTTP/SSE 客户端                              |
| 模块扩展 | 替换模型、Agent 循环、上下文、记忆、权限、工作流目录、任务存储、验收器及节点执行器      |

文件完整性通过只说明清单中的文件存在。命令检查的退出码单独记录，当前版本不做模型语义验收或质量评分。

## 一次任务如何执行

```mermaid
flowchart LR
  A[用户输入] --> B[准备交付清单与计划]
  B --> C[可选计划确认]
  C --> D[执行配置化工作流]
  D --> E[内核检查交付完整性]
  E -->|缺失文件| D
  E -->|齐全或纯回复不适用| F[保存结果]
```

用户配置的是执行阶段内部的图。清单准备、状态提交和完整性检查由运行时管理。纯回复任务同样经过准备阶段，报告使用 `not_applicable`。

同一会话可以有多个 Task；每次独立推进创建 Run，环路再次进入节点创建新的 NodeRun。Run 内的业务 `state.data` 与节点执行记录分别保存。

## 终端操作

每轮对话独立成框；提示显示在固定区域，查询和帮助使用可翻页面板。流式回答、工具记录与思考显示分别管理。

| 操作                | 效果                                     |
| ------------------- | ---------------------------------------- |
| 输入 `/`、`Tab`     | 命令联想和补全                           |
| 左右、Home、End     | 移动输入光标，在中间插入或删除           |
| 上下                | 空输入时回看输入历史，候选打开时选择候选 |
| 鼠标滚轮、PgUp/PgDn | 回看对话或翻页面板                       |
| Ctrl+O              | 工具全部收起 → 最近五条 → 全部展示       |
| Ctrl+I / Ctrl+T     | 思考过程展开或收起                       |
| Ctrl+P              | 请求当前节点结束后暂停                   |
| Ctrl+C              | 运行时取消；空闲时清草稿或退出           |
| Esc                 | 关闭候选或面板                           |

传统终端可能无法区分 Ctrl+I 与 Tab；可用 `/thinking` 或 Ctrl+T。思考内容取决于提供方是否返回可展示内容。默认进入备用屏幕，退出恢复终端；`AGENT_TUI_SCREEN=regular` 可使用普通屏幕。

常用命令：

| 命令                                           | 用途                     |
| ---------------------------------------------- | ------------------------ |
| `/help`                                        | 完整命令、说明和示例     |
| `/model`、`/key <provider>`                    | 选择模型、配置密钥       |
| `/session [id]`                                | 切换或列出会话           |
| `/session delete <id>`                         | 删除会话                 |
| `/task`、`/task list`                          | 当前执行详情、目标列表   |
| `/task new <目标>`                             | 新建目标并执行           |
| `/task continue <id> [要求]`                   | 继续目标，可增加要求     |
| `/task select <id>`、`/task cancel <id>`       | 选择或取消目标           |
| `/task pause`、`/task resume`、`/task recover` | 暂停、继续、确认中断恢复 |
| `/task approve`、`/task reject`                | 回复计划确认             |
| `/workflow [id]`                               | 查看或选择工作流         |
| `/context [JSON]`                              | 查看或更新上下文策略     |
| `/permission <read-only                        | ask                      | allow>` | 调整权限模式 |
| `/tools`、`/memories`、`/stats`                | 工具、记忆和统计         |

## 配置与数据

项目数据默认写到启动目录的 `.mini-agent/`。全局配置默认在 `~/.config/mini-agent/`。

| 路径                                                | 内容                             |
| --------------------------------------------------- | -------------------------------- |
| `.env`                                              | 本机环境与 API Key，保持本地     |
| `.env.example`                                      | 可提交的配置模板，不填写真实密钥 |
| `.mini-agent/workflows.json`                        | 用户工作流配置                   |
| `.mini-agent/tools.json`                            | 已注册工具的别名和固定参数       |
| `.mini-agent/settings.json`                         | 上下文等项目设置                 |
| `.mini-agent/executions/<session>.json`             | 权威执行状态与历史               |
| `.mini-agent/sessions/`、`tasks/`                   | 兼容消息与最后一次结果缓存       |
| `.mini-agent/memories.json`、`skills/`、`mcp.json`  | 项目记忆、Skills、MCP 配置       |
| `.mini-agent/artifacts/`、`approvals/`、`journals/` | 长工具输出、授权审计与执行日志   |

例如在 TUI 中修改上下文：

```text
/context {"maxInputTokens":131072,"reservedOutputTokens":8192}
/context {"summarize":true,"compactThreshold":0.8}
/context {"applyMemory":false,"generateMemory":false}
```

配置修改要求运行空闲，后续会话继续使用所选上下文实现。API 协议和完整配置示例见 [V1.2 指南](./doc/v1.2-usage.md)。

源代码、锁文件、测试、文档和脱敏模板适合进入 Git。`.env`、`.mini-agent/`、命令日志、`node_modules/` 与构建产物保持本地；不要提交真实会话、凭据和授权记录。需要共享工作流时，可将脱敏模板放入受版本管理的自选目录，再复制到项目配置位置。

## 开发入口

```text
src/
├─ core/        领域对象、Agent 循环、工具/权限/上下文/工作流规则与接口
├─ app/         Task 生命周期、执行调度、节点执行器与调用观察
├─ protocol/    客户端命令、快照、事件与校验
├─ host/        Node 宿主、默认服务装配、配置与会话管理
├─ adapters/    模型提供方、HTTP 服务与 HTTP 客户端
├─ infra/       文件存储、工作区、配置、扩展连接和文件验收
├─ tools/       内置工具注册与实现
├─ ui/          终端输入、命令路由、布局和展示状态
├─ index.ts     嵌入式 Node 宿主入口，不启动 UI
├─ client.ts    Web/桌面客户端入口，不加载 Node 宿主
└─ tui.ts / cli.ts / server.ts  启动入口
```

宿主可以直接运行，不创建终端组件：

```ts
import { AgentRuntime } from './src/index.js';

const client = new AgentRuntime({
  dependencies: { toolsets: { command: false } },
});
try {
  await client.initialize();
  const result = await client.dispatch({ type: 'tasks.run', input: '解释什么是工作流' });
  console.log(result.status, result.summary);
} finally {
  await client.close();
}
```

新 UI 只需实现输入、消费事件并渲染快照；无需创建模型、工具或数据库。模块替换示例见 [模块开发指南](./doc/module-development.md)。

## 检查与边界

```powershell
npm run check          # TypeScript、脚本语法、模块依赖边界
npm test               # 核心、存储、协议、模块注入及终端回归
npm run format:check   # 格式检查
```

当前仍采用串行调度，一个宿主同时推进一个 Run；会话文件要求单宿主写入。暂停发生在节点边界。恢复中断节点可能重复外部动作，需要明确确认。

已有文件范围与授权策略属于应用层控制，命令执行没有操作系统沙箱。当前没有并行汇合、子工作流、分布式调度、历史检查点回放、持久事件重放或完整 RAG。模块在启动时装配，运行中不热卸载。具体后续顺序见 [技术规划](./doc/technical-roadmap.md)。
