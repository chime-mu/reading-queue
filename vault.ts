// Read side: fresh folder scan each session. No DB, no index — ~350 files
// parse in well under 100ms. Files without a status field are skipped
// (SPEC.md, .base files are not .md-with-status). Files containing merge
// conflict markers are quarantined: reported, never processed.

import { readdir } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { SOURCE_DIR, COMPASS_DIR } from "./config";
import { parseFrontmatter, unquote } from "./writer";

export interface SourceItem {
  path: string;
  file: string; // basename
  title: string;
  type: string;
  author: string[];
  captured: string; // YYYY-MM-DD ("" if missing)
  sourceUrl: string;
  status: string;
  description?: string;
  body: string;
  pull?: string;
  yield?: string;
  for?: string;
  closed?: string;
  rating?: number;
  /** raw line values of app-owned fields at scan time — the CAS snapshot */
  snapshot: Record<string, string | undefined>;
}

export interface CompassObject {
  path: string;
  file: string;
  name: string; // file name without "Thesis - " prefix / ".md"
  type: "intent" | "thesis" | "project";
  status: string;
  claim?: string;
  test?: string;
  role?: string;
  due?: string;
  serves?: string;
  opened?: string;
  reviewed?: string;
  evidence: string[]; // lines of the Evidence section
  body: string;
}

export interface VaultScan {
  items: SourceItem[];
  quarantined: string[];
  skipped: string[];
}

const CONFLICT_RE = /^(<{7}|={7}|>{7})/m;

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return [v];
  return [];
}

export async function scanSource(): Promise<VaultScan> {
  const items: SourceItem[] = [];
  const quarantined: string[] = [];
  const skipped: string[] = [];
  const names = (await readdir(SOURCE_DIR)).filter((n) => n.endsWith(".md"));

  for (const file of names) {
    const path = `${SOURCE_DIR}/${file}`;
    const text = await Bun.file(path).text();
    if (CONFLICT_RE.test(text)) {
      quarantined.push(file);
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm || !fm.raw.has("status")) {
      skipped.push(file);
      continue;
    }
    let y: Record<string, unknown> = {};
    try {
      y = parseYaml(fm.lines.slice(1, fm.closeIdx).join("\n")) ?? {};
    } catch {
      skipped.push(file);
      continue;
    }
    const body = fm.lines.slice(fm.closeIdx + 1).join("\n").trim();
    items.push({
      path,
      file,
      title: String(y.title ?? file.replace(/\.md$/, "")),
      type: String(y.type ?? ""),
      author: asStringArray(y.author).map((a) => a.replace(/^\[\[|\]\]$/g, "")),
      captured: String(y.captured ?? ""),
      sourceUrl: String(y["source-url"] ?? ""),
      status: String(y.status ?? ""),
      description: y.description ? String(y.description) : undefined,
      body,
      pull: y.pull ? String(y.pull) : undefined,
      yield: y.yield ? String(y.yield) : undefined,
      for: y.for ? String(y.for) : undefined,
      closed: y.closed ? String(y.closed) : undefined,
      rating: typeof y.rating === "number" ? y.rating : undefined,
      snapshot: {
        status: fm.raw.get("status"),
        pull: fm.raw.get("pull"),
        yield: fm.raw.get("yield"),
        for: fm.raw.get("for"),
        closed: fm.raw.get("closed"),
      },
    });
  }
  return { items, quarantined, skipped };
}

/** Library search: every word must appear somewhere; title hits first, then newest. */
export function searchItems(
  items: SourceItem[],
  opts: { q?: string; status?: string; offset?: number; limit?: number } = {},
): { items: SourceItem[]; total: number } {
  const words = (opts.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const titleHit = (i: SourceItem) => words.length > 0 && words.every((w) => i.title.toLowerCase().includes(w));
  const hits = items
    .filter((i) => !opts.status || i.status === opts.status)
    .filter((i) => {
      const text = [i.title, i.author.join(" "), i.description ?? "", i.body].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => Number(titleHit(b)) - Number(titleHit(a)) || b.captured.localeCompare(a.captured));
  const offset = opts.offset ?? 0;
  return { items: hits.slice(offset, offset + (opts.limit ?? 40)), total: hits.length };
}

export async function scanCompass(): Promise<CompassObject[]> {
  const out: CompassObject[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(COMPASS_DIR)).filter((n) => n.endsWith(".md"));
  } catch {
    return out;
  }
  for (const file of names) {
    const path = `${COMPASS_DIR}/${file}`;
    const text = await Bun.file(path).text();
    if (CONFLICT_RE.test(text)) continue;
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    const type = unquote(fm.raw.get("type"));
    if (type !== "intent" && type !== "thesis" && type !== "project") continue;

    const bodyLines = fm.lines.slice(fm.closeIdx + 1);
    const evidence: string[] = [];
    const evIdx = bodyLines.findIndex((l) => /^##\s+Evidence\s*$/.test(l));
    if (evIdx !== -1) {
      for (let i = evIdx + 1; i < bodyLines.length; i++) {
        if (/^##\s+/.test(bodyLines[i])) break;
        if (bodyLines[i].trim().startsWith("- ")) evidence.push(bodyLines[i].trim());
      }
    }
    out.push({
      path,
      file,
      name: file.replace(/\.md$/, "").replace(/^(Thesis|Project|Intent) - /, ""),
      type,
      status: unquote(fm.raw.get("status")) ?? "active",
      claim: unquote(fm.raw.get("claim")),
      test: unquote(fm.raw.get("test")),
      role: unquote(fm.raw.get("role")),
      due: unquote(fm.raw.get("due")),
      serves: unquote(fm.raw.get("serves")),
      opened: unquote(fm.raw.get("opened")),
      reviewed: unquote(fm.raw.get("reviewed")),
      evidence,
      body: bodyLines.join("\n").trim(),
    });
  }
  return out;
}

/** Active compass objects a source item may point at via `for:` (theses + projects). */
export function pickerTargets(compass: CompassObject[]): CompassObject[] {
  return compass
    .filter((c) => (c.type === "thesis" || c.type === "project") && c.status === "active")
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "project" ? -1 : 1));
}

export function daysSince(isoDate: string, today: string): number {
  if (!isoDate) return 0;
  const a = new Date(`${isoDate}T00:00:00`);
  const b = new Date(`${today}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Aging clock: the number of *active days* (days with a session that looked at
 * the queue) on or after `isoDate`. Wall-clock time doesn't count — a six-week
 * absence ages nothing, so a pause never wipes the inbox. `activeDays` are ISO
 * dates; duplicates are fine. */
export function activeDaysSince(isoDate: string, activeDays: Iterable<string>): number {
  if (!isoDate) return 0;
  const seen = new Set<string>();
  for (const d of activeDays) if (d >= isoDate) seen.add(d);
  return seen.size;
}
