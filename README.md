# AI 主执行研发工作流

这是一套面向 5-15 人产品研发团队的工作流规范。AI 执行需求分析、研发评审、技术设计、编码、自测、代码审查和自动化测试，人工在关键门禁审核 AI 的成果、证据与风险。

仓库现已包含本地 Web 应用。开发与启动方法见 [`docs/getting-started.md`](docs/getting-started.md)。

## 多项目第一阶段

`multi-project-v1` 首次启动会为旧 SQLite 主文件及现有 WAL/SHM 伴随文件创建同一时间戳的完整备份集，然后建立空数据库。旧项目和需求不会迁移；启动后需重新登记项目、等待项目知识库重建，再创建需求。具体备份格式、恢复步骤和上下文预算配置见 [`docs/getting-started.md`](docs/getting-started.md)。

登记或重建知识库只读取本地 Git 仓库，不会修改源码、创建提交或分支，也不会推送。第一阶段可为需求配置多个上下文项目，但真实编码和后续集成必须恰好只有一个交付项目；两个或更多交付项目会在编码前停止并提示等待第二阶段。

## 使用顺序

1. 阅读 [`docs/workflow-sop.md`](docs/workflow-sop.md)，确定角色和流程实例负责人。
2. 按 [`docs/states-and-gates.md`](docs/states-and-gates.md) 创建阶段、状态和门禁。
3. 从 [`docs/forms.md`](docs/forms.md) 复制对应阶段表单。
4. 使用 [`docs/ai-prompts.md`](docs/ai-prompts.md) 中的提示词驱动各 AI 角色。
5. 人工审批人使用 [`docs/human-review-checklists.md`](docs/human-review-checklists.md) 审核 AI 成果。
6. 按 [`docs/pilot-runbook.md`](docs/pilot-runbook.md) 选择一个低风险真实需求完成试运行，再发布团队 SOP 1.0。

## 核心原则

- AI 主执行，人工负最终责任。
- 每个 AI 结论必须有引用依据、证据、风险和置信度。
- 编码 AI 与 Review AI 使用隔离上下文。
- 输入缺失、材料冲突、高风险或低置信度时停止流转。
- 所有变更、打回、代码和测试结果均可追溯到需求版本。
