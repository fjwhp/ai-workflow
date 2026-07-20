# 本地开始使用

## 环境

- Node.js 22+
- npm 10+
- Git
- OpenAI API Key（仅前两个 AI 阶段需要）

```bash
cp .env.example .env
npm install
set -a && source .env && set +a
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。API 默认监听 `http://127.0.0.1:3210`。密钥只从环境变量读取，不写入 SQLite 或前端。

## 首次启动 v3

当前 schema marker 是 `phase-2-foundation-v3`。升级前停止所有服务，并确认没有正在运行的任务。首次以本版本打开 v2 或其他旧 live 数据目录时：

1. 服务复制旧 SQLite 主文件以及当时存在的 WAL/SHM，形成同一时间戳的备份集。
2. 只有备份集全部写入成功后，服务才移走旧 live 文件。
3. 服务创建空的 v3 数据库和新的 marker；项目、版本、需求和编号从新库重新开始。

这是 backup + fresh reset，不是迁移。Phase 1 history 只在 backup；不执行 row migration、dual read/write 或 fallback，也不提供旧库与新库并行读写入口。用户已授权旧数据以新跑为准。

`DATA_DIR` 默认为 `./data`：

- live 主文件：`workflow.db`
- live 伴随文件：`workflow.db-wal`、`workflow.db-shm`（存在时）
- marker：`workflow.db.schema-version`
- backup：`workflow.db.backup-<timestamp>` 及对应的 `-wal`、`-shm`

不要把旧备份交给当前服务打开。需要查历史时，使用兼容旧 schema 的代码在隔离目录只读导出；不要把导出结果写回 v3 live DB。

## 建立新工作流

1. 在“项目”登记一个或多个本地 Git 仓库。
2. 为每个交付项目创建或登记使用中的项目版本。
3. 创建需求并选择主项目和版本；随后可配置多个上下文项目和多个交付项目。
4. 运行 `definition`，人工确认业务定义。
5. 运行 `solution_design`，人工确认交付单元、依赖和接口。
6. 批准方案后查看 delivery matrix。Phase 1 只会显示 `ready` 与 `waiting_dependency`。
7. 进入 `implementation`、`quality_verification` 或 `acceptance_delivery` 后，页面自动显示只读交付矩阵，不会执行 AI 或 Git job。兼容接口 `/run` 也只执行同一只读查询。

不存在单项目真实编码限制或单项目 executor fallback。Phase 1 对所有下游交付都保持只读；多项目 queue/worker 在 Phase 2 统一实现。

## 五阶段职责

- `definition`：业务定义。
- `solution_design`：方案与交付计划。
- `implementation`：交付单元实现。
- `quality_verification`：独立 Review 和独立自动化测试；两者互不替代。
- `acceptance_delivery`：成果汇总与人工总体业务验收。

Phase 2 才激活 queue、worker、Review 和测试。Phase 3 才提供 overall acceptance 与 dependency-ordered no-commit local application，且 application owner 是交付单元。

## Git 安全保证

项目验证、知识读取和 Phase 1 下游页面不会修改目标仓库。系统在任何阶段都绝不对目标项目自动执行：

- commit
- push
- tag
- 创建 PR

Phase 3 的本地应用也只能产生未提交改动，并由人工检查。Phase 1 当前没有任何本地应用 UI 或 requirement-level HTTP 入口。

## 验证开发环境

```bash
npm test
npm run typecheck
npm run build
git diff --check
```
