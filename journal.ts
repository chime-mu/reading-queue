// Crash journal + undo journal + run log. All append-only.

import { appendFile, mkdir } from "node:fs/promises";
import { APP_DIR, RUN_LOG } from "./config";

let ready = false;
async function ensureDir() {
  if (!ready) {
    await mkdir(APP_DIR, { recursive: true });
    ready = true;
  }
}

export async function journal(event: Record<string, unknown>): Promise<void> {
  await ensureDir();
  await appendFile(`${APP_DIR}/session.jsonl`, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
}

export interface UndoEntry {
  session: string; // session id (ISO timestamp of commit)
  file: string; // absolute path
  field: string;
  /** raw value to restore (undefined = field was absent → remove) */
  oldRaw: string | undefined;
  /** raw value we wrote (CAS expectation for the undo) */
  newRaw: string;
}

export async function recordUndo(entries: UndoEntry[]): Promise<void> {
  await ensureDir();
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  if (lines) await appendFile(`${APP_DIR}/undo.jsonl`, lines + "\n");
}

export async function lastUndoSession(): Promise<UndoEntry[]> {
  const f = Bun.file(`${APP_DIR}/undo.jsonl`);
  if (!(await f.exists())) return [];
  const all = (await f.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as UndoEntry);
  if (all.length === 0) return [];
  const last = all[all.length - 1].session;
  return all.filter((e) => e.session === last);
}

/** run-log row per processed.tsv convention: underscore dates, dot times. */
export async function logRun(task: string, outcome: string, items: number, note: string): Promise<void> {
  const now = new Date();
  const date = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, "0")}_${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}`;
  await appendFile(RUN_LOG, `${date}\t${time}\t${task}\t${outcome}\t${items}\t${note}\n`);
}

export async function readRunLog(): Promise<{ date: string; time: string; task: string; outcome: string; items: number; note: string }[]> {
  const f = Bun.file(RUN_LOG);
  if (!(await f.exists())) return [];
  return (await f.text())
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [date, time, task, outcome, items, note] = l.split("\t");
      return { date, time, task, outcome, items: Number(items) || 0, note: note ?? "" };
    });
}
