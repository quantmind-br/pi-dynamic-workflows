/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. An isolated agent's edits are committed and merged back
 * to the base branch ONLY on success (commitWorktree + mergeWorktree) — a saga: a
 * partial/failed agent's branch is discarded untouched, so a resume re-run cannot
 * double-apply. A merge conflict aborts the merge and keeps the branch/worktree for
 * manual reconciliation. Falls back to a logged no-op when isolation isn't possible.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Worktree {
  /** True when a real worktree was created; false means "ran in the shared tree". */
  isolated: boolean;
  /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
  cwd: string;
  branch?: string;
  /** Repo root the worktree was added to (for teardown). */
  repoRoot?: string;
  /** Why isolation was skipped, when isolated === false. */
  reason?: string;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. The `name` must be deterministic (derived from runId + call index,
 * never wall-clock) so resume keys stay stable. Returns a no-op Worktree on any failure.
 */
export async function createWorktree(baseCwd: string, name: string): Promise<Worktree> {
  const id = slug(name);
  let repoRoot: string;
  try {
    const { stdout } = await exec("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
  }

  const path = join(repoRoot, ".pi", "worktrees", id);
  const branch = `pi/wf/${id}`;
  try {
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"]);
    return { isolated: true, cwd: path, branch, repoRoot };
  } catch (error) {
    return { isolated: false, cwd: baseCwd, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove a worktree and (unless keepBranch) its branch. Best-effort; safe to call on
 * a no-op Worktree. Pass keepBranch to drop the working dir but preserve the branch
 * (e.g. to keep committed-but-unmerged work for manual reconciliation).
 */
export async function removeWorktree(wt: Worktree, opts?: { keepBranch?: boolean }): Promise<void> {
  if (!wt.isolated || !wt.repoRoot) return;
  try {
    await exec("git", ["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd]);
  } catch {
    // already gone / locked — fall through
  }
  if (wt.branch && !opts?.keepBranch) {
    try {
      await exec("git", ["-C", wt.repoRoot, "branch", "-D", wt.branch]);
    } catch {
      // branch already deleted
    }
  }
}

/**
 * Stage and commit all changes in an isolated worktree onto its branch. Returns true
 * when a commit was made, false when there is nothing to commit, isolation is off, or
 * any git step fails (best-effort — a commit failure never fails the agent).
 */
export async function commitWorktree(wt: Worktree, message: string): Promise<boolean> {
  if (!wt.isolated) return false;
  try {
    await exec("git", ["-C", wt.cwd, "add", "-A"]);
    const { stdout } = await exec("git", ["-C", wt.cwd, "status", "--porcelain"]);
    if (!stdout.trim()) return false; // no changes → nothing to merge
    await exec("git", ["-C", wt.cwd, "commit", "-q", "-m", message]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge an isolated worktree's committed branch back into the base repo's current
 * branch with a merge commit. On conflict the merge is aborted (base tree left clean)
 * and { conflict: true } is returned so the caller can keep the branch for manual
 * reconciliation.
 */
export async function mergeWorktree(wt: Worktree): Promise<{ merged: boolean; conflict: boolean }> {
  if (!wt.isolated || !wt.repoRoot || !wt.branch) return { merged: false, conflict: false };
  try {
    await exec("git", ["-C", wt.repoRoot, "merge", "--no-ff", "--no-edit", wt.branch]);
    return { merged: true, conflict: false };
  } catch {
    try {
      await exec("git", ["-C", wt.repoRoot, "merge", "--abort"]);
    } catch {
      // best-effort: nothing to abort, or already clean
    }
    return { merged: false, conflict: true };
  }
}
