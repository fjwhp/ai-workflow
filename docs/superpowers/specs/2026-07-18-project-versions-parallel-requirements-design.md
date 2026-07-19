# 项目版本与并行需求设计

## 目标

在正式进入多项目交付 Phase 2 前，先完成一次可控的真实试运行：同一个本地 Git 项目可以维护多个版本分支，每个版本可以承载多条并行需求。每条需求拥有独立 AI 源分支和需求生命周期 worktree，完成后按队列应用到该版本的长期本地 worktree。

项目、版本和需求必须是三个独立概念：

- 项目保存长期仓库配置、默认分支、命令策略和知识库；
- 版本保存本地目标分支和人工验收 worktree；
- 需求保存业务流程，并通过项目关联选择交付版本。

系统自动执行预检、应用和测试，但不会自动提交版本 worktree，也不会推送远端。

## 已确认决策

- 版本是项目下的一等对象，不是项目默认分支，也不是需求中的自由文本字段。
- 创建版本时，若本地分支不存在，则从用户选择的本地分支或已存在的精确远端跟踪分支创建；若已经存在，则校验后登记。
- 每个版本拥有一个长期本地 worktree。项目主工作区不切分支，也不接收需求应用改动。
- 新建需求必须先选择项目，再选择该项目的使用中版本。
- 需求编号全系统递增，继续使用 `REQ-0001`、`REQ-0002`，版本变化不重置编号。
- 新建需求时只保存数据并预留源分支名，不创建 Git 分支或 worktree。
- 需求首次进入编码阶段时，从版本分支当时的 HEAD 创建 `ai/REQ-0001` 和独立的需求生命周期 worktree。
- 同一版本下的需求可以并行完成产品、设计、编码、Review 和测试。
- 同一版本 worktree 一次只能接收一条需求。应用严格串行，不允许叠加多条需求的未提交改动。
- 应用成功后保留为本地未提交改动，等待人工检查、提交或撤销。
- 系统不自动 commit、不自动 push、不创建远端分支或 Pull Request。

## 非目标

本轮不实现：

- 多项目 delivery unit 状态机和依赖调度；
- 跨仓库并行编码或依赖顺序应用；
- 自动提交版本 worktree、自动推送或自动创建 PR；
- Git tag、发布说明、变更日志或正式发布流程；
- 多条需求未提交改动在同一版本 worktree 中叠加；
- 远端分支同步、拉取或远端冲突处理；
- 旧需求到版本模型的兼容回填。

一个需求关联多个交付项目时，仍按 Phase 1 规则在编码前返回 `MULTI_PROJECT_EXECUTION_PHASE_2_REQUIRED`。

## 领域模型

### 项目版本

新增 `project_versions`：

```text
id
project_id
name
branch
base_branch
worktree_path
status: active | closed
head_commit
pending_requirement_id
pending_integration_run_id
created_at
updated_at
closed_at
```

约束：

- 同一项目内 `name` 唯一；
- 同一项目内 `branch` 唯一；
- `project_id` 必须指向使用中的项目；
- `branch` 必须是合法本地分支名；`base_branch` 必须是合法分支名，并解析到登记项目中的精确本地分支或已存在的精确远端跟踪 ref；本流程不会 fetch 或同步远端；
- `worktree_path` 由服务端生成，客户端不能传入；
- `pending_requirement_id` 表示版本 worktree 当前唯一的未提交需求占用者。

版本只提供 `active` 和 `closed` 两个状态。关闭版本会阻止新需求、启动新编码和进入本地应用，但不会删除历史需求、运行证据或 worktree 元数据。

### 需求项目版本关联

在 `requirement_projects` 增加可空的 `project_version_id`：

- `usage = delivery` 时必须关联同一项目下的使用中版本；
- `usage = context` 时必须为空；
- 创建需求时，主项目默认是交付项目，因此同时写入所选版本；
- 关联编辑器修改项目、用途或版本时，复用现有技术设计失效与快照重建规则；
- 技术设计批准时，在关联快照中冻结版本 ID、名称、分支、worktree 路径和当时 HEAD。

版本放在项目关联而不是 `requirements` 主表上。这样未来 Phase 2 可以为每个交付项目选择自己的版本，而不需要再次迁移需求模型。

### 需求源分支

需求源分支固定为 `ai/<requirement-code>`，例如 `ai/REQ-0001`。需求全局编号保证源分支名唯一，不需要把版本名重复编码进分支。

进入编码时记录：

- `project_version_id`；
- 版本分支；
- 创建时版本 HEAD，即 `base_commit`；
- 需求源分支；
- 需求生命周期 worktree 路径。

尚未进入编码的需求不固定基线。它们开始编码时使用版本最新 HEAD。已经进入编码的需求继续保留原 `base_commit`，应用前检查版本是否前进并正常执行冲突预检。

## Git 工作区布局

继续使用项目仓库相邻的 `.ai-workflow-worktrees` 根目录，并区分两类工作区：

```text
.ai-workflow-worktrees/<repo>/
  versions/<version-id>/       # 长期版本 worktree
  requirements/REQ-0001/       # 需求生命周期 worktree
```

创建版本：

1. 验证项目仓库、项目默认分支和用户选择的本地或精确远端跟踪基线分支，不执行 fetch。
2. 使用 `git check-ref-format --branch` 验证目标版本分支。
3. 若版本分支不存在，使用 `git worktree add -b <branch> <path> <base>` 创建。
4. 若分支已存在，使用 `git worktree add <path> <branch>` 登记长期 worktree。
5. 若该分支已经被另一个 worktree 占用，则返回现有路径并要求用户决定是否登记该 worktree；系统不强制移动或删除用户 worktree。
6. 记录版本 HEAD，确认项目主工作区的当前分支和 `git status` 未变化。

首次进入编码时，从版本分支创建需求源分支和需求生命周期 worktree。同一需求的返工继续复用该分支和 worktree，并由现有同阶段运行锁阻止并发写入；不会为一次新运行创建第二个 worktree。编码 AI 只操作需求 worktree，不操作版本 worktree 或项目主工作区。需求完成或取消后才允许显式清理该 worktree。

## 生命周期与数据流

### 创建版本

项目页提供始终可见的“新建版本”入口，表单包含：

- 版本名称，例如 `2.2.1`；
- 版本分支，默认由名称生成 `feature/2.2.1`，允许编辑；
- 创建基线，默认选择项目默认分支，也可以选择其他本地分支或仓库中已存在的精确远端跟踪分支。

保存前执行只读校验并明确显示“创建新分支”或“登记已有分支”。最终保存时在服务端重新校验，完成 Git worktree 创建后再持久化版本。若数据库持久化失败，移除本次新建且仍为空净的版本 worktree 和分支；永不删除预先存在的用户分支。

### 新建需求

新建需求表单按顺序提供：

1. 项目；
2. 该项目的使用中版本；
3. 标题、业务问题、期望结果和优先级。

项目变化时清空旧版本选择并重新加载。没有使用中版本时，不允许保存并提供“前往创建版本”入口。

保存需求和生成编号必须处于同一个 SQLite 事务中。编号继续由全局需求序列生成，任何并发请求都不能产生重复或跳过已提交编号。保存后需求进入现有产品 AI 待启动状态；此时没有 Git 副作用。

### 编码执行

进入编码时：

1. 解析唯一交付项目及其版本；
2. 拒绝已归档项目、已关闭版本或多交付项目；
3. 读取版本 worktree 的真实 HEAD；
4. 创建或复用 `ai/REQ-0001` 和需求生命周期 worktree；
5. 把版本快照、基线 commit 和模块范围写入执行证据；
6. 启动现有 Codex 编码流程。

需求的产品、评审和总体技术设计阶段不创建 worktree，可以继续并行运行。

### 串行本地应用

同一版本的多个需求可以同时达到待应用状态，但只能有一个持有版本应用租约。

应用事务先原子设置 `project_versions.pending_requirement_id` 和 `pending_integration_run_id`。以下任一条件会拒绝租约：

- 版本已经被另一需求占用；
- 版本 worktree 不存在、分支不匹配或无法访问；
- 版本 worktree 有未提交改动；
- 项目已归档或版本已关闭；
- 编码证据缺失、过期或哈希不匹配；
- 需求源 worktree 或源分支不匹配。

获取租约后，复用现有流程：在需求 worktree 内形成可追溯源提交，再向版本 worktree 执行 `cherry-pick --no-commit`，随后运行变更感知测试。

应用成功后，需求进入新增状态 `awaiting_local_resolution`，版本租约继续保留。界面显示版本 worktree 路径、未提交文件、测试结果和人工操作提示。

### 人工提交或撤销

系统轮询或手动“重新检测”版本 worktree：

- worktree 仍有改动：保持 `awaiting_local_resolution` 和版本占用；
- worktree 已干净且 HEAD 相对应用前前进：记录人工提交 commit，需求进入 `completed`，释放版本占用；
- worktree 已干净且 HEAD 等于应用前 commit：记录人工撤销，需求返回 `awaiting_merge`，释放版本占用；
- HEAD 发生无法归因的变化：标记 `manual_resolution_required`，保持占用并要求人工确认，不能静默完成。

人工提交允许包含额外调整，因此系统记录最终 commit 和原证据哈希，但不会声称最终提交与 AI diff 完全相同。若需要重新验证最终提交，用户可以在释放前手动触发应用后测试。

## 并行与锁

- 不限制同一版本同时处于 PRD、设计、编码、Review 或测试的需求数量。
- 需求源分支和 worktree 始终一需求一份，不共享可写目录。
- `project_versions.pending_requirement_id` 是版本 worktree 的单写锁。
- 获取锁、创建 integration run 和更新需求状态必须在同一数据库事务中。
- 服务重启时检查持有锁的版本：worktree 有改动则恢复等待人工处理；worktree 已干净则按 HEAD 变化执行提交/撤销判定；路径失效则标记人工处理。
- 不同版本拥有不同长期 worktree，可以并行应用。
- 同一 Git 分支不能同时登记为同一项目的两个版本，也不能由两个版本 worktree 占用。

## 界面

### 项目版本区

项目页在项目配置和知识库之外增加版本区：

- 使用中/已关闭筛选；
- 新建版本；
- 版本名称、分支、基线、HEAD 和 worktree 路径；
- 需求数量及各阶段摘要；
- 当前应用占用者和等待队列；
- 重新检测和关闭版本操作。

关闭版本使用应用内确认弹窗。版本存在运行中需求、待应用需求、未提交改动或人工处理状态时，按钮禁用并显示具体原因。

### 新建需求

项目和版本使用两个独立选择控件。版本选项显示名称和分支，例如 `2.2.1 · feature/2.2.1`。保存成功后展示系统生成的需求编号，不让用户编辑编号。

### 需求详情

详情页显示：

- 项目和版本；
- 版本目标分支与版本 worktree；
- 需求源分支与需求生命周期 worktree；
- 编码基线 commit；
- 版本应用队列位置；
- 等待人工提交、人工已提交或人工已撤销状态。

现有“目标分支”自由选择在版本需求中移除。目标分支由冻结的项目版本决定，防止应用阶段临时改到错误分支。

## API

新增：

```text
GET    /api/projects/:projectId/versions?status=active|closed|all
POST   /api/projects/:projectId/versions/validate
POST   /api/projects/:projectId/versions
GET    /api/project-versions/:id
POST   /api/project-versions/:id/recheck
POST   /api/project-versions/:id/close
GET    /api/project-versions/:id/requirements
GET    /api/project-versions/:id/application-queue
```

调整：

- `POST /api/requirements` 增加 `primaryProjectVersionId`；
- 需求项目关联输入对交付项目增加 `projectVersionId`；
- 编码和本地应用上下文从项目版本解析分支与目标 worktree；
- 本地应用成功返回 `awaiting_local_resolution`；
- 增加版本 worktree 重新检测和人工处理确认接口。

所有写接口都在持久化前重新验证项目、版本和 Git 状态，不能信任前端校验快照。

## 错误处理

需要稳定错误码和面向用户的明确说明：

- `PROJECT_VERSION_NAME_EXISTS`
- `PROJECT_VERSION_BRANCH_EXISTS`
- `PROJECT_VERSION_BRANCH_INVALID`
- `PROJECT_VERSION_BRANCH_IN_USE`
- `PROJECT_VERSION_NOT_ACTIVE`
- `PROJECT_VERSION_WORKTREE_DIRTY`
- `PROJECT_VERSION_APPLICATION_BUSY`
- `PROJECT_VERSION_HAS_ACTIVE_REQUIREMENTS`
- `PROJECT_VERSION_CLOSE_BLOCKED`
- `REQUIREMENT_VERSION_REQUIRED`
- `REQUIREMENT_VERSION_PROJECT_MISMATCH`
- `LOCAL_RESOLUTION_AMBIGUOUS`

创建版本的 Git 操作失败时不留下数据库记录。数据库写入失败时只清理本次由系统创建且仍安全可删除的 worktree/分支，不清理用户已有分支。

应用冲突时撤销本次 cherry-pick 并恢复应用前 HEAD，记录冲突文件，释放版本租约，需求保持待应用。应用后测试失败时保留未提交改动和版本租约，需求进入现有测试失败状态，允许人工修复后重测。

## 数据升级

当前本地库刚完成 `multi-project-v1` 干净重建，本轮继续采用明确的备份后重建，而不是为尚未试运行的数据增加兼容迁移：

1. 启动前停止活动 AI 和应用任务；
2. 备份数据库主文件及 WAL/SHM；
3. 使用新 schema 标记创建空数据库；
4. 重新登记项目和版本；
5. 从 `REQ-0001` 开始真实试运行。

升级不会修改任何登记项目仓库。版本分支和 worktree 只在用户通过界面创建版本后生成。

## 测试策略

### 领域与存储

- 同项目版本名称和分支唯一；
- 版本与项目匹配；
- 交付项目必须有版本，上下文项目不能有版本；
- 并发需求创建生成唯一全局编号；
- 应用租约获取和 integration run 创建原子化；
- 关闭版本的全部阻断条件；
- 服务重启后的租约恢复。

### Git

- 新建分支和登记已有分支；
- 已被其他 worktree 占用的分支；
- 创建版本不改变项目主工作区分支或状态；
- 两条需求从同一版本生成唯一源分支和 worktree；
- 版本前进后的正常应用与冲突；
- 脏版本 worktree 阻断下一需求；
- 不同版本 worktree 可以独立应用；
- 应用过程不自动提交版本分支，也不推送。

### API 与前端

- 项目切换后只显示匹配的使用中版本；
- 没有版本时的新建需求引导；
- 版本创建的校验、错误定位和重复提交保护；
- 版本列表、需求摘要和应用队列；
- 等待人工处理、人工提交、人工撤销和模糊状态；
- 移动端表单、版本列表和需求详情无溢出。

### 回归

- 单项目单需求完整执行继续可用；
- 项目知识库、项目记忆、自动门禁、人工放行和返工不回归；
- 多交付项目继续在编码前阻断；
- 全量测试、类型检查和生产构建通过；
- 真实生产入口完成数据库备份并启动新 schema。

## 真实试运行验收

1. 登记 Soto Dine，创建或登记 `feature/2.2.1`，确认项目主工作区分支和本地改动没有变化。
2. 在 2.2.1 下连续创建两条需求，获得 `REQ-0001` 和 `REQ-0002`。
3. 两条需求进入编码后生成 `ai/REQ-0001` 和 `ai/REQ-0002` 两个独立的需求生命周期 worktree。
4. 两条需求可以同时处于编码、Review 或测试阶段，运行记录和证据互不覆盖。
5. 先把 REQ-0001 应用到 2.2.1 版本 worktree，确认得到未提交改动且没有自动 commit/push。
6. REQ-0001 未处理时，REQ-0002 显示版本被占用并等待，不修改版本 worktree。
7. 人工提交或撤销 REQ-0001 后重新检测，系统释放版本并允许应用 REQ-0002。
8. 整个流程中 Soto Dine 项目主工作区保持原分支和原本地状态。
