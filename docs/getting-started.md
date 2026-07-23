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

## 首次启动 phase-3-application-audit-v16

当前 schema marker 是 `phase-3-application-audit-v16`。升级前停止所有服务，并确认没有正在运行的任务。首次以本版本打开 `phase-2-quality-attempt-v14`、`phase-2-quality-coordination-v10`、`phase-2-automation-v4` 或其他旧 live 数据目录时：

1. 服务复制旧 SQLite 主文件以及当时存在的 WAL/SHM，形成同一时间戳的备份集。
2. 只有备份集全部写入成功后，服务才移走旧 live 文件。
3. 服务创建空的 `phase-3-application-audit-v16` 数据库和新的 marker；项目、版本、需求和编号从新库重新开始。

这是 backup + fresh reset，不是迁移。旧 history 只在 backup；不执行 row migration、dual read/write 或 fallback，也不提供旧库与新库并行读写入口。用户已授权旧数据以新跑为准。

`DATA_DIR` 默认为 `./data`：

- live 主文件：`workflow.db`
- live 伴随文件：`workflow.db-wal`、`workflow.db-shm`（存在时）
- marker：`workflow.db.schema-version`
- backup：`workflow.db.backup-<timestamp>` 及对应的 `-wal`、`-shm`

时间戳将 ISO 时间中的 `:` 和 `.` 替换为 `-`。如果完整 backup set 的任一目标名已存在，服务不覆盖旧文件，而是对 backup base 追加 `-1`、`-2` 等碰撞后缀；例如主库为 `workflow.db.backup-2026-07-23T04-00-00-000Z-1` 时，sidecar 为同一 base 的 `-wal`、`-shm`。只有主库及所有当时存在的 sidecar 都复制成功后，旧 live WAL、SHM、marker 和主库才按主库最后的顺序删除；复制失败会保留原 live set。

启动 reset 备份是原始 SQLite 文件集，不生成 checksum 或 manifest sidecar。它与人工备份 API 不同：

```bash
curl -X POST http://127.0.0.1:3210/api/backups
```

`POST /api/backups` 将主库复制到 `BACKUP_DIR`（默认 `data/backups`）下的 `workflow-<timestamp>.db`，并生成同名 `.db.json` manifest，其中包含数据库文件名和 SHA-256。不要把这份手动 manifest 的保证写到启动 reset 备份上；reset backup base 旁没有 `.json`。

### 隔离恢复与重新登记

1. 停止 Flowgate，保留整个 reset backup set，不要改名或只取主文件。
2. 新建一个不作为当前 `DATA_DIR` 的隔离目录，把 `workflow.db.backup-<timestamp>[-N]` 复制为隔离目录中的 `workflow.db`；存在 `-wal`、`-shm` 时分别复制为 `workflow.db-wal`、`workflow.db-shm`。
3. 只用兼容备份原 marker/schema、且绕过 destructive startup reset 的旧代码或 SQLite 只读工具在隔离目录读取或导出。当前 `phase-3-application-audit-v16` 服务不能导入、迁移或并行读取该旧库，也不要直接对旧库执行新版本启动。
4. 回到当前版本，以空的 `phase-3-application-audit-v16` live DB 启动服务。在“项目”重新登记仍存在的本地 repository，再为每个项目重新登记当前 active version branch/worktree，最后重新创建需求及项目/版本关联；需要的旧内容从隔离导出人工核对后重录。
5. 验证每个登记路径的 repository identity、branch、HEAD 和 dirty status。数据库 reset 从不运行 `git reset`，也不删除 source repository、version worktree 或 requirement worktree；这些 Git 路径仍保持 reset 前的内容与历史。

不要把旧备份交给当前服务打开。需要查历史时，使用兼容旧 schema 的代码在隔离目录只读导出；不要把导出结果写回 `phase-3-application-audit-v16` live DB。

## 建立新工作流

1. 在“项目”登记一个或多个本地 Git 仓库。
2. 为每个交付项目创建或登记使用中的项目版本。
3. 创建需求并选择主项目和版本；随后可配置多个上下文项目和多个交付项目。
4. 运行 `definition`，人工确认业务定义。
5. 运行 `solution_design`，人工确认交付单元、依赖和接口。
6. 批准方案后查看 delivery matrix。系统创建 root implementation job；有未释放上游的单元保持 `waiting_dependency`。
7. 使用 `AUTOMATION_WORKER_ENABLED=true npm run dev` 启动交付 worker。实现完成后，Review 与自动化测试分别运行并保存 evidence；两者均通过才释放下游。
8. 在详情页根据 server-owned `allowedActions` 执行 pause/resume、stale reuse/rerun、override、optional skip 或 retry。页面不能自行推断操作资格。
9. 所有必需单元通过后，由人工执行总体业务验收。验收记录成功后，worker 按冻结顺序执行 no-commit 本地应用。

不存在单项目 executor fallback。一个需求可以关联多个项目与版本，queue/worker 按 delivery unit 和依赖图并行推进。

## 五阶段职责

- `definition`：业务定义。
- `solution_design`：方案与交付计划。
- `implementation`：交付单元实现。
- `quality_verification`：独立 Review 和独立自动化测试；两者互不替代。
- `acceptance_delivery`：成果汇总与人工总体业务验收。

当前 queue、worker、Review、测试、失效传播、人工恢复和 dependency-ordered no-commit local application 已生效。overall acceptance 仍由人工完成，application owner 是交付单元。

## 浏览器验收 pilot

使用尚不存在的专用目录生成真实仓储数据，不会向正常 UI 注入静态 fixture：

```bash
PILOT_DATA_DIR="$PWD/.local/delivery-pilot" npm run pilot:seed -w server
DATA_DIR="$PWD/.local/delivery-pilot" AUTOMATION_WORKER_ENABLED=false npm run dev
```

seed 要求目标目录尚不存在。它先在目标同级的 owned `sibling staging` 完成数据库、marker 和 fsync，再通过内核 no-replace rename 原子发布；macOS 使用 `RENAME_EXCL`，Linux 使用 `RENAME_NOREPLACE`。并发 owner 会得到 `PILOT_PUBLISH_CONFLICT`，原子能力不可用会得到 `PILOT_ATOMIC_PUBLISH_UNAVAILABLE`；失败只清理 staging，不修改目标或用户文件。CLI 失败固定输出 `FLOWGATE_PILOT_ERROR` 及结构化错误码并以状态 1 退出。

打开 `REQ-0001` 可查看 backend/frontend 两个单元、独立 evidence、已释放依赖、frontend stale、需求 paused 和服务端返回的 resume action。seed 拒绝覆盖已有数据库；重建前先停止服务并删除整个 `.local/delivery-pilot` 目录。

## Git 安全保证

项目验证、知识读取和交付详情不会自行修改目标仓库。系统在任何阶段都绝不对目标项目自动执行：

- commit
- merge
- push
- tag
- 创建 PR

本地应用只能产生未提交改动，并由人工检查。总体业务验收与 application retry 的 HTTP/UI 入口已经开放；按钮资格始终来自服务端 `allowedActions`。retry 只处理失败的 delivery unit，不会重置已经应用的 sibling。

## 验证开发环境

```bash
npm test
npm run typecheck
npm run build
git diff --check
```
