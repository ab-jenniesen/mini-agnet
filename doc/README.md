# Mini Agent 文档

更新：2026-10-25。当前为 V1.2.0 开发版。

## 当前开发入口

| 文档                                     | 用途                                    |
| ---------------------------------------- | --------------------------------------- |
| [项目 README](../README.md)              | 启动、功能、终端操作与数据目录          |
| [架构学习指南](../ARCHITECTURE.md)       | 文件职责、依赖关系和阅读顺序            |
| [技术规划](./technical-roadmap.md)       | 十项核心能力、当前范围与后续版本建议    |
| [模块开发](./module-development.md)      | 工厂、工具模块、节点扩展、UI 接入与限制 |
| [V1.2 设计基线](./v1.2-design.md)        | 已确认范围、兼容和完成标准              |
| [V1.2 配置指南](./v1.2-usage.md)         | 工作流、工具、上下文、任务命令和持久化  |
| [核心功能与决策](./agent-core-design.md) | 已确认的产品与架构约束                  |

## 专题设计与历史讨论

- [工作流外层结构](./workflow-structure.md)：固定生命周期与自定义执行子图。
- [节点结构讨论](./workflow-node-design.md)：定义、执行器和输入输出。
- [多任务流程](./session-multiple-tasks.md)：Session 中多个 Task 的运行示意。
- [四层对象候选模型](./runtime-object-model.md)：完整候选字段，不代表全部已经实现。
- [行动计划与上下文](./task-planning.md)：计划生成、确认、保存与注入。
- [LangGraph 参考](./langgraph-design-notes.md)：设计参考与差异，本项目未引入该框架依赖。
- [独立模型验收](./verification-review.md)：暂存的后续研究，当前验收仅做完整性。

专题保留讨论背景；当前功能和扩展接口以开发入口及实际 Schema 为准。后续版本建议不等于用户已确认的实现排期。
