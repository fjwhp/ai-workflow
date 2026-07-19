export const projectVersionStatuses = ["active", "closed"] as const;

export type ProjectVersionStatus = typeof projectVersionStatuses[number];

export interface ProjectVersion {
  id: string;
  projectId: string;
  projectName?: string;
  name: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  status: ProjectVersionStatus;
  headCommit: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type ProjectVersionValidation = {
  valid: boolean;
  mode?: "create_branch" | "attach_branch" | "reuse_worktree";
  branch: string;
  baseBranch: string;
  headCommit?: string;
  existingWorktreePath?: string;
  error?: string;
};

export type LocalResolution =
  | { status: "pending" }
  | { status: "committed"; commit: string }
  | { status: "reverted" }
  | { status: "ambiguous"; currentHead: string };
