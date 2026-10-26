# 四层运行对象与状态定义草案

整理日期：2026-10-23。状态：**四层架构已确认用于 V1.2；本文包含完整候选字段，尚未全部实现。当前接口以 core/execution/types.ts 与 V1.2 配置指南为准。**

实施更新：四层设计已归入 V1.2，当前开发代码已实现其串行执行基础。本文继续保留完整候选字段，实际 Schema、配置和暂未实现的高级能力见 [V1.2 实现指南](./v1.2-usage.md)。纯回复已确认允许交付回答并使用 not_applicable 报告。

本文汇总 Session → Task → Run → NodeRun 的完整候选数据模型。已有文档中的简化快照用于说明流程；正式字段名和枚举以之后逐项确认的设计为准。

## 1. 四层归属与已确认边界

```text
Session：一次持续交流的会话
└─ Task[]：用户想完成的目标，可以跨多轮交流
   └─ Run[]：为推进该目标进行的独立执行
      └─ NodeRun[]：执行工作流中的某个节点实际被进入的一次记录
         └─ attempts[]：该次节点执行的启动、重试或恢复记录（辅助对象）
```

四层表达生命周期和数据归属。计划、清单、产物、等待请求、检查点、调用记录仍然需要各自的数据结构；它们通过 ID 关联到四层对象。物理存储可以分表、分文件，API 也可以返回聚合视图。

已确认的设计边界：

- Task 表达跨多轮持续的用户目标；Run 单独记录一次执行。
- 外层生命周期由内核控制：输入与清单准备 → 自定义执行工作流 → 完整性检查 → 结果。
- 用户自定义执行阶段的节点和分支，Agent 节点内部可以自主调用模型和工具。
- 当前完整性检查只检查交付清单中的文件是否齐全，不评价内容质量。
- 执行前计划确认可开启，默认自主执行。

本文补充的具体枚举、字段、单 Task 并发限制、重试规则、检查点格式等均为建议。`?` 表示可选字段；没有 `?` 的字段是本草案中相应能力启用后的必要字段，不要求首版一次实现全部能力。

## 2. 先定义所有状态

### 2.1 四层生命周期状态

```ts
type SessionStatus = 'open' | 'closed' | 'archived';

type TaskStatus = 'ready' | 'active' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';

type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

type AttemptStatus =
  'running' | 'waiting' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

type RunPhase = 'preparing' | 'executing' | 'verifying' | 'finalizing' | 'finalized';
```

| 对象    | 状态                                     | 含义                                                              |
| ------- | ---------------------------------------- | ----------------------------------------------------------------- |
| Session | open                                     | 可以继续交流、接收任务                                            |
| Session | closed                                   | 显式关闭会话入口，可重新打开；现有 Run 如何处理由关闭命令明确指定 |
| Session | archived                                 | 只读归档；建议没有未结束的 Run 时才允许归档                       |
| Task    | ready                                    | 目标已建立，当前没有执行中的 Run，可以启动或重试                  |
| Task    | active                                   | 已有未结束的 Run，处于排队、准备、执行、检查或结果阶段            |
| Task    | waiting                                  | 当前执行需要输入、审批或其他条件，暂时不能推进                    |
| Task    | paused                                   | 用户暂停，或执行中断后等待恢复决策                                |
| Task    | completed                                | 当前目标版本的交付清单已通过完整性检查，结果已保存                |
| Task    | failed                                   | 用户或任务策略明确结束该目标，并标记失败                          |
| Task    | cancelled                                | 用户明确取消该目标                                                |
| Run     | queued                                   | 已创建，等待调度                                                  |
| Run     | running                                  | 内核运行中，具体阶段由 phase 表达                                 |
| Run     | waiting                                  | 当前没有可继续的工作，等待请求或外部条件                          |
| Run     | paused                                   | 按暂停请求停止在可恢复位置                                        |
| Run     | interrupted                              | 崩溃、失联等造成执行中断，副作用可能需要核对                      |
| Run     | completed / failed / cancelled           | 本次执行已完成 / 失败结束 / 被取消                                |
| NodeRun | pending                                  | 此次节点进入已登记，尚未启动执行器                                |
| NodeRun | running / waiting / paused / interrupted | 此次节点正在执行 / 等待 / 暂停 / 中断                             |
| NodeRun | completed / failed / cancelled           | 此次节点输出已提交 / 失败结束 / 被取消                            |

`AttemptStatus` 描述一次执行器启动的情况，没有 pending：执行器尚未启动时只创建 NodeRun。具体重启行为见第 7 节。

`waiting` 与 `paused` 可以恢复；`interrupted` 必须先检查恢复条件。`completed / failed / cancelled` 是对应 Run 或 NodeRun 的终态。

阶段与状态分别保存，例如：

```text
status = running，phase = executing：执行工作流
status = waiting，phase = executing：执行到工具审批处等待
status = running，phase = verifying：内核检查文件是否齐全
status = completed，phase = finalized：结果已经保存
```

工具调用失败、完整性不通过、Run 失败、Task 失败是四个不同的事实。一次 Run 失败后，Task 可以回到 ready 等待下一次 Run；不能直接把目标永久判为失败。

### 2.2 辅助对象状态

```ts
type ChecklistStatus = 'draft' | 'active' | 'superseded';
type PlanStatus = 'draft' | 'active' | 'completed' | 'superseded' | 'cancelled';
type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
type WaitStatus = 'pending' | 'resolved' | 'cancelled' | 'expired';
type WaitKind =
  | 'user_input'
  | 'plan_approval'
  | 'tool_approval'
  | 'dependency'
  | 'resource'
  | 'budget'
  | 'retry_backoff';

type CompletenessStatus = 'not_run' | 'checking' | 'passed' | 'incomplete' | 'error';
type FileCheckStatus = 'present' | 'missing' | 'error';

type OperationStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
type EffectStatus = 'none' | 'confirmed' | 'unknown';
type RecoveryStatus = 'not_needed' | 'pending' | 'ready' | 'blocked';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';
type ResultOutcome = 'delivery_complete' | 'failed' | 'cancelled';
```

- 清单从 draft 生效为 active；新版本生效后，旧版本为 superseded。
- 计划的状态、审批状态、每一步进度独立表达。被拒绝的草案不能生效；修改内容产生新版本，再按策略审批。
- `not_required` 表示没有开启该项审批。关闭计划审批不会取消工具权限检查。
- Wait 的 expired 只是等待请求过期，后续暂停、重问或结束由策略决定。
- 完整性检查的 passed 仅表示清单内文件齐全；incomplete 表示缺失；error 表示检查器、路径或权限异常。
- EffectStatus 表达外部副作用是否已确认，unknown 时不能默认重放。
- RecoveryStatus 表达中断恢复条件，blocked 应携带具体原因，不等同于 Task 的生命周期状态。

## 3. 基础数据与关联类型

以下为 TypeScript 风格设计稿，所有对象应当能序列化成 JSON。执行器函数、回调、进程句柄、AbortSignal、真实密钥不属于这些对象。

```ts
type Id = string;
type Timestamp = string; // ISO 8601 UTC
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface VersionRef {
  id: Id;
  version: number;
  hash?: string;
}

interface StorageRef {
  id: Id;
  mediaType?: string;
  byteLength?: number;
  hash?: string;
}

type ValueRef = { kind: 'inline'; value: Json } | { kind: 'stored'; ref: StorageRef };

interface ScopeRef {
  sessionId: Id;
  taskId?: Id;
  runId?: Id;
  nodeRunId?: Id;
  attemptId?: Id;
}

interface ExecutionError {
  code: string;
  category:
    | 'validation'
    | 'model'
    | 'tool'
    | 'permission'
    | 'workflow'
    | 'context'
    | 'storage'
    | 'timeout'
    | 'conflict'
    | 'internal';
  message: string;
  retryable: boolean;
  operationId?: Id;
  effectStatus?: EffectStatus;
  details?: JsonObject; // 脱敏后保存
  causeRef?: StorageRef;
}
```

`ScopeRef` 中有 nodeRunId 就必须能追溯到所属 Run、Task 和 Session。关联必须校验，不能将其他任务的 ID 任意拼接。

`StorageRef` 指受控存储中的对象标识；读取时仍然进行权限检查，不接受模型提供的任意路径或 URL 作为可信存储引用。

## 4. Session：会话层

```ts
interface Session {
  id: Id;
  schemaVersion: number;
  revision: number;
  title: string;
  status: SessionStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt?: Timestamp;
  archivedAt?: Timestamp;

  workspaceRef: Id;
  ownerRef?: Id;
  defaultConfigRef?: VersionRef;
  metadata?: JsonObject;

  // 关联查询视图，可按需加载，不要求存成无限增长的数组
  taskIds?: Id[];
  messageIds?: Id[];
  activity?: {
    activeTaskIds: Id[];
    activeRunIds: Id[];
  };
  metrics?: Metrics; // 从执行记录聚合的缓存
}

interface Message {
  id: Id;
  sessionId: Id;
  taskId?: Id;
  runId?: Id;
  role: 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  visibility: 'conversation' | 'trace';
  createdAt: Timestamp;
  replyToMessageId?: Id;
  respondsToWaitId?: Id;
  operationId?: Id;
  metadata?: JsonObject;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; ref: StorageRef }
  | { type: 'file'; ref: ArtifactRef }
  | { type: 'tool_result'; operationId: Id; value: ValueRef };

interface ClientView {
  clientId: Id;
  sessionId: Id;
  selectedTaskId?: Id;
  selectedRunId?: Id;
  lastEventSequence?: number;
  display?: JsonObject;
}
```

会话保存交流入口和关联关系；历史消息是否加入下一次模型请求，由上下文管理决定。

选中的 Task、工具折叠模式、滚动位置等属于 ClientView。同一 Session 可以被不同 UI 以不同方式查看。`activity` 是活动对象的查询投影，不是对并发调度能力的承诺。

终端退出或客户端断线不自动关闭 Session，也不自动取消后台 Run。关闭入口、取消一次 Run、取消整个 Task，应是不同的命令。

提示区域的通知通过 UI 事件传递，不必都存成 Message。模型调用的系统指令通过配置与上下文记录追踪。

## 5. Task：目标层

```ts
interface Task {
  id: Id;
  sessionId: Id;
  schemaVersion: number;
  revision: number;
  title: string;
  status: TaskStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt?: Timestamp;

  goal: Goal;
  previousGoalRefs?: StorageRef[];
  inputMessageIds: Id[];
  inputArtifactRefs: ArtifactRef[];

  workflowRef: VersionRef;
  checklistRef?: VersionRef;
  planRef?: VersionRef;
  configRef?: VersionRef;

  activeRunId?: Id;
  lastRunId?: Id;
  runIds?: Id[]; // 可分页查询
  artifactRefs: ArtifactRef[];
  latestCompletenessReportId?: Id;
  waitingRequestIds: Id[];

  result?: TaskResult;
  statusReason?: string;
  tags?: string[];
  metadata?: JsonObject;
}

interface Goal {
  revision: number;
  text: string;
  sourceMessageIds: Id[];
  constraints?: string[];
}

interface DeliveryChecklist {
  id: Id;
  taskId: Id;
  version: number;
  goalRevision: number;
  status: ChecklistStatus;
  items: DeliveryItem[];
  createdAt: Timestamp;
  activatedAt?: Timestamp;
  sourceMessageIds: Id[];
  generatedByOperationId?: Id;
}

interface DeliveryItem {
  id: Id;
  kind: 'file'; // 本阶段检查普通文件是否存在
  path: string; // 相对于已绑定工作区，例如 readme.md
  label?: string;
  description?: string;
}

interface Plan {
  id: Id;
  taskId: Id;
  version: number; // 内容变更产生新版本
  progressRevision: number; // 同一计划内容下的进度更新
  goalRevision: number;
  status: PlanStatus;
  steps: PlanStep[];
  approval: {
    status: ApprovalStatus;
    contentHash: string;
    waitRequestId?: Id;
    decidedAt?: Timestamp;
    decidedBy?: Id;
    comment?: string;
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface PlanStep {
  id: Id;
  title: string;
  description?: string;
  status: PlanStepStatus;
  dependsOn: Id[];
  relatedDeliveryItemIds: Id[];
  artifactRefs: ArtifactRef[];
  lastUpdatedBy?: ScopeRef;
  note?: string;
}

interface TaskResult {
  status: TerminalStatus;
  outcome: ResultOutcome;
  goalRevision: number;
  finalRunId?: Id;
  checklistRef?: VersionRef;
  completenessReportId?: Id;
  summary: string;
  artifactRefs: ArtifactRef[];
  remaining: string[];
  limitations: string[];
  error?: ExecutionError;
  finishedAt: Timestamp;
}
```

建议约束：

1. 首版每个 Task 同一时刻只有一个未结束的 Run，降低同时写状态和产物的复杂度；不同 Task 是否并发另行讨论。
2. Task 的 planRef、checklistRef 指向当前生效内容。历史版本保留，旧 Run 继续引用自己实际使用的版本。
3. Goal 改动形成新版本；如何继续旧目标或另建任务需要明确命令。运行中不能静默替换目标、清单和生效计划。
4. 清单的所有条目均为本阶段必需交付物，不预设可选项、非空、格式、测试、语义或置信度要求。空清单如何处理仍需确认，不能默认视为完成。
5. 完整性检查完成前不能产生 completed 的 TaskResult。失败或取消可以没有清单和报告；对应状态须检查结果字段是否符合条件。
6. Plan 是可选的任务辅助对象，不是要求模型每次都输出一张新计划表；计划进度也不直接决定验收结果。

## 6. Run：独立执行层

```ts
interface Run {
  id: Id;
  taskId: Id;
  sessionId: Id;
  schemaVersion: number;
  revision: number;
  status: RunStatus;
  phase: RunPhase;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  updatedAt: Timestamp;
  finishedAt?: Timestamp;

  trigger: {
    kind: 'user' | 'retry' | 'schedule' | 'api';
    messageId?: Id;
    previousRunId?: Id;
    requestId?: Id;
    idempotencyKey?: string;
  };

  bindings: {
    goalRevision: number;
    workflowRef: VersionRef;
    checklistRef?: VersionRef;
    planRef?: VersionRef;
    configRef: VersionRef;
    inputMessageIds: Id[];
    inputArtifactRefs: ArtifactRef[];
  };

  state: WorkflowState;
  scheduler: SchedulerState;
  context: ContextSummary;
  feedback?: ExecutionFeedback;
  completeness: {
    status: CompletenessStatus;
    latestReportId?: Id;
    reportIds?: Id[];
  };

  waitingRequestIds: Id[];
  latestCheckpointId?: Id;
  recovery: {
    status: RecoveryStatus;
    reason?: string;
    uncertainOperationIds: Id[];
    sourceCheckpointId?: Id;
  };

  nodeRunIds?: Id[];
  operationIds?: Id[];
  artifactRefs: ArtifactRef[];
  metrics: Metrics;
  error?: ExecutionError;
  result?: RunResult;
  metadata?: JsonObject;
}

interface WorkflowState {
  schemaRef?: VersionRef;
  revision: number;
  data: JsonObject;
  updatedAt: Timestamp;
}

interface SchedulerState {
  revision: number;
  readyNodeRunIds: Id[];
  runningNodeRunIds: Id[];
  waitingNodeRunIds: Id[];
  joins: {
    activationKey: string;
    targetNodeId: Id;
    expectedBranchKeys: string[];
    arrivedBranchKeys: string[];
  }[];
  transitionCursor?: string;
}

interface ExecutionFeedback {
  kind: 'missing_deliverables';
  reportId: Id;
  missingItemIds: Id[];
  message: string;
}

interface RunResult {
  status: TerminalStatus;
  outcome: ResultOutcome;
  exitPhase: RunPhase;
  summary: string;
  artifactRefs: ArtifactRef[];
  completenessReportId?: Id;
  remaining: string[];
  limitations: string[];
  metrics: Metrics;
  error?: ExecutionError;
  finishedAt: Timestamp;
}
```

### Run 内的几种信息如何区分

| 信息       | 示例                       | 更新者                     |
| ---------- | -------------------------- | -------------------------- |
| status     | running、waiting           | 运行时生命周期管理         |
| phase      | executing、verifying       | 外层内核                   |
| state.data | 收集的资料、草稿、产物引用 | 节点输出经映射和校验后提交 |
| scheduler  | 待启动节点、等待分支汇合   | 工作流调度器               |
| feedback   | 缺少 disign.txt            | 外层完整性检查与控制逻辑   |
| context    | 窗口使用量、压缩和记忆引用 | 上下文管理器               |
| metrics    | 模型调用次数、Token、时间  | 调用记录聚合               |

`state.data` 是本次执行工作流的共享业务数据，不允许通过输出映射覆盖 status、权限或完整性结论。NodeRun 持有本次节点看到的输入及输出证据，不能代替最新 State。

配置绑定中的 `state.materials` 是业务视图路径，对应对象中的 `run.state.data.materials`；`task.*` 也是内核提供的只读视图。正式绑定 Schema 需要明确区分业务视图和持久化记录，不能把内部对象原样暴露给执行器。

准备阶段生成并绑定清单，进入执行后固定该版本。检查不齐全时，保留报告，把 feedback 交给执行阶段，继续同一个 Run；再次进入节点生成新的 NodeRun。

暂停后恢复沿用同一 Run；已结束的 Run 保持终态，再次尝试创建新的 Run。新 Run 可以显式选择旧产物或受控状态快照作为输入，不能继承整个旧 State 而不记录来源。

内核准备清单时的模型调用、完整性检查等记录为归属 Run 的 operation，无需伪装成用户工作流节点。

## 7. NodeRun：一次节点进入

```ts
interface NodeRun {
  id: Id;
  runId: Id;
  taskId: Id;
  sessionId: Id;
  revision: number;

  nodeId: Id;
  workflowRef: VersionRef;
  executorType: string;
  activationKey: string;
  enteredFromNodeRunIds: Id[];
  status: NodeRunStatus;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  updatedAt: Timestamp;
  finishedAt?: Timestamp;

  inputStateRevision: number;
  inputs: ValueRef;
  outputs?: ValueRef;
  outputCommit?: {
    id: Id;
    expectedStateRevision: number;
    committedStateRevision: number;
    committedAt: Timestamp;
  };

  attempts: NodeAttempt[];
  currentAttemptId?: Id;
  waitingRequestIds: Id[];
  latestCheckpointId?: Id;
  operationIds?: Id[];
  artifactRefs: ArtifactRef[];
  metrics: Metrics;
  error?: ExecutionError;
  metadata?: JsonObject;
}

interface NodeAttempt {
  id: Id;
  number: number;
  trigger: 'initial' | 'retry' | 'resume' | 'recovery';
  status: AttemptStatus;
  startedAt: Timestamp;
  finishedAt?: Timestamp;
  resumeCheckpointId?: Id;
  operationIds?: Id[];
  error?: ExecutionError;
  metrics: Metrics;
}
```

身份规则：

- `nodeId = write`：静态工作流里的 write 定义。
- `NR2`：第一次进入 write。
- `NR3`：收到缺文件反馈后，再次进入 write；与 NR2 是不同 NodeRun。
- `NR2.attempts[1]`：仍是 NR2 这次逻辑进入，因为可重试错误等再次启动执行器。

建议一次执行器启动对应一个 Attempt。等待请求得到回复后，若执行器延续原调用则沿用 Attempt；若运行时从检查点重新启动执行器，则新建 resume 或 recovery Attempt。NodeRun 身份保持不变，旧 Attempt 的记录保留。

Agent 节点内部正常进行多次模型交流和工具调用，仍然可以是一个 NodeRun、一个 Attempt。每次模型或工具调用各自生成 operation，不因模型交流次数增加而创建新的 Run。

正常分支未选择的节点不必创建 NodeRun。计划步骤可以 skipped，不表示工作流每个未经过的节点都需要 skipped 运行记录。

只有输出已校验、状态更新已提交后，NodeRun 才能标记 completed。节点报告完成后不再接受旧 Attempt 的写入；需要提交版本检查，防止重试和恢复产生重复更新。

如果以后支持子工作流，可以增加 `scopeId`、`parentNodeRunId` 及对应的独立 State/调度作用域；该扩展尚未定稿，不要求现在引入第五层任务生命周期。

## 8. 等待、检查点和恢复

```ts
interface WaitRequest {
  id: Id;
  scope: ScopeRef;
  kind: WaitKind;
  status: WaitStatus;
  prompt: string;
  payload: JsonObject;
  responseSchemaRef?: VersionRef;
  checkpointId?: Id;
  createdAt: Timestamp;
  expiresAt?: Timestamp;
  resumeAt?: Timestamp;
  resolvedAt?: Timestamp;
  resolvedBy?: Id;
  response?: ValueRef;
  responseMessageId?: Id;
  resolutionReason?: string;
}

interface Checkpoint {
  id: Id;
  runId: Id;
  nodeRunId?: Id;
  schemaVersion: number;
  sequence: number;
  createdAt: Timestamp;
  reason: 'boundary' | 'waiting' | 'pause' | 'recovery';

  bindings: Run['bindings'];
  phase: RunPhase;
  state: WorkflowState;
  scheduler: SchedulerState;
  feedback?: ExecutionFeedback;
  pendingWaitRequestIds: Id[];
  nodeRecordRefs: {
    nodeRunId: Id;
    revision: number;
    ref: StorageRef;
  }[];
  nodeContinuations: {
    nodeRunId: Id;
    attemptId: Id;
    executorVersion: string;
    value: ValueRef;
  }[];
  contextRecordRefs: StorageRef[];
  operationCursor: string;
  eventSequence: number;
  manifestHash?: string;
}
```

检查点是某一逻辑提交位置的一致快照。只保存 state.data 无法知道接下来该执行哪个节点，也无法判断某次写文件或发请求是否已经完成。

检查点与 operation 记录需要配合：恢复前核对外部副作用。文件系统与外部服务通常不能和本地状态一起原子提交；即使有检查点，也不能宣称外部动作天然只执行一次。

手动暂停属于 Run/NodeRun 生命周期，不需要伪造一个审批 WaitRequest。自动重试间隔可以用 retry_backoff 等待请求，预算策略也通过 budget 等待表达。

如果以后支持并行节点，一个节点 waiting 时 Run 仍可能 running；只有不存在可推进工作、整体依赖待满足条件时，Run 才进入 waiting。

## 9. 产物与完整性报告

```ts
interface ArtifactRef {
  id: Id;
  version: number;
}

interface Artifact {
  id: Id;
  version: number;
  taskId: Id;
  source: ScopeRef;
  kind: 'file';
  path: string;
  workspaceRef: Id;
  createdAt: Timestamp;
  deliveryItemId?: Id;
  mediaType?: string;
  byteLength?: number;
  hash?: string;
  snapshotRef?: StorageRef;
  derivedFrom: ArtifactRef[];
  metadata?: JsonObject;
}

interface CompletenessReport {
  id: Id;
  taskId: Id;
  runId: Id;
  goalRevision: number;
  checklistRef: VersionRef;
  status: CompletenessStatus;
  startedAt: Timestamp;
  finishedAt?: Timestamp;
  checkerRef: VersionRef;
  workspaceRef: Id;
  items: {
    deliveryItemId: Id;
    path: string;
    status: FileCheckStatus;
    observedAt: Timestamp;
    artifactRef?: ArtifactRef;
    byteLength?: number;
    hash?: string;
    error?: ExecutionError;
  }[];
  missingItemIds: Id[];
  error?: ExecutionError;
}
```

判定规则建议：

1. 清单生效前校验路径、重名和工作区边界；本阶段只接受允许范围内的普通文件，符号链接如何处理另定。
2. 实际检查工作区文件系统，不能只看模型声称完成，或只看产物登记表里有没有一行记录。
3. 全部条目 present 才能 passed；存在 missing 则 incomplete；无法检查或类型不符等产生 error，不能当作 missing。
4. 报告中的大小、哈希用于追溯检查时看到的文件，不代表检查内容语义。它们可以按存储策略省略。
5. 检查通过后，结果引用对应清单版本和报告。报告证明的是检查时刻的状态，之后文件仍可能被外部进程修改。
6. 产物版本对应不可变登记记录；只记录工作路径无法保留旧内容。需要后续稳定引用旧版本时，应保存 snapshotRef 或可验证的不可变存储对象。

当前没有 `confidence`、模型评审分数、测试通过率等验收字段。`limitations` 可以说明本阶段仅做完整性检查。

## 10. 模型、工具、上下文与指标记录

```ts
interface RuntimeConfigSnapshot {
  id: Id;
  version: number;
  workspaceRef: Id;
  modelProfileRefs: VersionRef[];
  toolRegistryRef: VersionRef;
  permissionPolicyRef: VersionRef;
  sandboxProfileRef?: VersionRef;
  contextPolicyRef: VersionRef;
  memoryPolicyRef?: VersionRef;
  executionPolicyRef?: VersionRef;
  credentialRefs?: Id[]; // 受控凭据标识，不含 API Key
}

interface ContextSummary {
  policyRef: VersionRef;
  windowTokens: number;
  estimatedInputTokens?: number;
  reservedOutputTokens?: number;
  usageRatio?: number;
  lastRecordRef?: StorageRef;
  compressionRecordRefs: StorageRef[];
  appliedMemoryRefs: VersionRef[];
  generatedMemoryRefs: VersionRef[];
}

interface ModelUsage {
  source: 'provider' | 'estimated' | 'unknown';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number; // 若提供方返回；通常是输出 Token 的子集
  cachedInputTokens?: number; // 输入 Token 的子集
}

interface Metrics {
  modelCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  unknownUsageCalls: number;
  estimatedUsageCalls: number;
  elapsedMs: number; // 从启动到当前或结束的墙钟时间，包含等待
  activeMs: number; // 排除等待和暂停区间的活动墙钟时间
  modelMs: number; // 模型调用累计时间，可能有并行重叠
  toolMs: number; // 工具调用累计时间，可能有并行重叠
  retryCount: number;
  cost?: {
    knownAmount: number;
    currency: string;
    partial: boolean;
    estimated: boolean;
    pricingRefs: VersionRef[];
  };
}

interface ExecutionOperation {
  id: Id;
  scope: ScopeRef;
  parentOperationId?: Id;
  kind: 'model' | 'tool' | 'completeness_check' | 'context_compression';
  status: OperationStatus;
  startedAt: Timestamp;
  finishedAt?: Timestamp;
  inputRef?: ValueRef;
  outputRef?: ValueRef;
  targetRef?: VersionRef;
  externalRequestId?: string;
  idempotencyKey?: string;
  effectStatus: EffectStatus;
  permissionDecisionRef?: StorageRef;
  contextRecordRef?: StorageRef;
  usage?: ModelUsage;
  error?: ExecutionError;
  metadata?: JsonObject;
}
```

上下文策略引用保存窗口大小、压缩开关与触发阈值、超限行为、记忆生成与应用等配置。本项目此前设置的 128k 可作为默认配置值；对象模型不将它写死。每次模型调用使用的上下文选择、压缩和记忆引用应记录在 contextRecord 中，summary 只是最近摘要。

调用记录为指标的统计来源。Run 汇总自己的 operation，包含内核调用和节点调用；Task/Session 再按 Run 汇总。不能把已经包含子调用的 NodeRun 汇总再次加到 Run，避免重复计算。

没有拿到 usage 的请求应标记 unknown，不能作为真实的零消耗；缓存和思考 Token 不额外重复加入总数。并行调用耗时之和不等于墙钟耗时，elapsedMs、activeMs 和各类调用累计耗时分别解释。

预算或重试策略可配置；不因本结构重新增加固定的默认模型交流轮数上限。权限策略与沙箱配置是不同能力，登记一个策略引用并不等于已实现系统级隔离。

## 11. UI 事件与聚合视图

```ts
interface RuntimeEvent {
  protocolVersion: number;
  eventId: Id;
  sequence: number; // 建议在 Session 事件流内单调递增
  emittedAt: Timestamp;
  scope: ScopeRef;
  type: string;
  entityRevision?: number;
  correlationId?: Id;
  causationId?: Id;
  payload: JsonObject;
}

interface RuntimeSnapshot {
  schemaVersion: number;
  lastEventSequence: number;
  session: Session;
  tasks: Task[];
  runs: Run[];
  nodeRuns: NodeRun[];
  messages: Message[];
  waitingRequests: WaitRequest[];
  clientView?: ClientView;
  // 清单、计划、报告、产物等按引用分页加载，或按需包含
}
```

建议事件类别：

```text
session.updated
task.created / task.updated / task.finished
run.created / run.updated / run.finished
node.started / node.updated / node.finished
message.created / message.delta / message.completed
operation.started / operation.updated / operation.finished
wait.created / wait.resolved
checklist.updated / plan.updated / artifact.created
completeness.started / completeness.finished
context.updated / metrics.updated
notice / error
```

此处 type 为候选目录，正式协议应使用有类型的联合定义每种 payload，不能直接把内部任意对象全量推给客户端。

通知事件可以带 `slot`、`replaceKey`、`level`、`text`、`expiresAt`，支持固定区域覆盖提示；工具调用事件支持折叠展示；用 taskId/runId 组织对话框与每轮指标。具体样式属于客户端。

快照带事件游标，客户端拿到快照后从该游标继续订阅；重复事件按 eventId/sequence 去重，发现缺口或游标过期则重新获取快照。流式内容先作为增量事件，最终形成完整记录。

## 12. 静态工作流定义不属于四层运行记录

```ts
interface WorkflowDefinition {
  id: Id;
  version: number;
  name: string;
  stateSchemaRef?: VersionRef;
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  entryNodeIds: Id[];
}

interface NodeDefinition {
  id: Id;
  type: string;
  name?: string;
  inputs: Record<string, InputBinding>;
  config: JsonObject;
  outputs: Record<string, { to: string }>;
  retryPolicyRef?: VersionRef;
  timeoutMs?: number;
}

type InputBinding = { from: string; optional?: boolean; default?: Json } | { value: Json };

interface EdgeDefinition {
  id: Id;
  from: Id;
  to: Id | '$end';
  condition?: {
    ruleRef: VersionRef;
    inputs: Record<string, InputBinding>;
  };
  branchKey?: string;
}
```

入口、条件边、多分支与汇合语义需在工作流专题继续细化。定义中不保存 running、Token 或实际输入输出；执行数据属于 NodeRun。`$end` 只结束执行子工作流，随后仍由内核进行完整性检查。

静态条件配置由已注册规则解释，不直接执行配置文件里的任意 JavaScript。工具与模型实现由宿主注册和注入。

## 13. 状态变化规则与例子

### 正常执行和自动补交

```text
Task.ready
  → Task.active
  → Run.running / preparing：绑定目标、生成生效清单
  → Run.running / executing：执行节点，提交 State
  → Run.running / verifying：检查实际文件
      ├─ incomplete：记录报告和 feedback → executing，同一 Run
      ├─ error：根据原因等待或失败，不当作文件缺失
      └─ passed：finalizing → 保存结果 → finalized
  → Run.completed + Task.completed
```

### 等待、暂停和异常

| 情况                        | 建议处理                                                                          |
| --------------------------- | --------------------------------------------------------------------------------- |
| 等待工具授权或补充需求      | 建 WaitRequest；阻塞推进时 Run/Task 进入 waiting，回复关联 waitId                 |
| 用户手动暂停                | 在可恢复边界保存检查点，进入 paused；恢复同一 Run                                 |
| 进程崩溃                    | 启动核对后标记 interrupted，Task 显示 paused 与恢复原因；未确认副作用时不自动重放 |
| 节点可重试错误              | 同一 NodeRun 新增 retry Attempt，不新建 Task 或 Run                               |
| 内核反馈缺少文件后再进节点  | 同一 Run 创建新 NodeRun，不计作技术重试                                           |
| 本次 Run 失败，目标继续保留 | Run.failed；Task.ready 并记录原因，后续新建 Run                                   |
| 仅取消本次执行              | Run.cancelled；Task 可回到 ready                                                  |
| 用户取消整个目标            | 取消当前 Run，Task.cancelled；保存已有产物和取消结果                              |
| 用户明确放弃失败目标        | Task.failed；保留每次 Run 的记录                                                  |

### 数据一致性要求

1. 生命周期由内核/调度服务更新，普通节点输出不能直接修改 Task 或 Run 状态。
2. 业务状态、NodeRun 输出提交、调度变更及对应事件需要一致的逻辑提交位置；大对象可以先写入，再在事务中登记引用。
3. 外部副作用单独追踪，依赖幂等键、执行日志与恢复核对；本地事务不覆盖外部系统。
4. completed 结果必须引用对应目标版本、生效清单和 passed 报告；这些版本不匹配时不能完成当前 Task。
5. status/result、activeRunId、活动列表等投影需要一致校验，API 不接受任意状态与字段组合。类型草案后续应转为可校验的条件 Schema。
6. 相同工作区的多个任务即使业务 State 独立，文件仍可能互相影响；并发写入、锁和工作区隔离策略需要单独设计。
7. 身份、权限、凭据授权在宿主入口校验；知道某个 ID 或拿到某个引用不自动获得访问权。

## 14. 第一版可以先实现的字段

完整候选结构不要求一次落地。建议第一版先覆盖：

- Session：身份、生命周期、时间、工作区、消息与任务关联。
- Task：目标与版本、状态、当前清单、Run 关联、产物和最终结果。
- Run：绑定的配置版本、状态与阶段、业务 State、基本调度状态、等待、报告与执行指标。
- NodeRun：节点身份、状态、输入输出、输出提交版本、调用记录与错误。
- 辅助能力：清单、实际文件检查报告、产物登记、基础等待请求、模型/工具调用记录和有类型事件。

计划审批、多种检查点恢复、并行汇合、子工作流、成本统计和高级记忆记录可以分阶段补齐；已有字段预留关联方式。正式实现前，仍需逐项确认状态转换、恢复保证、空清单行为和自定义工作流配置规范。
