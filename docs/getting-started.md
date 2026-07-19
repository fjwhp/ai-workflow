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

### 首次启动 `project-versions-v1`

升级前先停止正在运行的服务，并确认没有 AI、编码或集成任务仍在执行。第一次用本版本启动旧数据目录时，服务会：

1. 将旧 SQLite 主文件和当时存在的 WAL/SHM 文件复制为同一时间戳的完整备份集；只有全部复制成功后才移除旧文件。
2. 创建新的 `project-versions-v1` 数据库。新库的项目、版本和需求列表均为空，旧记录不会自动迁移，需求编号从 `REQ-0001` 重新开始。
3. 要求重新登记本地项目。项目登记后会异步重建项目知识库；知识库可用后，先创建或登记至少一个使用中版本，再创建需求和启动 AI 阶段。

项目验证、登记和知识库重建只读取关联仓库，不修改源码，不创建提交、分支、推送或拉取请求。编码阶段仍会按既有规则创建隔离 worktree，但应用不会自动提交、合并或推送。

文件位于 `DATA_DIR`（默认 `./data`）：

- 当前主文件：`workflow.db`
- 当前 SQLite 伴随文件：`workflow.db-wal`、`workflow.db-shm`（存在时）
- 当前架构标记：`workflow.db.schema-version`，内容应为 `project-versions-v1`
- 旧库备份主文件：`workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ`；同名冲突时追加 `-1`、`-2` 等
- 对应备份伴随文件：`workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ-wal` 和 `workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ-shm`（旧库存在对应文件时）

不要只恢复主文件：未合并的已提交数据可能仍在 WAL 中。恢复旧数据仅用于回退或导出，并且可能需要能读取旧架构的旧版本应用代码。安全恢复步骤如下，其中 `BACKUP` 是不带 `-wal`/`-shm` 后缀的备份主文件完整路径：

```bash
# 1. 先停止 npm run dev / npm run start，并确认 3210 端口上的服务已退出。
DATA_DIR=./data
BACKUP="$DATA_DIR/workflow.db.backup-YYYY-MM-DDTHH-MM-SS-mmmZ"
FRESH="$DATA_DIR/fresh-project-versions-v1-$(date +%Y%m%dT%H%M%S)"
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
#    请按该旧版本文档写入准确值，不要写 project-versions-v1。
rm -f "$DATA_DIR/workflow.db.schema-version"
```

随后从兼容旧架构的代码版本启动并导出所需数据。不要用当前 `project-versions-v1` 服务直接打开已恢复的旧库，否则它会再次识别为不兼容并生成新备份、重置为空库。回到新版本时，先停止旧服务，再将恢复的旧库整套移开，并把 `$FRESH` 中的主文件、现有伴随文件和 `project-versions-v1` 标记整套移回。

### 项目上下文预算

`AI_PROJECT_CONTEXT_MAX_CHARS` 控制一次 AI 运行可接收的所有关联项目知识 JSON 的字符总量，默认 `200000`，允许范围为 `4000` 到 `1000000`。这是字符数，不是 token 数；实际 token 消耗取决于模型、提供商、语言和序列化内容，不能按固定比例换算。

保持默认值通常更稳妥。只有在运行明确报告 `PROJECT_CONTEXT_BUDGET_TOO_SMALL` 或证据显示重要项目知识被截断，并且所用 API 提供商和模型允许更大输入时才提高。非整数或低于安全最小值的配置会回退到默认 `200000`；高于硬上限的整数会限制为 `1000000`。提高前应先减少无关项目关联或缩小模块范围，并确认提供商的上下文限制、请求大小限制、延迟和费用。

## 多项目工作流

1. 进入“项目”，登记本地 Git 仓库。可验证和编辑名称、仓库路径、默认分支、类别与允许命令；路径或分支变化会触发知识库重建。
2. 在项目的“版本”区域创建新版本，或登记已经存在的本地分支。版本包含名称、版本分支、基线分支、长期 worktree、当前 HEAD 和状态。创建新分支时从所选基线创建；登记已有分支不会改写它。若该分支已被外部 worktree 占用，必须明确确认复用。
3. 新建需求时必须依次选择一个使用中的主项目和该项目的使用中版本。项目变化会清空旧版本选择；没有版本时不能创建需求。保存后系统在同一事务生成全局编号，例如 `REQ-0001`。
4. 需求通过项目关联表达关系：`上下文` 只提供知识且不绑定版本；`交付` 表示需要代码交付并必须选择属于该项目的版本。交付项目可标记为必需，并配置模块范围为自动、全部或指定模块。
5. 已批准技术设计后修改项目、版本、用途、交付责任或模块范围会使设计失效并返回技术设计阶段。显示顺序变化不会触发失效。
6. 当前阶段的技术设计可以读取多个关联项目。真实编码、Review、测试和本地应用只支持恰好一个交付项目及其一个使用中版本；没有交付项目、缺少版本或有多个交付项目都会阻止执行，多个交付项目显示 `MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED`。
7. 不再使用的项目可归档，完成交付且没有待处理应用的版本可关闭。归档项目和关闭版本不会出现在新需求选择中，历史关联和证据仍保留。

关系可以概括为：一个项目对应一个本地仓库；一个项目可以有多个版本；每个交付关联选择该项目的一个版本；多个需求可以选择同一版本并行完成设计、编码、Review 和测试，但向该版本的本地应用按队列串行执行。版本是唯一 target，不再提供自由 target branch。

## Worktree 布局与 Git 保证

受管 worktree 位于项目仓库相邻的根目录：

```text
.ai-workflow-worktrees/<repo>/
  versions/<version-id>/       # 长期版本 worktree
  requirements/REQ-0001/       # 需求生命周期 worktree
```

- 创建或登记版本不会切换项目主 worktree，不会改变其 HEAD 或已有 porcelain status。
- 创建需求没有 Git 副作用；开始编码前不存在该需求的 `ai/REQ-0001` 分支或 worktree。
- 首次编码从版本当前 HEAD 创建 `ai/REQ-0001` 和独立需求 worktree；同一需求再次编码或返工复用原分支和路径。不同需求不共享可写目录。
- 本地应用可在需求 worktree 形成证据提交，但向版本 worktree 使用无提交应用。系统绝不自动提交版本 target，也不执行 push、创建 PR 或修改项目主 worktree。
- 同一版本只有一个应用租约。第二个需求会保持待应用并显示队列位置；不同版本可以各自应用。

## 人工处理、重新检测与启动恢复

应用成功后，版本 worktree 保留未提交改动，需求进入 `awaiting_local_resolution`。人工检查、调整后只能选择提交或完整撤销，再点击“重新检测本地处理结果”：

- worktree 仍有改动：保持 `awaiting_local_resolution`，租约和后续队列不释放；
- worktree 已干净且 HEAD 从应用前 commit 前进：记录人工 commit，需求进入 `completed`，更新版本 HEAD 并释放队列；
- worktree 已干净且 HEAD 等于应用前 commit：判定为人工撤销，需求回到 `awaiting_merge` 并释放队列；
- HEAD 无法明确归因、分支不匹配或路径不可访问：进入 `manual_resolution_required`，保留租约、运行证据和现场，不能静默完成。

服务启动时会重新检查所有持有应用租约的版本。未提交现场继续等待人工处理；已经人工提交或撤销的现场按上述规则收敛；无法访问或中断且无法判断的现场保留为人工处理。重启不是跳过队列或丢弃改动的手段。

清理遗弃 worktree 前，先确认它干净、没有活动运行或应用租约；长期版本还应先在应用中关闭。不要直接删除目录。在项目主仓库之外执行：

```bash
git -C /absolute/path/to/abandoned-worktree status --short
git -C /absolute/path/to/repo worktree remove /absolute/path/to/abandoned-worktree
git -C /absolute/path/to/repo worktree prune
```

第一条命令必须无输出。若目录已被人工删除，跳过状态检查和 `worktree remove`，只运行 `git worktree prune` 清除陈旧登记。不要对有未提交改动或仍由应用登记的 worktree 使用 `--force`。

## 临时双需求 pilot

先用无 remote 的临时仓库验收，避免任何 push 或 PR 的可能。以下命令创建 `prod` 和预先存在的 `feature/2.2.2`：

```bash
PILOT_ROOT=$(mktemp -d)
PILOT_REPO="$PILOT_ROOT/pilot-repo"
git init -b prod "$PILOT_REPO"
git -C "$PILOT_REPO" config user.email pilot@example.com
git -C "$PILOT_REPO" config user.name "Pilot User"
printf 'pilot\n' > "$PILOT_REPO/README.md"
git -C "$PILOT_REPO" add README.md
git -C "$PILOT_REPO" commit -m "pilot base"
git -C "$PILOT_REPO" branch feature/2.2.2
git -C "$PILOT_REPO" branch --show-current
git -C "$PILOT_REPO" rev-parse HEAD
git -C "$PILOT_REPO" status --porcelain=v1
git -C "$PILOT_REPO" remote -v
```

在应用中按以下顺序验收，并记录每一步的页面状态与对应 Git 命令输出：

1. 登记临时项目，默认分支选 `prod`。从 `prod` 创建版本 `2.2.1` / `feature/2.2.1`，再把已有 `feature/2.2.2` 登记为第二个版本。确认主 worktree 仍在 `prod`，HEAD 和 status 与登记前一致。
2. 在 `2.2.1` 上创建两个低风险需求，确认编号依次为 `REQ-0001`、`REQ-0002`。编码前运行 `git -C "$PILOT_REPO" branch --list 'ai/REQ-*'`，应无输出。
3. 将两个需求分别推进到编码，确认 `git -C "$PILOT_REPO" worktree list --porcelain` 中出现不同的 `requirements/REQ-0001` 和 `requirements/REQ-0002` 路径及对应分支。再次启动其中一个需求的编码/返工，路径应保持不变。
4. 将 `REQ-0001` 应用到版本。记录版本应用前 HEAD，确认应用后 HEAD 未变、`git -C <2.2.1-worktree> status --porcelain=v1` 有输出，且版本日志没有新的 target commit。
5. 尝试应用 `REQ-0002`，确认它因 `REQ-0001` 持有租约而阻塞，并显示准确队列位置。
6. 在 `2.2.1` worktree 人工检查并提交 `REQ-0001`，点击“重新检测本地处理结果”。确认 `REQ-0001` 完成、版本 HEAD 更新、租约释放且 `REQ-0002` 可应用。
7. 应用 `REQ-0002` 后，用记录的应用前 HEAD 执行 `git -C <2.2.1-worktree> reset --hard <pre-apply-head>`，再重新检测。确认 `REQ-0002` 回到 `awaiting_merge`，而不是完成或丢失证据。
8. 再次核对主 worktree 的分支、HEAD 和 status 与第 1 步之前完全一致；`git -C "$PILOT_REPO" remote -v` 仍为空。应用运行记录中不应出现 push 或 PR；系统也不应生成版本 target commit。

最后分别在 `1440x900` 和 `390x844` 检查项目、版本、需求与应用界面：没有横向溢出、文字或控件重叠，浏览器控制台为零错误。临时仓库通过后，再对真实仓库重复同一流程；真实 pilot 前后还要比较 remote refs，并保留原主 worktree 的既有 status，不得自动提交、push 或创建 PR。

## 登记项目示例

进入“项目”，填写项目名称、本地 Git 仓库绝对路径、仓库中已存在的本地默认分支和允许命令。保存前可先验证；保存后等待知识库状态变为“就绪”。例如：

- 项目名称：`订单后端`
- 仓库路径：`/absolute/path/to/orders-backend`
- 默认分支：`main`
- 允许命令：`npm test`

登记项目只验证仓库，不修改代码。版本创建和编码阶段使用独立分支与 worktree；应用不会自动提交版本 target、合并到项目主 worktree、推送或创建 PR。

## 数据

- SQLite：`data/workflow.db`
- 备份：`data/backups/`
- 本地数据目录已经加入 `.gitignore`。

首次试用先登记至少一个项目，创建或登记一个使用中版本，再创建“统一订单备注校验”并选择主项目和版本，然后按产品 PRD、研发评审、技术设计、编码、Review、测试和验收顺序逐阶段手动启动 AI。
