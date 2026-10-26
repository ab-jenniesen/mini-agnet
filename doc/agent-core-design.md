# 通用 Agent 核心功能与已确认决策

更新：2026-10-25。本文整理已确认的设计；当前实施和后续安排统一见 [技术规划](./technical-roadmap.md)。

## 项目定位

Mini Agent 面向通用任务。编码、研究、文档等领域通过工作流、工具和上下文适配。UI 是客户端，负责输入和展示；核心执行与客户端协议独立。

## 已确认的设计

| 决策       | 内容                                                 | 当前实现                                    |
| ---------- | ---------------------------------------------------- | ------------------------------------------- |
| 四层归属   | Session → Task → Run → NodeRun                       | `core/execution/types.ts`                   |
| 持续目标   | Task 可以跨多轮，一次推进单独记录为 Run              | `app/tasks/runner.ts`                       |
| 自定义范围 | 配置执行阶段的节点与分支，Agent 节点内部自主调用工具 | `core/workflow/definition.ts`、`app/nodes/` |
| 外层流程   | 输入/清单准备 → 执行子图 → 验收 → 结果               | `app/execution/engine.ts`                   |
| 清单含义   | 文件名是待交付、待检查的实际文件                     | `infra/verification/files.ts`               |
| 当前验收   | 只检查交付完整性，缺失时返回执行阶段                 | `core/execution/acceptance.ts`              |
| 纯回复     | 允许以回答作为结果，文件检查标记不适用               | `response` / `not_applicable`               |
| 计划确认   | 默认自主执行，执行前确认可以开启                     | `AGENT_CONFIRM_PLAN`                        |
| 模型循环   | 没有默认 15 轮上限，直到正常完成或明确终止           | `core/agent.ts`                             |
| 多端接入   | 命令、快照和事件；UI 不判定权限或任务完成            | `protocol/`                                 |
| 模块化     | 核心模块尽量可替换，文件按职责命名和组织             | `host/dependencies.ts`、各模块 `ports.ts`   |

## 十项核心能力

模型接入、Agent 执行、通用工作流、默认与自定义工具、上下文管理、任务、权限隔离、结果验证、可观测、UI 协议。

各模块之间使用明确接口；宿主提供默认实现。文件完整性和实际命令验证各自记录，不从模型声明推断已经验证，也不把通过完整性检查描述为内容质量达标。

## 继续保留的设计边界

计划数据由 Task 保存，模型请求只带预算内的投影。计划确认不等于工具授权。工作流业务 State 属于 Run；实际执行状态、尝试、错误和调用记录通过 NodeRun 关联。

当前图执行串行，支持条件路由和循环；Human 等待由内核持久化。未来并行、子图和系统沙箱需要另行定义一致性和资源边界。

独立模型验收会话、语义质量评分、置信度校准作为后续研究保留，当前版本不执行。完整候选字段与已落地 Schema 的差别以代码和 V1.2 指南为准。

## 相关文档

- [版本规划](./technical-roadmap.md)
- [V1.2 范围与完成标准](./v1.2-design.md)
- [模块开发](./module-development.md)
- [四层对象候选字段](./runtime-object-model.md)
- [多 Task 流程](./session-multiple-tasks.md)
- [独立模型验收讨论](./verification-review.md)
