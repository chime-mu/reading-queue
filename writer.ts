// Correctness-critical: the only code that writes vault files.
//
// Rules (from the plan, do not relax):
//   1. Never re-serialize YAML — line surgery only. Body stays byte-identical.
//   2. Compare-and-swap: re-read at write time; if an owned field changed since
//      the session snapshot, skip and report — never silently overwrite.
//   3. Write via temp file + rename() (atomic on APFS).
//   4. Malformed frontmatter / conflict markers → skip, log, never guess.

import { rename, unlink } from "node:fs/promises";

export type WriteResult =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string };

const CONFLICT_RE = /^(<{7}|={7}|>{7})/m;

export interface Frontmatter {
  /** exclusive line index of opening '---' (always 0) and index of closing '---' */
  closeIdx: number;
  lines: string[]; // all lines of the file, split on \n
  /** raw value text per field (first occurrence), e.g. `"quoted"` or `unread` */
  raw: Map<string, string>;
}

/** Parse the frontmatter block without interpreting YAML. Returns null if malformed. */
export function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith("---\n")) return null;
  const lines = text.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;
  const raw = new Map<string, string>();
  for (let i = 1; i < closeIdx; i++) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/);
    if (m && !raw.has(m[1])) raw.set(m[1], m[2]);
  }
  return { closeIdx, lines, raw };
}

/** Unquote a raw frontmatter value for comparison/display. */
export function unquote(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

/** Format a value in pipeline style: enums/dates bare, strings double-quoted. */
export function fmtValue(field: string, value: string): string {
  if (field === "status" || field === "closed" || field === "captured") return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.rq-tmp`;
  await Bun.write(tmp, content);
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Set (or with value=null, remove) owned frontmatter fields on one file.
 * `expected` carries the session-snapshot raw values for CAS — a field listed
 * there must currently have exactly that raw value (undefined = must be absent).
 */
export async function setFields(
  path: string,
  updates: Record<string, string | null>,
  expected: Record<string, string | undefined>,
): Promise<WriteResult> {
  const f = Bun.file(path);
  if (!(await f.exists())) return { ok: false, path, reason: "file missing" };
  const text = await f.text();

  if (CONFLICT_RE.test(text)) return { ok: false, path, reason: "merge conflict markers — quarantined" };
  const fm = parseFrontmatter(text);
  if (!fm) return { ok: false, path, reason: "malformed frontmatter" };

  // Compare-and-swap against the session snapshot.
  for (const [field, want] of Object.entries(expected)) {
    const cur = fm.raw.get(field);
    if (cur !== want) {
      return {
        ok: false,
        path,
        reason: `changed elsewhere (${field}: ${JSON.stringify(cur ?? null)} ≠ snapshot ${JSON.stringify(want ?? null)})`,
      };
    }
  }

  const lines = fm.lines.slice();
  let closeIdx = fm.closeIdx;
  for (const [field, value] of Object.entries(updates)) {
    const lineRe = new RegExp(`^${field}:`);
    let idx = -1;
    for (let i = 1; i < closeIdx; i++) {
      if (lineRe.test(lines[i])) {
        idx = i;
        break;
      }
    }
    if (value === null) {
      if (idx !== -1) {
        lines.splice(idx, 1);
        closeIdx--;
      }
    } else {
      const newLine = `${field}: ${fmtValue(field, value)}`;
      if (idx !== -1) lines[idx] = newLine;
      else {
        lines.splice(closeIdx, 0, newLine); // insert before closing ---
        closeIdx++;
      }
    }
  }

  await atomicWrite(path, lines.join("\n"));
  return { ok: true, path };
}

/**
 * Append a dated one-liner to a compass file's `## Evidence` section.
 * Idempotent: if the exact line is already present, reports ok without writing.
 */
export async function appendEvidence(path: string, line: string): Promise<WriteResult> {
  const f = Bun.file(path);
  if (!(await f.exists())) return { ok: false, path, reason: "compass file missing" };
  const text = await f.text();
  if (CONFLICT_RE.test(text)) return { ok: false, path, reason: "merge conflict markers — quarantined" };

  const lines = text.split("\n");
  if (lines.some((l) => l.trim() === line.trim())) return { ok: true, path };

  let evIdx = lines.findIndex((l) => /^##\s+Evidence\s*$/.test(l));
  if (evIdx === -1) {
    // No Evidence section: add one at the end.
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", "## Evidence", line, "");
    await atomicWrite(path, lines.join("\n"));
    return { ok: true, path };
  }
  // Insert at the end of the section: before the next `## ` heading (skipping
  // trailing blank lines), or at EOF.
  let insertAt = lines.length;
  for (let i = evIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  while (insertAt > evIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
  await atomicWrite(path, lines.join("\n"));
  return { ok: true, path };
}

/** Replace one frontmatter field on a compass file (reviewed:, status:, due: …). */
export async function setCompassField(
  path: string,
  field: string,
  value: string,
): Promise<WriteResult> {
  return setFields(path, { [field]: value }, {});
}
