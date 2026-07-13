# 将 AI Worktree 变更应用到本地分支设计

## 目标

在编码自测完成后，通过本地 Web 界面审核 AI worktree 的 Git diff，将单个需求的变更提交到 AI 分支，再安全地 `cherry-pick` 到项目主工作区当前检出的本地分支。

系统不自动切换本地分支、不覆盖未提交修改、不自动推送，也不直接合并整个 AI 分支。

## 已确认策略

- 目标分支始终是项目主工作区当前检出的分支。
- 操作开始后如果目标分支发生变化，立即停止。
- 项目主工作区必须干净，且不能处于 merge、rebase 或 cherry-pick 中。
- AI worktree 必须存在实际 diff。
- 采用“AI worktree 创建需求提交，再 cherry-pick 单个提交”的方式。
- 应用成功后保留 AI worktree，清理由用户单独触发。
- 允许在 Soto Dine 点餐项目真实试用，但绝不执行 `push`。

## 界面流程

编码自测成果区域新增“应用到本地分支”入口。入口只在存在编码执行记录时显示。

第一步为只读检查：

- 需求编号和标题。
- AI 分支、worktree 路径和执行状态。
- 项目主工作区路径、当前目标分支和 HEAD。
- 修改文件列表、增删行统计和完整 diff。
- 编码自测命令与结果。
- 是否满足应用前置条件。

检查通过后进入确认步骤。提交信息默认为：

```text
feat: apply REQ-xxxx <需求标题>
```

用户可以编辑提交信息。最终确认按钮明确显示目标分支，不使用含糊的“确定”。

## 安全检查

服务端在预检和真正应用前各执行一次检查，防止界面打开后仓库状态变化：

- 主工作区路径必须与登记项目路径一致。
- 主工作区必须处于本地命名分支，不能是 detached HEAD。
- `git status --porcelain` 必须为空。
- 不存在 `MERGE_HEAD`、`CHERRY_PICK_HEAD` 或 rebase 状态目录。
- 当前分支和 HEAD 必须与预检快照一致。
- AI worktree 路径必须属于该项目登记的 worktree，不能由前端自由传入。
- AI 分支必须与执行记录保存的分支一致。
- AI diff 必须非空。
- 变更文件不能命中项目 `sensitivePatterns`。
- 同一编码执行不存在已经成功的应用记录。

任何检查失败都返回可读原因，不执行提交或 cherry-pick。

## 提交范围

提交文件由服务端根据 `git status --porcelain -z` 结构化读取，不接受前端文件路径列表。只暂存本次 AI worktree 中检测到的已修改、已删除和未跟踪文件。

命中敏感规则、位于 `.git` 内或超出 worktree 的路径禁止提交。服务端使用参数数组调用 Git，不拼接 shell 命令。

AI worktree 已经存在提交但仍有 diff 时，仅提交当前 diff。diff 为空时不创建空提交。

## 应用流程

每次操作创建一条 `code_applications` 记录，状态依次为：

- `ready`：预检通过。
- `applying`：正在提交或 cherry-pick。
- `applied`：成功应用。
- `conflicted`：cherry-pick 产生冲突。
- `aborted`：用户取消冲突现场。
- `failed`：非冲突错误。

确认后服务端：

1. 重新验证预检快照。
2. 在 AI worktree 限定暂存变更文件。
3. 创建需求提交并记录源提交 ID。
4. 在项目主工作区执行 `git cherry-pick <sourceCommit>`。
5. 成功后记录目标提交 ID、目标分支和完成时间。

系统不会执行 `git push`。Git 命令清单中也不提供 push 能力。

## 冲突处理

`cherry-pick` 返回冲突时，应用记录标记为 `conflicted`，界面显示 `git diff --name-only --diff-filter=U` 得到的冲突文件。

提供两个动作：

- `保留冲突现场`：不执行任何命令，由用户在本地主工作区解决冲突并手动继续。
- `取消应用`：服务端确认当前仍是该次 cherry-pick 后执行 `git cherry-pick --abort`，记录状态为 `aborted`。

第一版不提供界面内编辑冲突文件，也不代替用户执行 `cherry-pick --continue`。

## 数据模型

`code_applications` 保存：执行 ID、需求 ID、项目 ID、源分支、源 worktree、源提交、目标分支、预检目标 HEAD、目标提交、提交信息、状态、冲突文件、错误、创建时间和完成时间。

同一执行只允许一条 `applied` 记录。失败或取消记录保留，重新尝试会创建新的记录，形成完整审计历史。

## 接口

- 获取编码执行的应用预检信息。
- 确认创建提交并应用到本地分支。
- 获取应用记录和当前冲突状态。
- 取消当前应用并执行 cherry-pick abort。

所有写操作只监听本机地址，并要求执行 ID 与需求、项目关系一致。

## 异常处理

- Git 身份未配置导致提交失败时，返回配置说明，不修改主工作区。
- AI 提交成功但 cherry-pick 前检查失败时，保留源提交，应用记录标记失败，用户可以重新尝试。
- cherry-pick 非冲突失败时，如果存在 cherry-pick 状态则自动 abort；否则保持主工作区原状。
- 服务重启时将遗留 `applying` 记录标记为 `failed`，但不会自动改变 Git 仓库状态。

## 测试与验收

自动化测试使用临时 Git 仓库覆盖：

- 干净主工作区预检通过。
- 脏工作区、detached HEAD、分支变化和正在进行的 Git 操作被阻止。
- 限定文件提交和敏感文件拦截。
- 成功提交并 cherry-pick。
- 冲突识别、保留现场和 abort。
- 重复应用保护。
- Git 命令中不存在 push。

完成自动化测试后，可在 Soto Dine 点餐项目真实试用。试用仅在用户确认的编码执行存在实际 diff、主工作区干净且目标分支明确时进行；允许本地提交和 cherry-pick，禁止 push。

## 非目标

- 不自动 push 或创建远程 PR。
- 不自动切换目标分支。
- 不合并整个 AI 分支。
- 不自动解决 cherry-pick 冲突。
- 不自动清理 worktree 或删除 AI 分支。
