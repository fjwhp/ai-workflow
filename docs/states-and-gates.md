# 状态与门禁

## 五阶段状态模型

需求的阶段严格按以下顺序流转，任一时刻只属于一个阶段：

1. `definition`：拥有业务定义，不拥有技术方案或代码执行。
2. `solution_design`：拥有方案、交付单元规划和依赖，不执行实现。
3. `implementation`：拥有每个交付单元的实现与实现证据，不判定质量结论。
4. `quality_verification`：拥有独立 Review 与独立自动化测试，两者分别产出证据和结论。
5. `acceptance_delivery`：拥有成果汇总和总体业务验收状态，不承担实现、Review 或测试执行。

通用 WorkflowStatus 只有：`ai_ready`、`ai_running`、`awaiting_approval`、`returned`、`blocked`、`completed`、`closed`、`cancelled`。未来交付应用状态属于独立 delivery-unit domain，不得塞入 WorkflowStatus。

## 门禁原则

- `definition` 必须由人工确认业务目标和验收标准。
- `solution_design` 必须由人工批准；批准操作冻结项目关联并创建 delivery plan。
- `implementation` 的实现证据是质量阶段的输入，不是质量放行结论。
- `quality_verification` 必须分别满足独立 Review 和自动化测试。任一缺失、失败或证据过期都不得进入验收。
- `acceptance_delivery` 的总体业务验收必须由人工完成。安全节点可以自动化，但不能替代人工业务判断。

任何门禁都不得在目标项目自动 commit、push、tag 或创建 PR。

## Phase 1 状态

Phase 1 foundation 在方案批准时为每个交付项目创建一个交付单元：

- `ready`：没有未释放的上游依赖。
- `waiting_dependency`：等待上游交付单元释放依赖。

Phase 1 只创建、持久化和展示这两个初始状态。后三个阶段调用 `/run` 时返回需求、交付单元、依赖及 `automationPending: true`，不创建 stage run、execution、AI 调用或 Git job。

Phase 2 才能推进实现、独立 Review 和自动化测试相关状态。Phase 3 才能推进总体验收后的 dependency-ordered no-commit 本地应用状态。

## 打回路由

| 问题 | 返回阶段 |
|---|---|
| 业务目标、范围或验收标准错误 | `definition` |
| 方案、接口、依赖或风险控制错误 | `solution_design` |
| 实现缺陷 | `implementation` |
| Review 或测试证据不足 | `quality_verification` |
| 总体业务结果不符合预期 | 由人工判定责任阶段后打回 |

每次打回必须记录问题、证据、影响和目标阶段，不允许用状态名表达历史应用结果。

## 数据状态边界

`phase-2-delivery-quality-v6` 是唯一 live schema marker。`phase-2-delivery-execution-v5` 或其他旧数据库先备份后 fresh reset；旧历史只在 backup。系统不做 row migration、dual read/write、fallback 或跨 schema 状态兼容。用户已授权旧数据以新跑为准。
