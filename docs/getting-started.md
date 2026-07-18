# 本地应用使用说明

## 环境要求

- Node.js 22 或更高版本
- npm 10 或更高版本
- Git
- OpenAI API Key

## 启动

```bash
cp .env.example .env
```

在 `.env` 中填写 `OPENAI_API_KEY`。应用不会把密钥保存到 SQLite 或前端。

如果使用兼容 OpenAI API 的中转平台，还需要按照平台文档填写：

```bash
OPENAI_BASE_URL=https://中转平台提供的API根地址/v1
OPENAI_API_MODE=responses
OPENAI_MODEL=中转平台支持的模型ID
```

中转平台支持 OpenAI Responses API 时使用 `OPENAI_API_MODE=responses`；只兼容 Chat Completions（`POST /v1/chat/completions`）时使用 `OPENAI_API_MODE=chat`。两种模式都要求平台支持 JSON 结构化输出。

```bash
npm install
set -a && source .env && set +a
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。API 监听 `http://127.0.0.1:3210`。

### 首次启动 `multi-project-v1`

升级前先停止正在运行的服务，并确认没有 AI、编码或集成任务仍在执行。第一次用本版本启动旧数据目录时，服务会：

1. 将旧 SQLite 主文件和当时存在的 WAL/SHM 文件复制为同一时间戳的完整备份集；只有全部复制成功后才移除旧文件。
2. 创建新的 `multi-project-v1` 数据库。新库的项目列表和需求列表均为空，旧记录不会自动迁移，需求编号从 `REQ-0001` 重新开始。
3. 要求重新登记本地项目。项目登记后会异步重建项目知识库，知识库可用后再配置模块范围和启动 AI 阶段。

项目验证、登记和知识库重建只读取关联仓库，不修改源码，不创建提交、分支、推送或拉取请求。编码阶段仍会按既有规则创建隔离 worktree，但应用不会自动提交、合并或推送。

文件位于 `DATA_DIR`（默认 `./data`）：

- 当前主文件：`workflow.db`
- 当前 SQLite 伴随文件：`workflow.db-wal`、`workflow.db-shm`（存在时）
- 当前架构标记：`workflow.db.schema-version`，内容应为 `multi-project-v1`
- 旧库备份主文件：`workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ`；同名冲突时追加 `-1`、`-2` 等
- 对应备份伴随文件：`workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ-wal` 和 `workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ-shm`（旧库存在对应文件时）

不要只恢复主文件：未合并的已提交数据可能仍在 WAL 中。恢复旧数据仅用于回退或导出，并且可能需要能读取旧架构的旧版本应用代码。安全恢复步骤如下，其中 `BACKUP` 是不带 `-wal`/`-shm` 后缀的备份主文件完整路径：

```bash
# 1. 先停止 npm run dev / npm run start，并确认 3210 端口上的服务已退出。
DATA_DIR=./data
BACKUP="$DATA_DIR/workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ"
FRESH="$DATA_DIR/fresh-multi-project-v1-$(date +%Y%m%dT%H%M%S)"
mkdir -m 700 "$FRESH"

# 2. 将新库主文件、伴随文件和标记整体移开，不覆盖它们。
for file in workflow.db workflow.db-wal workflow.db-shm workflow.db.schema-version; do
  [ ! -e "$DATA_DIR/$file" ] || mv "$DATA_DIR/$file" "$FRESH/$file"
done

# 3. 恢复同一备份集；只复制备份中实际存在的伴随文件。
cp -p "$BACKUP" "$DATA_DIR/workflow.db"
[ ! -e "$BACKUP-wal" ] || cp -p "$BACKUP-wal" "$DATA_DIR/workflow.db-wal"
[ ! -e "$BACKUP-shm" ] || cp -p "$BACKUP-shm" "$DATA_DIR/workflow.db-shm"

# 4. 当前版本标记不能配旧库。删除它；若旧版本应用要求自己的标记，
#    请按该旧版本文档写入准确值，不要写 multi-project-v1。
rm -f "$DATA_DIR/workflow.db.schema-version"
```

随后从兼容旧架构的代码版本启动并导出所需数据。不要用当前 `multi-project-v1` 服务直接打开已恢复的旧库，否则它会再次识别为不兼容并生成新备份、重置为空库。回到新版本时，先停止旧服务，再将恢复的旧库整套移开，并把 `$FRESH` 中的主文件、现有伴随文件和 `multi-project-v1` 标记整套移回。

### 项目上下文预算

`AI_PROJECT_CONTEXT_MAX_CHARS` 控制一次 AI 运行可接收的所有关联项目知识 JSON 的字符总量，默认 `200000`，允许范围为 `4000` 到 `1000000`。这是字符数，不是 token 数；实际 token 消耗取决于模型、提供商、语言和序列化内容，不能按固定比例换算。

保持默认值通常更稳妥。只有在运行明确报告 `PROJECT_CONTEXT_BUDGET_TOO_SMALL` 或证据显示重要项目知识被截断，并且所用 API 提供商和模型允许更大输入时才提高。非整数或低于安全最小值的配置会回退到默认 `200000`；高于硬上限的整数会限制为 `1000000`。提高前应先减少无关项目关联或缩小模块范围，并确认提供商的上下文限制、请求大小限制、延迟和费用。

## 多项目工作流

1. 进入“项目”，登记本地 Git 仓库。可验证和编辑名称、仓库路径、默认分支、类别与允许命令；路径或分支变化会触发知识库重建。
2. 不再使用的项目可归档。归档项目不会出现在新需求或新关联选择中，历史关联和知识记录仍保留；仍承担活动交付的项目不能归档。
3. 新建需求时必须选择一个使用中的主项目。创建后进入需求详情的“管理关联项目”，可将主项目设为上下文或交付用途，并添加协作项目。
4. 每个关联项目选择用途：`上下文` 只提供知识；`交付` 表示需要代码交付。交付项目可标记为必需，并配置模块范围为自动、全部或指定模块。
5. 已批准技术设计后修改项目、用途、交付责任或模块范围会使设计失效并返回技术设计阶段。显示顺序变化不会触发失效。
6. 第一阶段的技术设计可以读取多个关联项目。真实编码、Review、测试和集成只支持恰好一个交付项目；没有交付项目或有多个交付项目都会阻止执行，多个交付项目显示 `MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED`。

## 登记项目示例

进入“项目”，填写项目名称、本地 Git 仓库绝对路径、仓库中已存在的本地默认分支和允许命令。保存前可先验证；保存后等待知识库状态变为“就绪”。例如：

- 项目名称：`订单后端`
- 仓库路径：`/absolute/path/to/orders-backend`
- 默认分支：`main`
- 允许命令：`npm test`

登记项目只验证仓库，不修改代码。编码阶段创建独立分支和 worktree；应用不会自动提交、合并或推送。

## 数据

- SQLite：`data/workflow.db`
- 备份：`data/backups/`
- 本地数据目录已经加入 `.gitignore`。

首次试用先登记至少一个项目，再创建“统一订单备注校验”并选择主项目，然后按产品 PRD、研发评审、技术设计、编码、Review、测试和验收顺序逐阶段手动启动 AI。
