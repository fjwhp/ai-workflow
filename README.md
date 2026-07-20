# Flowgate 五阶段研发工作流

Flowgate 是本地优先的 AI 研发工作台。当前 foundation 使用五个职责互斥的阶段：

| 阶段 | 唯一职责 |
|---|---|
| `definition` | 澄清业务目标、范围、约束和可验证验收标准 |
| `solution_design` | 定义跨项目方案、交付单元、依赖、接口和风险 |
| `implementation` | 按交付单元实现代码并保存 diff/文件证据，不执行项目命令 |
| `quality_verification` | 对实现做独立 Review，并由另一条独立活动执行冻结的自动化测试命令 |
| `acceptance_delivery` | 汇总交付成果，供总体业务验收与后续本地应用使用 |

阶段不得互相代办。尤其是 Review 与自动化测试必须独立记录、独立判定；测试通过不能替代 Review，Review 通过也不能替代测试。安全、确定、可审计的节点可以自动推进，但总体业务验收始终由人工负责。

## 当前交付范围

- **Phase 1（当前）**：批准方案后创建并展示状态为 `ready` 或 `waiting_dependency` 的交付单元。`implementation`、`quality_verification`、`acceptance_delivery` 的 `/run` 是只读查询，不启动 AI，不创建自动化队列，不运行 Git 任务，也不修改目标 worktree。
- **Phase 2**：激活交付单元队列、worker、独立 Review 和自动化测试。Phase 1 不预实现这些执行器。
- **Phase 3**：提供总体业务验收，以及按依赖顺序执行的 no-commit 本地应用。应用 owner 是交付单元，不是需求记录。

自动化 worker 生命周期已经接入服务启动，但 `AUTOMATION_WORKER_ENABLED` 当前默认关闭。在 Phase 2 action handlers 完整注册前不要启用；启动仍会恢复过期 lease，但不会消费 pending job。

任何阶段都不得在目标项目自动执行 commit、push、tag 或创建 PR。Phase 3 的本地应用也只允许留下未提交改动，必须由人工检查和决定后续处理。

## 数据基线

当前 schema marker 是 `phase-2-quality-coordination-v9`。首次用本版本打开 `phase-2-evidence-tree-v8`、`phase-2-evidence-tree-v7`、`phase-2-delivery-quality-v6`、`phase-2-delivery-execution-v5` 或其他旧 live 数据库时，服务先完整备份 SQLite 主文件及现存 WAL/SHM，再创建空的 quality-coordination-v9 数据库。旧历史只存在于备份中；不做 row migration、dual read/write 或 fallback，也没有旧新数据库并行入口。用户已授权旧数据以新跑为准。

详细操作见：

- [开始使用](docs/getting-started.md)
- [状态与门禁](docs/states-and-gates.md)
- [工作流 SOP](docs/workflow-sop.md)

## 开发命令

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

Web 默认监听 `http://127.0.0.1:5173`，API 默认监听 `http://127.0.0.1:3210`。
