# Mini Agent v1

基于 **TypeScript、Node.js、React Ink** 的本地单智能体（Single-Agent）Coding Harness。通过统一的模型消息与工具接口，将模型调用、上下文构造、文件操作、权限审批、记忆管理和终端交互组织成可扩展的应用。Agent 运行时与界面展示解耦，当前提供交互式终端和经典命令行入口。

> **运行边界**：本项目不是操作系统沙箱。文件权限是应用层策略，不能约束所有外部程序或 MCP Server 的副作用。不要在不可信目录或含有敏感信息的环境中授予自动执行权限。

## 功能概览

| 分类 | 功能 |
| --- | --- |
| Agent Runtime | 多轮 Agent Loop、Tool Calling、工具参数校验、错误结果回传、取消请求与执行日志 |
| 模型服务 | 多供应商适配、动态模型列表、交互式选择模型、API Key 输入与保存、恢复上次模型 |
| 推理与交互 | 流式回答、供应商可用时的 Thinking 内容、工具执行状态、统计、Todo 和审批交互 |
| 文件与命令 | 列目录、分页读取、文件 SHA-256 验证、写入冲突检测、命令执行、工具输出归档与分页查看 |
| 工作区权限 | 启动目录为主工作区、只读/询问/自动写入三档、可申请额外可写目录、滚动 Diff 审批 |
| 会话与记忆 | 项目独立会话、全局/项目两级长期记忆、关键词检索、历史检索、持久化对话摘要 |
| 上下文工程 | 根据模型能力配置上下文预算、工具结果裁剪与引用、记忆召回、历史压缩 |
| 扩展配置 | 全局/项目 Skills、MCP stdio 工具、分层 Settings、项目指令 |
| 可移植性 | 当前系统环境信息注入、跨系统状态包导出/检查/导入（`.magent`） |
| 示例与测试 | 模拟模型示例、独立 LangGraph 工作流示例及自动化测试文件 |

## 环境要求

- Node.js **20 或更高版本**（建议使用近期 LTS 版本）及 npm。
- 访问对应模型服务所需的网络连接和 API Key；Ollama 等本地服务可按其部署方式使用。
- 终端需要支持基本交互与 ANSI 输出，推荐 Windows Terminal、PowerShell 7、Linux/macOS 常见终端。

跨平台路径处理面向 Windows、Linux、macOS 设计；不同系统的命令执行、MCP 服务依赖、Ink 终端行为仍需在目标系统上独立测试。

## 安装与启动

在 Mini Agent 源码根目录执行：

```bash
npm install
npm run check
npm test
npm link
```

进入需要处理的项目目录：

```bash
cd /path/to/your-project
mini-agent
```

当前目录成为**主工作区**；程序在该目录初始化 `.mini-agent/`。也可在源码目录执行 `npm run dev` 启动 Ink TUI，或执行 `npm run dev:classic` 使用经典 CLI。`npm run demo` 运行模拟模型，`npm run graph` 运行独立的 LangGraph 示例。

首次运行默认选用 DeepSeek；若当前模型没有可用凭据，终端可提示输入 API Key。模型选择可在后续启动时恢复。动态模型列表取自供应商接口，未能查询时会标明回退列表；列出的型号不保证都支持对话与工具调用。

## 常用终端命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示帮助 |
| `/model`、`/models` | 交互式选择供应商与模型 |
| `/model <provider> [model-id]` | 指定供应商及模型 |
| `/refresh-models` | 刷新当前模型列表 |
| `/key <provider>` | 设置对应厂商的 API Key |
| `/thinking on\|collapse\|off` | 控制 Thinking 面板；可用 `Ctrl+T` 切换 |
| `/permission read-only\|ask\|allow` | 更改本次运行的文件写入权限 |
| `/dirs`、`/addDir <path>` | 查看或申请额外可写目录 |
| `/memories [project\|global]` | 查看项目或全局记忆 |
| `/todos`、`/stats` | 查看任务与统计 |
| `/outputs`、`/output <id> [offset]` | 列出和分页查看归档工具输出 |
| `/reset`、`/exit` | 重置当前会话、退出终端 |

### 权限规则

- **只读（read-only）**：拒绝内置写入及可能产生副作用的命令。
- **写入前确认（ask，默认）**：展示文件 Diff，等待批准或拒绝。
- **自动写入（allow）**：允许在授权目录内直接写文件，但仍检查文件版本；`run_command` 仍需单独审批。
- **扩展目录**：通过 `/addDir` 或 Agent 工具 `request_write_directory` 申请。即使处于 `allow` 模式，也必须获得明确批准；缺失目录可在审批后创建。

已有文件更新要求与先前读取版本匹配的 `expectedSha256`。如文件已在外部发生变化，会返回冲突而非覆盖。SHA-256 校验并不能消除所有跨进程竞态；没有沙箱时，也不能通过应用层设置完全限制命令与 MCP 的副作用。

## 项目数据与配置

Mini Agent 采用**用户全局配置 + 当前主项目状态**的双层组织方式：

```text
~/.config/mini-agent/
├── credentials.json          # 用户级 API Key（本地存储，非加密保险库）
├── model-selection.json      # 上次选择的模型
├── memories.json             # 全局长期记忆
├── settings.json             # 全局设置
├── mcp.json                  # 全局 MCP 配置
└── skills/                   # 全局 Skills

<project>/.mini-agent/
├── PROJECT.md                # 当前项目的指导说明
├── settings.json             # 项目设置
├── mcp.json                  # 项目 MCP 配置
├── skills/                   # 项目 Skills
├── memories.json             # 项目长期记忆
├── sessions/                 # 项目对话历史
├── compactions/              # 持久化历史摘要
├── todos/                    # Todo 数据
├── artifacts/                # 归档工具输出
├── journals/                 # 工具执行日志
├── approvals/                # 审批记录
└── workspace-grants.json     # 额外可写目录授权
```

不同主项目的会话与项目记忆独立；各项目可以共享全局记忆。记忆写入默认归属项目，也可显式选择 `global`。全局和项目同名 Skill/MCP 配置以**项目项优先**，项目配置可关闭全局 MCP 项。扩展工作区仅作为授权访问目录，不会自动在其中生成 `.mini-agent/`。

**数据隐私**：`.mini-agent/` 可能包含对话和工具结果，建议在项目根目录 `.gitignore` 中加入 `.mini-agent/`。API Key 不进入项目目录，但本地凭据文件本身不加密。不要将密钥写入记忆、Skills 或工具日志。

## 上下文工程与工具输出

Agent 保存完整会话记录，同时按当前模型的上下文预算构造每次请求：选取相关记忆、必要的历史消息和工具结果引用，在接近预算时执行摘要或历史压缩。Token 使用量为估算值，模型提供的上下文能力元数据不一定完整，可通过环境变量覆盖相关参数。

长工具输出采用**归档 + 预览 + 按需读取**：完整收到的结果存入 `artifacts/`；模型历史携带预览与归档标识；模型可用 `read_tool_output(id, offset, limit)` 读取后续内容；TUI 可以查看归档。命令日志尽可能直接保存，避免终端预览长度等同于模型上下文长度。

历史摘要单独持久化，完整原始消息仍保留在项目会话记录中，并可通过历史检索工具查找。摘要不保证无损；文件是否最新必须由文件工具重新检查，不能仅凭旧对话确认。

## 模型、Skills 与 MCP

内置的供应商适配覆盖 DeepSeek、OpenAI、Anthropic Claude、Google Gemini、Qwen、Kimi、GLM、SiliconFlow、Groq、Ollama 和自定义 OpenAI 兼容服务。不同供应商通过统一内部消息格式接入，切换模型时保留会话，但原厂推理内部状态不保证跨模型无损迁移。

- **Skills**：从全局和项目 `skills/` 加载可复用说明；项目同名 Skill 覆盖全局项。
- **MCP**：通过配置连接受信任的 stdio MCP Server，导入的 MCP 配置不会自动获得执行信任。
- **LangGraph**：`src/examples/langgraph-demo.ts` 是独立工作流示例；主 Agent 使用自研 Agent Loop。

## 项目结构

```text
bin/mini-agent.mjs             # 全局 CLI 与迁移子命令
lib/portable.mjs               # .magent 归档、检查和导入
src/
├── core/                       # Agent Loop、模型适配、上下文、工具注册、权限
├── infra/                      # 工作区、记忆、配置、缓存、MCP、归档、日志
├── tools/                      # 文件、命令、记忆、历史、工作区工具
├── presentation/               # 独立 UI 事件、状态模型、Ink 组件
├── tui.tsx                     # Ink 终端入口
├── cli.ts                      # 经典 CLI 入口
└── examples/                   # Mock Agent 与 LangGraph 示例
tests/                          # 自动化测试
skills/                         # 示例 Skill
workspace/                      # 示例工作区文件
docs/                           # 技术参考
```

Agent 核心不直接依赖 Ink 展示组件。当前已实现终端交互，统一展示事件与 ViewModel 可供未来的 Web、桌面和移动端适配器消费；多端应用本身及跨进程通信服务并不包含在本项目中。

## 跨平台迁移

在原设备的项目目录导出项目数据（**不包含源码或 API Key**）：

```bash
mini-agent export --out ./my-project.magent
mini-agent export --global --out ./my-project-global.magent
```

在新系统安装 Mini Agent、准备好同一项目的源码后执行：

```bash
cd /path/to/your-project
mini-agent inspect /path/to/my-project.magent
mini-agent import /path/to/my-project.magent
# 包含全局数据时按需指定：
mini-agent import /path/to/my-project-global.magent --global
```

导入前会预览并要求确认；非交互脚本可显式使用 `--yes`。迁移文件使用 SHA-256 校验完整性，导入默认只创建不存在的数据文件，不覆盖已有文件。扩展目录旧授权不会直接生效，MCP 服务默认禁用，Windows 等旧系统绝对路径须重新核对。迁移包可能包含私密对话和文件输出，应妥善保管。

## 当前限制

- 不是安全沙箱；执行命令和外部 MCP 服务可能绕过应用层文件范围约束。
- Tool Calling、Thinking 和上下文窗口元数据支持程度取决于供应商与具体型号。
- Token 估算、摘要与记忆关键词匹配并不等同于精确 Token 计数、无损压缩或语义向量检索。
- 执行日志可发现未完成操作，但不能保证崩溃后自动、安全地精确恢复所有副作用。
- 项目提供跨平台代码与可迁移包，但真实 Windows/Linux/macOS 端到端兼容仍应分别验证。
- 迁移包不包含项目源文件、依赖、API Key 或操作系统权限。

## 验证

```bash
npm run check                  # TypeScript 类型检查
npm test                       # 项目测试
node --test tests/portable.test.mjs  # 迁移测试
npm run demo                   # 模拟模型演示
```

这些命令用于本地验收；项目包含相关测试，但不代表当前所有平台和模型均已完成真实环境联调。

## License

当前项目未声明开源许可证；如需公开发布，应先选择并添加合适的许可证文件。


## 安全维护说明（v1.0.1）

- 迁移包导入前验证全部待写入文件，发现非法 MCP JSON 会阻止写入；提交失败尝试回滚已创建文件。**不保证进程崩溃或并发文件竞争下的强事务原子性**。
- 导入时拒绝目标路径的符号链接，外部可写目录授权仅以待审阅文件保留，不会自动生效。
- 导出时扫描常见明文 API Key 特征；检测到疑似密钥会拒绝导出。人工确认后可使用 `mini-agent export --allow-sensitive --out backup.magent`，但建议优先删除敏感数据，扫描也不能识别全部秘密。
- 一个 MCP Server 无法连接不会阻断其他 Server；配置文件本身无效时禁用 MCP 并输出错误。
- `run_command` 返回字段 `ok` 表示是否正常以退出码 0 结束；它仍然**不具备操作系统沙箱隔离**，经授权执行的命令可能修改工作区之外的文件。
- Windows 路径根目录处理已调整；Windows/macOS 真机联调仍需进行。
