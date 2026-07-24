# 首次试运行手册

## 目的

用一个真实、低风险、可在一个迭代内完成的需求验证 SOP 是否可执行。首次演练关注流程质量，不以 AI 自动化程度或交付速度作为唯一成功标准。

## 准备

1. 选择不涉及重大数据迁移、安全合规或核心交易链路的需求。
2. 指定运营、产品负责人、研发负责人、人工 Reviewer 和测试负责人。
3. 分配 `REQ-ID`，确定材料存储位置和统一版本规则。
4. 为产品 AI、研发 AI、Review AI 和测试 AI 建立独立会话；编码与 Review 不共享会话摘要或隐藏推理。
5. 将每个阶段的人工审批时限默认设为一个工作日。

## 执行

1. 运营填写需求申请单。
2. 产品 AI 使用对应提示词生成 PRD，产品负责人按清单审批。
3. 研发 AI 分别完成需求评审和技术设计，研发负责人逐门禁审批。
4. 研发 AI 编码并提交自测证据。
5. 独立 Review AI 审查，人工 Reviewer 审批结论。
6. 测试 AI 建立 AC-ID 到 TC-ID 的覆盖矩阵并执行测试，测试负责人决定是否放行。
7. 运营逐条验收 AC-ID，签署验收单并关闭需求。

## 演练记录指标

| 指标 | 记录方法 |
|---|---|
| 阶段耗时 | 记录进入和离开每个状态的时间 |
| 人工审批耗时 | 从 AI 提交到人工决定的时间 |
| AI 一次通过率 | 首次提交即获批准的门禁数 / 总门禁数 |
| 打回准确率 | 打回后确认责任阶段正确的次数 / 总打回次数 |
| 需求测试覆盖率 | 已关联且执行 TC-ID 的 AC-ID / 全部 AC-ID |
| 缺陷逃逸 | 后续阶段发现但本应由前序阶段识别的问题数 |
| 人工推翻率 | 人工决定与 AI 建议不同的次数 / 总审批次数 |

## 复盘与发布 SOP 1.0

试运行完成后，由五名人工责任人共同复盘：删除无价值字段，补充反复缺失的信息，修正错误打回路由，并确认人工审批能否根据现有证据可靠决策。所有修改形成版本记录；责任人一致批准后，将该版本标记为团队 SOP 1.0。

## Phase 3 双项目真实 pilot（2026-07-23）

### prior-marker reset 演练清单

1. 升级前停止服务，记录旧 marker，并确认 SQLite 主库及当时存在的 `-wal`、`-shm`。
2. 首次启动后确认生成同一 backup base 的完整文件集；碰撞时 base 应带 `-1`、`-2`，旧备份不得被覆盖。确认旧 live 主库、sidecar 和 marker 已删除，新 marker 为 `phase-3-application-audit-v16`。
3. 不要在 reset backup base 旁寻找 `.json`：启动 reset 不生成 checksum manifest。需要 SHA-256 manifest 时，另行调用 `POST /api/backups`，检查返回的 `workflow-<timestamp>.db` 与 `.db.json`。
4. 恢复演练只在隔离目录把 backup main/WAL/SHM 映射回 `workflow.db`/`workflow.db-wal`/`workflow.db-shm`，并用兼容旧 schema 且绕过 startup reset 的只读工具导出；不要让当前服务打开旧库。
5. 在新 live DB 重新登记 repository、active version branch/worktree、需求和关联。逐个确认这些 Git 路径的 HEAD/status 未因数据库 reset 改变；Flowgate 不得 reset 或删除任何 source/version/requirement worktree。

本次运行使用 `.local/t8-real-pilot-20260723-1228/` 下两个一次性真实 Git repository、两个本地 bare remote、两个 active version worktree 和两个 requirement worktree。数据库和完整机器证据位于同目录的 `workflow.db`、`evidence.json`。`.local/` 不进入 Git 提交。

环境没有 `OPENAI_API_KEY`。因此 production Store API 在真实 requirement worktree diff 上构造冻结的 implementation、独立 Review 和独立 automated-testing evidence，再由 production coordinator 接受、persistent queue/worker 和 `DeliveryApplicationService` 应用。这验证真实 Git 与 Phase 3 接受/队列/worker/application 边界，不验证外部 AI 请求；不得把它描述成外部模型调用通过。

### 依赖与应用时间线

1. plan 创建后 backend 为 `ready`，frontend 为 `waiting_dependency`，release condition 是 `automated_testing_passed`，`releasedByEvidenceVersion` 为 `null`。
2. backend Review 与 automated testing 分别保存；testing pass 后 backend 为 `ready_for_acceptance`，frontend 自动变为 `ready`，dependency 记录 `releasedByEvidenceVersion: 1`。
3. frontend 再完成 implementation、Review 和 automated testing，两单元均为 `ready_for_acceptance`。
4. `local-human` 完成总体业务验收，冻结顺序为 backend unit `8716e662-afba-4399-80c5-23a17bd2c55b`，再 frontend unit `435b6da5-f29e-40f4-8996-304774a669ee`。
5. worker 两次 drain 依次得到 backend `applied`、frontend `applied`，aggregate 为 `completed`；worker event 列表为空。

### Git 前后证据

以下路径均相对本项目 worktree。`status` 是 `git status --short`；空字符串表示 clean。

| worktree | path | branch | before HEAD / status | after HEAD / status |
|---|---|---|---|---|
| backend main | `.local/t8-real-pilot-20260723-1228/backend-main` | `main` | `76ac767c03986587cad19083739d572c932aad7f` / clean | 同一 HEAD / clean |
| backend version | `.local/t8-real-pilot-20260723-1228/backend-version` | `release/pilot-backend` | `76ac767c03986587cad19083739d572c932aad7f` / clean | 同一 HEAD / `M  src/feature.ts` |
| backend requirement | `.local/t8-real-pilot-20260723-1228/.ai-workflow-worktrees/backend-main/requirements/REQ-0001` | `ai/REQ-0001` | `76ac767c03986587cad19083739d572c932aad7f` / clean | `561e5018e2ccb553cbada83148ae7805ec3d4f2f` / clean |
| frontend main | `.local/t8-real-pilot-20260723-1228/frontend-main` | `main` | `76ac767c03986587cad19083739d572c932aad7f` / clean | 同一 HEAD / clean |
| frontend version | `.local/t8-real-pilot-20260723-1228/frontend-version` | `release/pilot-frontend` | `76ac767c03986587cad19083739d572c932aad7f` / clean | 同一 HEAD / `M  src/feature.ts` |
| frontend requirement | `.local/t8-real-pilot-20260723-1228/.ai-workflow-worktrees/frontend-main/requirements/REQ-0001` | `ai/REQ-0001` | `76ac767c03986587cad19083739d572c932aad7f` / clean | `0849218ff90fef73b202d502c0ac6a2404b35d59` / clean |

两个 requirement source branch 各新增一个 production application boundary 创建的本地提交：

- backend：`561e5018e2ccb553cbada83148ae7805ec3d4f2f Apply delivery unit 8716e662-afba-4399-80c5-23a17bd2c55b`
- frontend：`0849218ff90fef73b202d502c0ac6a2404b35d59 Apply delivery unit 435b6da5-f29e-40f4-8996-304774a669ee`

两个 version worktree 的 `preApplyCommit` 都是 `76ac767c03986587cad19083739d572c932aad7f`，应用后 HEAD 不变，改动保留为未提交 staged 文件。两个 main worktree 完全不变。backend/frontend 的 local remote-tracking refs、tags 和 bare remote refs 在前后都为空；运行没有调用 push、PR、tag 或 release。

### 自动门禁

- `npm test`：88/88 test files；1560 passed，3 skipped，exit 0。
- `npm run typecheck`：server/web 及 shared build 均 exit 0。
- `npm run build`：exit 0；Vite 转换 1623 modules，JS 382.80 kB（gzip 113.78 kB）。

### in-app browser 验收

- 桌面 viewport 的五阶段导航均可见且互不重叠。
- 390px viewport 中 page `scrollWidth === clientWidth === 390`；acceptance row 宽 332px，动作控件全宽，delivery matrix 为单列，没有横向溢出。
- fresh tab 的 console 为 0 error / 0 warning。应用记录 disclosure 展开、收起及空状态 ARIA 正确。
- 同一页面通过恢复动作从暂停进入运行，无整页 reload；backend dependency blocker 清零，frontend 只出现服务端授权的 `reuse`/`rerun`。
- partial/conflict 数据使用 `.local/t8-conflict-pilot-20260723-1244/` 下的另一组真实 disposable repositories：backend 为 `applied` 且 version worktree 保留 `M  src/feature.ts`，frontend 为 `conflicted`，aggregate 为 `partially_applied`；两个 version HEAD 在应用前后均不变。
- T7 Minor 首次真实复现为：retry dialog 打开后，第二客户端提交 retry 导致 SSE 撤权，dialog 隐藏；worker 再次得到 conflict 并恢复授权时，旧父状态让 dialog 自动重开。修复提交 `57eebf5` 在撤权时清空父 `retryUnitId` 和 action error；同一真实流程复验后 regrant 不再自动打开，必须再次点击 retry 才能打开。
