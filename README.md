# Flowgate 五阶段研发工作流

Flowgate 是本地优先的 AI 研发工作台，使用五个职责互斥的阶段：

| 阶段 | 唯一职责 |
|---|---|
| `definition` | 澄清业务目标、范围、约束和可验证验收标准 |
| `solution_design` | 定义跨项目方案、交付单元、依赖、接口和风险 |
| `implementation` | 按交付单元实现代码并保存 diff/文件证据，不执行项目命令 |
| `quality_verification` | 对实现做独立 Review，并由另一条独立活动执行冻结的自动化测试命令 |
| `acceptance_delivery` | 汇总交付成果，供总体业务验收与后续本地应用使用 |

阶段不得互相代办。尤其是 Review 与自动化测试必须独立记录、独立判定；测试通过不能替代 Review，Review 通过也不能替代测试。安全、确定、可审计的节点可以自动推进，但总体业务验收始终由人工负责。

## 当前交付范围

- 方案批准后创建多项目 delivery plan，并为 root unit 创建持久化自动化任务。
- worker 执行 implementation、独立 Review 和独立自动化测试；两条质量证据均通过后才释放下游。
- 上游实现或契约变化会传播 stale evidence；人工可 pause/resume、reuse/rerun、override、optional skip 或 retry，所有操作保留审计。
- 详情 API 提供 server-owned `allowedActions`，Web 通过 SSE generation 实时刷新，并在连接失败时退回有界轮询。
- 总体业务验收必须由人工明确触发；批准后系统按依赖顺序执行 no-commit local application，不自动 commit、merge 或发布。

自动化 worker 生命周期已经接入服务启动，`AUTOMATION_WORKER_ENABLED` 默认关闭。需要执行 pending job 时显式设为 `true`；只浏览状态或运行 pilot 时可保持关闭。

任何阶段都不得在目标项目自动执行 commit、merge、push、tag 或创建 PR。后续本地应用也只允许留下未提交改动，必须由人工检查和决定后续处理。

## 数据基线

当前 schema marker 是 `phase-3-application-audit-v16`。首次用本版本打开 `phase-2-quality-attempt-v14` 或其他旧 live 数据库时，服务先完整备份 SQLite 主文件及现存 WAL/SHM，再创建空的 `phase-3-application-audit-v16` 数据库。旧历史只存在于备份中；不做 row migration、dual read/write 或 fallback，也没有旧新数据库并行入口。用户已授权旧数据以新跑为准。

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
