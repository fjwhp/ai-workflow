# AI Development Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一套可直接试运行的 AI 主执行、人工审批研发工作流文档。

**Architecture:** 使用 Markdown 分离主流程、状态机、AI 提示词、人工清单和阶段表单。各文档通过统一的需求 ID、版本、阶段运行 ID 和证据引用形成追溯链。

**Tech Stack:** Markdown、Mermaid、任意支持表单和状态流转的协作平台。

---

### Task 1: 固化设计和入口

- [x] 创建设计规格，记录目标、边界和成功标准。
- [x] 创建 README，说明文档使用顺序和核心原则。

### Task 2: 编写流程和状态机

- [x] 编写端到端 SOP、角色责任、异常与变更处理规则。
- [x] 定义统一状态、阶段门禁、严重度、置信度及打回路由。

### Task 3: 编写执行资产

- [x] 编写产品、研发、编码、Review 和测试 AI 提示词。
- [x] 编写各关键门禁的人工审批清单。
- [x] 编写需求、评审、设计、自测、Review、测试、验收、打回和变更表单。

### Task 4: 验证

- [x] 检查 Markdown 链接和 Mermaid 代码块。
- [x] 检查未完成标记、状态名称、角色名称和必备模板覆盖。
- [x] 根据验证结果修正文档并记录结果。

验证结果：全部交付文档存在且非空；README 内部链接有效；Markdown 围栏配对；核心追溯 ID 与所有阶段模板覆盖完整；无未完成标记。
