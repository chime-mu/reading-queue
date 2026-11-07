// Git against the vault: strictly best-effort, never blocks the UI, never throws.
// The vault is synced by per-device auto-commit from several devices; our job is
// only to land our writes as clean atomic commits when remote access exists.

import { VAULT } from "./config";

export interface GitResult {
  ok: boolean;
  detail: string;
}

async function git(args: string[], timeoutMs = 15000): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: VAULT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { ok: code === 0, detail: out.trim().slice(0, 500) };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export async function pullRebase(): Promise<GitResult> {
  return git(["pull", "--rebase", "--autostash"], 20000);
}

/** Stage exactly the touched files and commit; push best-effort. Empty-commit-safe
 * (a Logseq auto-commit may have swept our changes up first). */
export async function commitAndPush(files: string[], message: string): Promise<GitResult> {
  if (files.length === 0) return { ok: true, detail: "nothing to commit" };
  const add = await git(["add", "--", ...files]);
  if (!add.ok) return add;
  const commit = await git(["commit", "-m", message]);
  if (!commit.ok && !/nothing to commit|no changes added/.test(commit.detail)) return commit;
  const push = await git(["push"]);
  return {
    ok: true,
    detail: push.ok ? "committed and pushed" : `committed; push failed (${push.detail.split("\n")[0]})`,
  };
}

export async function conflictedFiles(): Promise<string[]> {
  const r = await git(["diff", "--name-only", "--diff-filter=U"]);
  return r.ok && r.detail ? r.detail.split("\n").filter(Boolean) : [];
}
