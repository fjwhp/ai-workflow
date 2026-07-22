# 五阶段工作流 SOP

## 角色责任

| 角色 | 唯一责任 |
|---|---|
| 业务负责人 | 提交问题、确认目标、执行总体业务验收 |
| 产品负责人 | 审核 `definition` 的范围、规则和验收标准 |
| 方案负责人 | 审核 `solution_design` 的交付单元、依赖、接口和风险 |
| 实现 AI / 工程师 | 生成 implementation evidence，不判定质量 |
| Review AI / Reviewer | 独立审查实现，不用测试替代 Review |
| 测试 worker / 测试负责人 | 独立执行冻结的测试计划，不用 Review 替代测试 |

总体业务验收必须由人工完成。职责之间不得共享结论来跳过另一个节点。

## 标准流程

1. 在 `definition` 澄清业务目标、目标用户、范围、非目标、约束和验收标准，由人工批准。
2. 在 `solution_design` 冻结项目与版本关联，定义每个交付单元、依赖、接口契约、回滚和验证策略，由人工批准。
3. 系统创建 delivery plan。无上游依赖的 root unit 为 `ready`，其余为 `waiting_dependency`，并以 dedupe key 创建 root implementation job。
4. worker 使用持久化 lease 和每 lease fencing token 执行实现；成功后保存不可变 implementation evidence，并分别创建 Review 与测试任务。
5. Review 与自动化测试各自领取 claim generation，分别保存不可变证据。只有当前 evidence version 的 Review 与自动化测试均通过，系统才释放下游依赖。
6. 上游实现或契约变化时，系统聚合 fan-in 失效并暂停受影响后代。人工选择 reuse 或 rerun 后，系统重新计算 gate 和任务。
7. 所有必需交付单元达到 `ready_for_acceptance` 后进入 `acceptance_delivery`。人工完成总体业务验收；后续按依赖顺序执行 no-commit local application。

## Worker 运行与恢复

- 生产式本地运行需要显式设置 `AUTOMATION_WORKER_ENABLED=true`；默认关闭可用于只观察数据或浏览 pilot。
- worker heartbeat 必须在 lease 到期前续租。续租失败立即 abort handler，旧 token 不能落证据。
- 服务启动时恢复过期 automation job、遗留 implementation run 和中断的需求级 run；运行中还会周期恢复过期 lease。
- 同一 dedupe key 或 claim generation 的重复请求必须收敛为一个任务/事实。禁止通过增加 worker 数量绕过 claim owner。
- 关闭服务时先停止轮询、abort active handler，并在有界时间内等待 settlement；超时保持 lease 供下次恢复。

## 质量与放行

- Review 和测试只读冻结的 implementation evidence tree 与 toolchain identity，分别记录输入 hash、输出、命令结果、验收追踪和终态。
- 两条质量活动独立执行、独立失败、独立 retry。任一 evidence 缺失、failed、aborted 或 stale 都不得 release。
- final callback、release edge 和下游 enqueue 位于一个权威事务内；并发 callback 最多生成一条 release 和一个下游 job。
- failed evidence 的 override 是人工风险接受，不是改写 evidence；服务端校验资格并保存 actor、reason、accepted risk。

## 失效、暂停与人工恢复

- implementation/contract 变化撤销非终态后代的旧 release，取消未开始任务，已开始后代标记 `potentially_stale`。
- fan-in 的全部 active invalidation 必须由同一次 reuse、rerun 或 optional skip 决定覆盖，不能留下无人拥有的来源事实。
- `pause` 取消 pending job 并阻止新 lease；leased/running 可以完成，但暂停期间不释放依赖。`resume` 重算 gate、dependency 和 current jobs。
- optional unit 在无 active work 时可 `optional skip`；required unit 在 API 和数据库层都拒绝 skip。
- failed job 的 `retry` 只重建服务端确认仍有效的当前 action。terminal `applied`/`skipped` 不提供恢复动作。
- 所有 pause/resume/reuse/rerun/override/skip/retry 都需要原因；HTTP actor 固定为 `local-human`，不能接受客户端伪造。

## UI 与实时更新

- 详情 API 是操作资格的唯一权威，前端只能展示 server-owned `allowedActions`。
- SSE 发送单调 `generation`，不在事件中复制业务详情。客户端收到新 generation 后重读 detail。
- SSE 重连保留最后 generation；连续失败进入定时轮询 fallback，SSE 恢复后清除 fallback timer，避免重复请求和 open handle。

## 本地 pilot

pilot 数据必须写入尚不存在的专用目录，命令拒绝覆盖任何已有路径，也不会向生产 UI 注入静态数据。生成过程在同级 owned `sibling staging` 完成并 fsync 后，通过 macOS `RENAME_EXCL` 或 Linux `RENAME_NOREPLACE` 原子 no-replace 发布；并发路径冲突保留原 owner，能力缺失返回 `PILOT_ATOMIC_PUBLISH_UNAVAILABLE`，失败只清 staging。CLI 用 `FLOWGATE_PILOT_ERROR` 返回稳定错误码：

```bash
PILOT_DATA_DIR="$PWD/.local/delivery-pilot" npm run pilot:seed -w server
DATA_DIR="$PWD/.local/delivery-pilot" AUTOMATION_WORKER_ENABLED=false npm run dev
```

生成的 `REQ-0001` 包含 backend 与 frontend 两个 delivery unit、已释放依赖、独立 Review/测试 evidence、frontend stale、需求 paused，以及 API 计算的 resume `allowedActions`。需要重建时停止服务并删除整个专用 pilot 目录，再重新执行 seed；不要指向正常 `DATA_DIR`。

## 数据重建 SOP

升级到 `phase-3-application-sequence-v15` 前停止服务。旧 live DB 先备份主文件及现有 WAL/SHM，再创建空的新库。旧 history 只保存在 backup；没有 row migration、dual read/write 或 schema fallback。

## 安全边界

系统不得在目标项目自动 commit、merge、push、tag 或创建 PR。总体业务验收必须人工签署；本地 application 只能留下未提交改动，由人工检查后决定后续 Git 操作。
