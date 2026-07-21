# 五阶段工作流 SOP

## 角色责任

| 角色 | 责任 |
|---|---|
| 业务负责人 | 提交问题、确认目标、执行总体业务验收 |
| 产品负责人 | 审核 `definition` 的范围、规则和验收标准 |
| 方案负责人 | 审核 `solution_design` 的交付单元、依赖、接口和风险 |
| 实现 AI / 工程师 | 在 `implementation` 完成交付单元实现与自检证据 |
| Review AI / Reviewer | 在 `quality_verification` 独立检查实现，不执行测试来替代审查 |
| 测试 worker / 测试负责人 | 在 `quality_verification` 独立执行自动化测试，不用 Review 结论替代测试 |

总体业务验收必须由人工完成。安全且确定的检查可以自动化，但自动结论不能越过所属阶段或替代人工验收。

## 标准流程

1. 在 `definition` 澄清真实业务目标、目标用户、范围、非目标、约束和验收标准。
2. 人工批准定义后进入 `solution_design`，设计跨项目方案、每项目交付单元、依赖、接口、回滚和验证策略。
3. 人工批准方案。系统冻结项目快照，并为每个交付项目创建 `ready` 或 `waiting_dependency` 的交付单元。
4. 在 `implementation` 按交付单元实现并保存差异、自检和诊断证据。
5. 在 `quality_verification` 分别完成独立 Review 和自动化测试。两条活动各自记录输入、输出、失败原因和证据版本。
6. 所有必需交付单元质量通过后进入 `acceptance_delivery`，由人工执行总体业务验收。
7. Phase 3 中，验收通过后才可按依赖顺序执行 no-commit 本地应用；人工检查目标 worktree 后自行决定提交或撤销。

## 分期执行约束

### Phase 1（foundation）

- 创建、持久化、读取和展示 delivery plan、交付单元及依赖。
- `/run` 在 `implementation`、`quality_verification`、`acceptance_delivery` 只返回只读数据和待自动化标记。
- 不执行 AI、编码、Review、测试、队列 worker 或 Git job。
- 不修改任何目标项目 worktree。

### Phase 2（automation）

- 激活 delivery-unit queue 和 worker。
- 执行实现、独立 Review、自动化测试及证据过期处理。
- 不提供总体业务验收后的本地应用。

### Phase 3（acceptance and application）

- 提供总体业务验收记录。
- 以交付单元为 owner，按依赖顺序执行 no-commit local application。
- 不在目标项目自动 commit、push、tag 或创建 PR。

## 数据重建 SOP

升级到 `phase-2-quality-attempt-v14` 前停止服务。服务识别 `phase-2-terminal-resolution-v13` 或其他旧 live DB 后，先备份主文件及现有 WAL/SHM，再创建空的新库。旧 history 只保存在 backup；没有 row migration、dual read/write 或 fallback。重新登记项目、版本和需求，以新跑结果作为当前事实；用户已授权旧数据以新跑为准。

## 异常处理

- 输入缺失、证据冲突、风险不可接受或置信度不足时转 `blocked` 或打回责任阶段。
- Review 与自动化测试必须分别重跑和分别关闭问题。
- 未产出业务质量证据的终止运行记录为 `aborted`。同一 job token 的 lease 恢复只复用该终止结果并结束 job，不重跑质量；`aborted` 不得充当通过或失败 evidence。
- 人工确认 stale evidence 可复用时，系统为无终态 evidence 的质量任务创建新的 claim token；旧 `aborted` attempt 保持只读，新 attempt 独立重跑 review/test。
- 依赖未释放时，下游交付单元保持 `waiting_dependency`。
- 任何代码路径若尝试自动 commit、push、tag 或创建 PR，必须立即停止并作为安全缺陷处理。
