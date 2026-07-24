# 状态与门禁

## 五阶段状态模型

需求严格按以下阶段流转，每个阶段只拥有自己的交付事实：

1. `definition`：业务目标、范围、约束和验收标准。
2. `solution_design`：跨项目方案、交付单元、依赖、接口和风险。
3. `implementation`：每个交付单元的实现及实现证据，不判定质量。
4. `quality_verification`：独立 Code Review 与独立自动化测试。
5. `acceptance_delivery`：交付汇总和人工总体业务验收。

通用 `WorkflowStatus` 只描述需求级流程。实现、质量、失效和终态由 delivery-unit domain 独立记录，不能把 `applied`、`skipped` 等交付状态塞回需求状态。

## 自动化任务与恢复

- 队列任务使用持久化 lease。每次领取都会递增 attempt，并生成只属于该次 lease 的 `fencing token`；续租、完成、失败和质量证据写入都必须同时匹配 owner、有效期和 token。
- worker 按 lease 周期发送 heartbeat。服务启动和轮询执行周期恢复，将过期 lease 重新变为可领取任务；旧 worker 的晚到回调被 fencing 拒绝。
- 同一 owner、evidence version 和 action 使用稳定 dedupe key。重复 enqueue 返回同一事实，不会创建重复任务。
- Review 和测试运行使用独立 `claim generation`。同 kind 的活动不能同时拥有 claim；新 lease 不能继承旧 lease 的质量写权限。
- 暂停不会中断已经 leased/running 的任务，但会取消 pending 任务，并阻止后续 lease。运行中的结果可以安全落库，暂停期间不会释放依赖或创建下游任务。

## 证据与质量门禁

- 实现、Code Review、自动化测试分别保存不可变证据；三者不能相互覆盖或替代。
- Review 和测试必须引用当前 implementation evidence 的 ID、version 和 diff hash。旧版本、错误 owner 或错误 hash 的回调不能写入当前事实。
- 必需交付单元只有在当前版本的 Code Review 与自动化测试均通过后才能成为 `ready_for_acceptance` 并释放依赖。
- `aborted` 表示未产出业务质量结论，只能用于收敛失败的自动化尝试，不能作为通过或失败证据。
- 质量失败只允许在具备当前 implementation、对应 failed evidence、另一独立质量活动已通过等服务端资格时 `override`。override 保留原失败证据，并新增不可变的 actor、reason、accepted risk 和 evidence ownership 审计。

## 依赖、fan-in 与失效

- 下游必须等所有入边释放；`fan-in` 中每个上游变化各自保存一个失效事实，不能只保留最后一次变化。
- 新 implementation evidence 或契约失效会在同一事务中传播：已开始的后代变为 `potentially_stale`，未开始的后代回到 `waiting_dependency`，旧 release edge 和无效 pending job 被撤销。
- 连续变化聚合到当前下游 evidence version。人工必须对全部未解决来源统一选择 `reuse` 或 `rerun`，且每个来源只能由一个 immutable decision/skip fact owner 消费。
- `reuse` 保留当前 implementation evidence，重新计算质量与依赖；`rerun` 将 evidence version 加一并只创建一个新的 implementation job。

## 人工操作与终态

- `pause`、`resume`、`optional skip`、stale `reuse`/`rerun`、quality `override` 和失败任务 `retry` 都必须提供原因，并记录固定的服务端 actor 和不可变审计。
- required unit 永远不能 skip；optional unit 只有在没有 active work 时才能进入 terminal `skipped`。
- `applied` 和 `skipped` 是传播屏障。它们可以保留此前已经释放的图效果，但后续上游变化不能改写终态事实。
- `resume` 在事务内重新计算当前 gate、依赖和任务，只补建仍然有效且不存在的任务。

## 实时视图与操作权限

- API 返回 server-owned `allowedActions`；前端只负责渲染，不能根据状态字符串自行推断 retry、reuse、rerun、skip、pause 或 resume 是否安全。
- delivery detail 使用单调、持久化的 `SSE generation` 发布变化。客户端断线后带最后 generation 重连；连续失败时启动有界的轮询 fallback，恢复 SSE 后停止轮询。
- generation 只表示“需要重读详情”，业务事实仍来自同一事务快照，客户端不能把事件顺序当成放行依据。

## 人工验收与 Git 边界

总体业务验收必须由人工完成。安全、确定、可审计的节点可以自动推进，但自动化不能越过所属阶段或替代业务判断。

任何门禁都不得在目标项目自动 commit、merge、push、tag 或创建 PR。后续本地应用也只能产生未提交改动，由人工检查并决定提交、撤销或合并。

## 打回路由

| 问题 | 返回阶段 |
|---|---|
| 业务目标、范围或验收标准错误 | `definition` |
| 方案、接口、依赖或风险控制错误 | `solution_design` |
| 实现缺陷 | `implementation` |
| Review 或测试证据不足 | `quality_verification` |
| 总体业务结果不符合预期 | 由人工判定责任阶段后打回 |

## 数据状态边界

`phase-3-application-audit-v16` 是唯一 live schema marker。旧数据库先备份主文件及已有 WAL/SHM，再 fresh reset；旧历史只在 backup。系统不做 row migration、dual read/write、fallback 或跨 schema 状态兼容。
