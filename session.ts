// Applying committed session decisions to the vault. Pure application logic —
// server.ts only does HTTP. Nothing here runs until the user confirms the
// end-of-session review screen.

import { basename, dirname } from "node:path";
import { COMPASS_DIR, REQUIRES, SOURCE_DIR, TRANSITIONS } from "./config";
import { setFields, appendEvidence, parseFrontmatter, fmtValue } from "./writer";
import { recordUndo, type UndoEntry } from "./journal";

export interface Decision {
  file: string; // absolute path of the source item
  action: "scanned" | "dropped" | "fun" | "queued" | "scanned+yield" | "read" | "return";
  pull?: string;
  yield?: string;
  for?: string; // "[[Compass file name]]"
  snapshot: Record<string, string | undefined>; // raw CAS values from session start
}

export interface ApplyResult {
  file: string;
  ok: boolean;
  detail: string;
}

const ACTION_STATUS: Record<Decision["action"], string> = {
  scanned: "scanned",
  "scanned+yield": "scanned",
  dropped: "dropped",
  fun: "fun",
  queued: "queued",
  read: "read",
  return: "unread",
};

// File paths arrive from the browser, so they are checked, never trusted: the
// app writes only markdown files directly inside these two folders.
// Compared as written, never normalized: "Project - ../x.md" must not pass by
// resolving back inside. Everything legitimate is built as `${dir}/${name}`.
const isDirectlyIn = (dir: string, file: string) => file.endsWith(".md") && dirname(file) === dir;
export const isSourceFile = (file: string) => isDirectlyIn(SOURCE_DIR, file);
export const isCompassFile = (file: string) => isDirectlyIn(COMPASS_DIR, file);

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function validate(d: Decision): string | null {
  if (!isSourceFile(d.file)) return "not a source file";
  if (d.for && !isCompassFile(compassPath(d.for))) return "not a compass object";
  const from = d.snapshot.status;
  const to = ACTION_STATUS[d.action];
  if (!to) return `unknown action ${d.action}`;
  const legal = TRANSITIONS[from ?? ""] ?? [];
  // same-status writes are allowed (e.g. orphan reassignment keeps `queued`)
  if (from !== to && !legal.includes(to as never)) return `illegal transition ${from} → ${to}`;
  if (to === "queued" && !d.pull?.trim()) return "queued requires a pull line";
  if (to === "read" && !d.yield?.trim()) return "read requires a yield line";
  if (d.action === "scanned+yield" && !d.yield?.trim()) return "scanned+yield requires a yield line";
  return null;
}

/** Resolve "[[Name]]" → absolute compass path. */
export function compassPath(forLink: string): string {
  return `${COMPASS_DIR}/${forLink.replace(/^\[\[|\]\]$/g, "")}.md`;
}

export async function applyDecision(d: Decision, sessionId: string): Promise<ApplyResult> {
  const invalid = validate(d);
  if (invalid) return { file: d.file, ok: false, detail: invalid };

  const status = ACTION_STATUS[d.action];
  const updates: Record<string, string | null> = { status };
  const expected: Record<string, string | undefined> = { status: d.snapshot.status };
  if (d.pull?.trim()) {
    updates.pull = d.pull.trim();
    expected.pull = d.snapshot.pull;
  }
  if (d.yield?.trim()) {
    updates.yield = d.yield.trim();
    expected.yield = d.snapshot.yield;
  }
  if (d.for?.trim()) {
    updates.for = d.for.trim();
    expected.for = d.snapshot.for;
  }
  // Rescuing an amnestied item (backlog mode): clear the automation stamp.
  if (d.snapshot.status === "dropped" && (status === "queued" || status === "scanned") && d.snapshot.closed !== undefined) {
    updates.closed = null;
    expected.closed = d.snapshot.closed;
  }

  const r = await setFields(d.file, updates, expected);
  if (!r.ok) return { file: d.file, ok: false, detail: r.reason };

  // Undo journal: inverse of every line we changed.
  const undo: UndoEntry[] = Object.entries(updates).map(([field, value]) => ({
    session: sessionId,
    file: d.file,
    field,
    oldRaw: d.snapshot[field],
    newRaw: value === null ? "" : fmtValue(field, value),
  }));
  await recordUndo(undo);

  // Yield feeding a compass object → Evidence one-liner.
  if (d.yield?.trim() && d.for?.trim()) {
    const item = basename(d.file, ".md");
    const line = `- ${today()} — ${d.yield.trim()} ([[${item}]])`;
    const ev = await appendEvidence(compassPath(d.for), line);
    if (!ev.ok) return { file: d.file, ok: true, detail: `status written; evidence append failed: ${ev.reason}` };
  }
  return { file: d.file, ok: true, detail: status };
}

/** Aging drop: dropped + closed stamp, both CAS-guarded. */
export async function applyAgingDrop(
  file: string,
  snapshot: Record<string, string | undefined>,
  sessionId: string,
): Promise<ApplyResult> {
  if (!isSourceFile(file)) return { file, ok: false, detail: "not a source file" };
  const r = await setFields(file, { status: "dropped", closed: today() }, { status: snapshot.status, closed: snapshot.closed });
  if (!r.ok) return { file, ok: false, detail: r.reason };
  await recordUndo([
    { session: sessionId, file, field: "status", oldRaw: snapshot.status, newRaw: "dropped" },
    { session: sessionId, file, field: "closed", oldRaw: snapshot.closed, newRaw: today() },
  ]);
  return { file, ok: true, detail: "dropped (aged out)" };
}

export async function applyAgingReturn(
  file: string,
  snapshot: Record<string, string | undefined>,
  sessionId: string,
): Promise<ApplyResult> {
  if (!isSourceFile(file)) return { file, ok: false, detail: "not a source file" };
  const r = await setFields(file, { status: "unread" }, { status: snapshot.status });
  if (!r.ok) return { file, ok: false, detail: r.reason };
  await recordUndo([{ session: sessionId, file, field: "status", oldRaw: snapshot.status, newRaw: "unread" }]);
  return { file, ok: true, detail: "returned to inbox" };
}

/** Undo one journal entry via the CAS writer. */
export async function applyUndo(e: UndoEntry): Promise<ApplyResult> {
  const cur = await Bun.file(e.file).text().catch(() => null);
  if (cur === null) return { file: e.file, ok: false, detail: "file missing" };
  const fm = parseFrontmatter(cur);
  if (!fm) return { file: e.file, ok: false, detail: "malformed frontmatter" };
  const expectRaw = e.newRaw === "" ? undefined : e.newRaw;
  if (fm.raw.get(e.field) !== expectRaw) {
    return { file: e.file, ok: false, detail: `changed since session (${e.field})` };
  }
  // Restore old raw value verbatim (or remove the line).
  const lines = fm.lines.slice();
  let closeIdx = fm.closeIdx;
  let idx = -1;
  for (let i = 1; i < closeIdx; i++) {
    if (new RegExp(`^${e.field}:`).test(lines[i])) {
      idx = i;
      break;
    }
  }
  if (e.oldRaw === undefined) {
    if (idx !== -1) lines.splice(idx, 1);
  } else {
    const newLine = `${e.field}: ${e.oldRaw}`;
    if (idx !== -1) lines[idx] = newLine;
    else lines.splice(closeIdx, 0, newLine);
  }
  const tmp = `${e.file}.rq-tmp`;
  await Bun.write(tmp, lines.join("\n"));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, e.file);
  return { file: e.file, ok: true, detail: `${e.field} restored` };
}
