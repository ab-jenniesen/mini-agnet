# 模块替换与客户端开发

对应 V1.2.0。默认装配入口是 `src/host/dependencies.ts`，核心执行依赖接口定义在各模块的 `ports.ts` 与 `src/app/ports.ts`。

这里的“即插即用”指实现约定接口、在启动时注入。省略配置时使用默认实现，已运行的宿主不会自动加载新代码或安装插件包。

## 1. 选对入口

| 使用场景                                  | 入口                    |
| ----------------------------------------- | ----------------------- |
| 嵌入 Node 服务、Electron 主进程、本地宿主 | `src/index.ts`          |
| 浏览器、远程桌面客户端                    | `src/client.ts`         |
| 只需要客户端类型                          | `src/protocol/index.ts` |
| 开发本项目的 TUI                          | `src/ui/`               |

这些是当前源码入口，项目尚未发布独立 SDK 包。`index.ts` 不导入 TUI、不自动启动、不自动加载 `.env`；可执行入口自行导入 `dotenv/config`。嵌入宿主应自行传入配置或设置环境变量。

## 2. 能替换哪些模块

所有注入项放在 `new AgentRuntime({ dependencies: { ... } })` 中。

| 注入项                              | 契约与用途                                                     |
| ----------------------------------- | -------------------------------------------------------------- |
| `createModel(selection, key)`       | 返回 Model；用于初始模型、模型切换和密钥更新                   |
| `resolveCapability(selection, key)` | 返回上下文窗口与输出预留                                       |
| `createAgent(input)`                | 返回 AgentLoopPort，替换 Agent 节点内部自主循环                |
| `createSystemPrompt(input)`         | 从默认提示构造应用级系统指令                                   |
| `createContext(input)`              | 返回 ContextPolicyPort，替换预算/压缩/召回策略                 |
| `createMemory(input)`               | 返回 MemoryPort，供上下文与记忆工具共同使用                    |
| `createPermissions(input)`          | 返回 PermissionPort，接收审计端口和审批回调                    |
| `createWorkflows(input)`            | 返回已加载的 WorkflowCatalogPort                               |
| `createPersistence(input)`          | 返回 TaskPersistencePort，保存执行清单及兼容结果               |
| `createDelivery(input)`             | 返回 DeliveryPort，规范化交付路径并观察完整性                  |
| `nodeExecutors`                     | 名称 → NodeExecutor；可新增名称或显式替换默认 agent/model/tool |
| `tools`                             | 注册独立 RegisteredTool                                        |
| `toolsets`                          | 关闭不需要的默认工具组                                         |
| `modules`                           | 安装带资源生命周期的宿主扩展                                   |
| `observers`                         | 接收 RuntimeEvent；每个观察器收到独立副本                      |

`createContext` 不只在启动调用，也用于切换会话与 `context.configure`。自定义工厂必须正确使用传入的 options，并实现 capability 更新，避免修改配置后失效。

`AgentLoopPort` 应维护规范 history 和 metrics，响应取消信号，使用传入的消息/进度回调，正确处理 `setModel`、`setContext`、`setJournal`。替换模型协议通常只需实现 Model，无需替换循环。

任务存储的 `save` 必须在持久化成功后返回**确实提交的修订快照**，不能先返回成功再后台写入。Node 宿主的会话列表、密钥和项目设置目前仍使用本地实现；仅替换 TaskPersistencePort 不会改变所有元数据的存放位置。

## 3. 替换上下文策略

以下示例保留默认算法，只调整创建方式。实际扩展可以返回任何符合 ContextPolicyPort 的对象：

```ts
import { AgentRuntime, ContextManager } from '../src/index.js';

const runtime = new AgentRuntime({
  dependencies: {
    createContext({ options, memory, compactions }) {
      return new ContextManager(options, memory, compactions);
    },
    toolsets: { command: false, mcp: false },
  },
});
```

可选工具组有 `workspace`、`files`、`command`、`memory`、`todos`、`history`、`artifacts`、`mcp`、`configured`。关闭的是工具注册；例如关闭 memory 工具组不自动关闭上下文召回，召回仍由 `applyMemory` 控制。

工具组只表示默认能力组合，不是权限沙箱。宿主自行注册的工具仍能执行其代码，模型可见范围和授权应单独配置。

## 4. 增加带生命周期的工具模块

```ts
import { z } from 'zod';
import type { RuntimeModule } from '../src/index.js';

export const calculator: RuntimeModule = {
  id: 'calculator',
  setup({ registerTool }) {
    registerTool({
      name: 'add_numbers',
      description: '计算两个数字之和',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
      validator: z.object({ a: z.number(), b: z.number() }).strict(),
      execute: async ({ a, b }) => Number(a) + Number(b),
    });

    return async () => {
      // 如果安装时打开了连接，在这里释放。
    };
  },
};
```

宿主通过 `dependencies: { modules: [calculator] }` 安装。setup 可以异步，返回清理函数；关闭时逆序清理。setup 在返回清理函数前自身抛错时，需要自己清理尚未交给宿主管理的资源。工厂创建的外部连接也应通过模块清理函数或宿主调用方明确管理。

工具应声明参数校验、写入属性和实际执行证据。别名工具继续调用目标工具的校验和授权。配置不能覆盖 `submit_delivery_checklist`、`task_plan_update` 等保留名称。

## 5. 自定义节点执行器

内置执行器名字为 `agent`、`model`、`tool`。Human 节点使用内核持久等待，不允许注册名为 human 的执行器。

```ts
import { AgentRuntime, executeAgentNode, type NodeExecutor } from '../src/index.js';

const observedAgent: NodeExecutor = async (context) => {
  context.signal.throwIfAborted();
  const result = await executeAgentNode(context);
  return {
    ...result,
    outputs: { ...result.outputs, processed: true },
  };
};

const runtime = new AgentRuntime({
  dependencies: { nodeExecutors: { observed_agent: observedAgent } },
});
```

工作流节点通过名称选择：

```json
{
  "id": "write",
  "type": "agent",
  "config": {
    "executor": "observed_agent",
    "instructions": "完成用户要求的交付",
    "toolRefs": ["read_file", "write_file"]
  },
  "inputs": {},
  "outputs": {
    "text": { "to": "state.answer" },
    "processed": { "to": "state.processed" }
  }
}
```

配置注册或任务创建时会检查执行器是否存在。它不会加载名字对应的文件。

NodeExecutionContext 包含输入/定义副本、signal 和 `runAgent()`、`runModel()`、`runTool()`。动作只适用于对应节点类型，继续使用统一权限、取消、消息和调用记录。插件不能通过上下文对象直接修改 Task/Run；输出必须是 JSON 数据，通过声明的映射提交到 State。

对于不调用模型而直接返回文本的 Agent/Model 执行器，内核会补发一条助手消息；已有对应助手消息时不会重复展示。工具节点继续展示工具调用和结果。

新增名称不会改变节点的基础类别。并行调度、子工作流或一种全新的持久等待语义，需要先扩展内核协议，不能只靠执行器名称模拟。

## 6. 验收器与存储

DeliveryPort 的 normalizePaths 校验实际交付目标，check 返回每项观察和关联身份。当前文件实现拒绝越界、私有状态路径和符号链接；替换实现应承担相同资源边界，或提供明确的新资源协议。

内核会校验报告属于当前任务、Run 和清单版本，文件项必须完整且不重复；纯回复只接受 not_applicable。报告声称 passed 但存在 missing 项时，仍按 incomplete 处理。插件观察的真实性仍取决于受信任实现。

存储默认使用 FileTaskPersistence。业务代码只依赖 open/load/save/reset 与兼容结果/历史操作；替换时需要遵守修订、原子提交和错误语义。单纯实现一个 Map 适合测试，不提供崩溃恢复保证。

## 7. 接入自定义 UI

```ts
import { HttpAgentClient } from '../src/client.js';

const client = new HttpAgentClient('http://127.0.0.1:3000', '当前宿主令牌');
const unsubscribe = client.subscribe((event) => {
  // 把结构化事件交给自己的状态管理与组件。
  console.log(event.type);
});

try {
  const initial = await client.initialize();
  console.log(initial);
  const result = await client.dispatch({ type: 'tasks.run', input: '解释一个概念' });
  console.log(result);
} finally {
  unsubscribe();
  await client.close();
}
```

浏览器跨源接入时，在服务端配置 `AGENT_CLIENT_ORIGIN`。访问令牌使用 Authorization Bearer。此示例中的 console 只是事件消费占位，实际界面负责自己的渲染。

必须处理的交互包括：普通消息、流式文本、审批请求与回复、持久等待、错误、状态快照、取消和恢复。审批回复使用 request ID，等待回复使用 wait ID。返回 waiting/paused 并不表示目标完成。

HTTP 客户端 close 只断开连接；TUI 拥有本地宿主，退出时会关闭宿主并取消执行。客户端应通过快照重建状态，不能假设错过的流式事件会补发。

## 8. 验证扩展

运行 `npm run check`、`npm test` 和 `npm run format:check`。优先检查实际行为：工厂在会话切换后仍生效、审批无法绕过、取消能传递、失败不报成功、持久化完成再推进、模块只清理一次。

参考 `tests/modules.test.ts`；它通过离线模型验证扩展仍经过内核清单和验收。真实外部服务的权限、超时和恢复需针对具体实现验证。
