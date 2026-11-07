// Processor v2 — the deterministic half of "captured link → source/ page".
//
// The reading itself (browser) and the writing (agents) happen in a Claude Code
// session following .claude/skills/process/SKILL.md. This file owns everything
// that must be exact: which URLs are new, how they are keyed, what a finished
// page must look like, and how a run is recorded.
//
//   bun process.ts worklist [--limit N] [--out file.json]   new captures, oldest first
//   bun process.ts lookup <url>                             page that already has this URL, if any
//   bun process.ts check <page.md> ...                      validate finished pages against SPEC
//   bun process.ts record <rows.json> --note "..."          ledger + run-log rows, commit, push
//
// Never writes capture files or journals. Only appends to the two ledgers.

import { readdir, appendFile } from "node:fs/promises";
import { basename } from "node:path";
import { CAPTURE_DIR, JOURNALS_DIR, PROCESSED, SOURCE_DIR, VAULT } from "./config";
import { logRun } from "./journal";
import { commitAndPush } from "./git";
import { parseFrontmatter, unquote } from "./writer";

// ---------------------------------------------------------------------------
// URL keys

/** Query params that never identify content. Everything else is kept. */
const TRACKING = new Set(["r", "ref", "rcm", "si", "s", "t", "source", "share", "fbclid", "gclid", "igsh", "mkt_tok", "_hsenc", "_hsmi", "mc_cid", "mc_eid"]);

/**
 * The dedup key: tracking params and fragment stripped, trailing `?` removed.
 * Host is lower-cased; path is untouched (case matters on most hosts).
 */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  url.hash = "";
  const keep = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (TRACKING.has(k) || k.startsWith("utm_")) continue;
    keep.append(k, v);
  }
  url.search = keep.toString();
  url.hostname = url.hostname.toLowerCase();
  return url.toString().replace(/\?$/, "");
}

// ---------------------------------------------------------------------------
// Inputs: capture files and legacy journal lines

export interface Capture {
  date: string; // YYYY-MM-DD
  time: string; // HH.MM
  url: string; // as captured (trimmed)
  origin: string; // "capture:<device>" | "journal:<YYYY_MM_DD>"
}

const CAPTURE_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2})[.:](\d{2}) (\S+)\s*$/;

/** `YYYY-MM-DD HH.mm <url>` per line; blank and malformed lines are debris. */
export function parseCaptureFile(text: string, device: string): Capture[] {
  const out: Capture[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(CAPTURE_LINE);
    if (!m || !/^https?:\/\//.test(m[4])) continue;
    out.push({ date: m[1], time: `${m[2]}.${m[3]}`, url: m[4], origin: `capture:${device}` });
  }
  return out;
}

const JOURNAL_LINE = /\*\*(\d{2})[.:](\d{2})\*\*\s*\[\[quick capture\]\]:\s*(https?:\/\/\S+)/;
const CONFLICT_LINE = /^(<{7}|={7}|>{7})/;

/** Legacy `- **HH.MM** [[quick capture]]: url` lines (DONE/TODO prefixes tolerated).
 * Conflict markers are ignored so both sides are read. */
export function parseJournal(text: string, journalDate: string): Capture[] {
  const out: Capture[] = [];
  for (const line of text.split("\n")) {
    if (CONFLICT_LINE.test(line)) continue;
    const m = line.match(JOURNAL_LINE);
    if (!m) continue;
    out.push({ date: journalDate.replace(/_/g, "-"), time: `${m[1]}.${m[2]}`, url: m[3], origin: `journal:${journalDate}` });
  }
  return out;
}

/** An unreadable folder (EPERM from macOS privacy, an iCloud folder that is not there) must
 *  not masquerade as "0 unprocessed". Only an optional folder may be missing. */
async function listDir(dir: string, what: string, optional = false): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${what} at ${dir}: ${(e as Error).message}. ` +
      "If this is EPERM, macOS privacy (TCC) is blocking the terminal app: allow iCloud Drive / Full Disk Access for it, or `tccutil reset All <bundle-id>` and click Allow.");
  }
}

export async function readCaptureFiles(dir = CAPTURE_DIR): Promise<Capture[]> {
  const names = (await listDir(dir, "capture files")).filter((n) => /^capture-.*\.txt$/.test(n));
  const out: Capture[] = [];
  for (const n of names) {
    const device = n.replace(/^capture-/, "").replace(/\.txt$/, "");
    out.push(...parseCaptureFile(await Bun.file(`${dir}/${n}`).text(), device));
  }
  return out;
}

export async function readJournals(dir = JOURNALS_DIR): Promise<Capture[]> {
  const names = (await listDir(dir, "journals", true)).filter((n) => /^\d{4}_\d{2}_\d{2}\.md$/.test(n)).sort();
  const out: Capture[] = [];
  for (const n of names) {
    out.push(...parseJournal(await Bun.file(`${dir}/${n}`).text(), n.replace(/\.md$/, "")));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ledger

export interface LedgerRow {
  date: string; // YYYY_MM_DD
  time: string; // HH.MM
  url: string;
  page: string; // source/<Title>
}

export function parseLedger(text: string): LedgerRow[] {
  return text
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [date, time, url, page] = l.split("\t");
      return { date, time, url: url ?? "", page: page ?? "" };
    });
}

export async function loadLedger(path = PROCESSED): Promise<LedgerRow[]> {
  const f = Bun.file(path);
  return (await f.exists()) ? parseLedger(await f.text()) : [];
}

/** Canonical keys already in the ledger. */
export function ledgerKeys(rows: LedgerRow[]): Set<string> {
  return new Set(rows.map((r) => canonicalUrl(r.url)));
}

// ---------------------------------------------------------------------------
// Existing pages (dedup on the resolved target, e.g. a note's article)

export async function pageIndex(dir = SOURCE_DIR): Promise<Map<string, string>> {
  const idx = new Map<string, string>();
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return idx;
  }
  for (const n of names) {
    const fm = parseFrontmatter(await Bun.file(`${dir}/${n}`).text());
    const u = unquote(fm?.raw.get("source-url"));
    if (u) idx.set(canonicalUrl(u), `source/${n.replace(/\.md$/, "")}`);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Short links

/** Follow one redirect hop without fetching content (what `curl -sI` did). */
export async function resolveShortLink(url: string): Promise<string> {
  if (!/^https?:\/\/(lnkd\.in|t\.co|bit\.ly|buff\.ly)\//.test(url)) return url;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual", headers: { "user-agent": "Mozilla/5.0" } });
    const loc = res.headers.get("location");
    return loc ? canonicalUrl(loc) : url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Worklist

export interface WorkItem extends Capture {
  key: string; // canonical captured URL — the ledger key
  target: string; // where to read: key, or the short link resolved
  existing?: string; // page that already holds `target` as source-url
}

export async function worklist(opts: { limit?: number; resolve?: boolean } = {}): Promise<WorkItem[]> {
  const captures = [...(await readCaptureFiles()), ...(await readJournals())];
  const done = ledgerKeys(await loadLedger());
  const pages = await pageIndex();
  const seen = new Set<string>();
  const items: WorkItem[] = [];
  for (const c of captures.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))) {
    const key = canonicalUrl(c.url);
    if (done.has(key) || seen.has(key)) continue;
    seen.add(key);
    const target = opts.resolve === false ? key : await resolveShortLink(key);
    const existing = pages.get(target) ?? pages.get(key);
    items.push({ ...c, key, target, ...(existing ? { existing } : {}) });
    if (opts.limit && items.length >= opts.limit) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Page validation (SPEC.md)

const TYPES = new Set(["article", "note", "paper", "video", "video-notes", "reference"]);

export interface CheckResult {
  path: string;
  ok: boolean;
  problems: string[];
}

export async function checkPage(path: string, titles?: Set<string>): Promise<CheckResult> {
  const problems: string[] = [];
  const f = Bun.file(path);
  if (!(await f.exists())) return { path, ok: false, problems: ["file missing"] };
  const name = basename(path).replace(/\.md$/, "");
  if (/[:/?\\]/.test(name)) problems.push("filename contains : / ? or \\");
  const text = await f.text();
  const fm = parseFrontmatter(text);
  if (!fm) return { path, ok: false, problems: ["malformed frontmatter"] };
  for (const field of ["title", "type", "source-url", "captured", "status"]) {
    if (!fm.raw.has(field)) problems.push(`missing ${field}`);
  }
  const type = unquote(fm.raw.get("type"));
  if (type && !TYPES.has(type)) problems.push(`unknown type ${type}`);
  if (fm.raw.has("status") && unquote(fm.raw.get("status")) !== "unread") problems.push("status must be unread on creation");
  if (fm.raw.has("rating")) problems.push("rating is Michael's field — never written by the pipeline");
  const captured = unquote(fm.raw.get("captured"));
  if (captured && !/^\d{4}-\d{2}-\d{2}$/.test(captured)) problems.push("captured must be YYYY-MM-DD");
  const desc = unquote(fm.raw.get("description"));
  if (desc && desc.length > 240) problems.push(`description too long (${desc.length} chars, max 240)`);
  const body = fm.lines.slice(fm.closeIdx + 1).join("\n").trim();
  if (body.length < 80) problems.push("body too short to be a summary");
  if (/^\s*- /m.test(body) && type !== "video-notes" && type !== "reference") problems.push("body uses outliner bullets; prose expected");
  if (titles) {
    const rel = fm.raw.get("related") ?? "";
    for (const m of rel.matchAll(/\[\[([^\]]+)\]\]/g)) {
      if (!titles.has(m[1])) problems.push(`related link does not resolve: ${m[1]}`);
    }
  }
  return { path, ok: problems.length === 0, problems };
}

export async function sourceTitles(dir = SOURCE_DIR): Promise<Set<string>> {
  try {
    return new Set((await readdir(dir)).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, "")));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Record a run

export interface RecordRow {
  date: string; // YYYY-MM-DD or YYYY_MM_DD
  time: string; // HH.MM
  key: string; // the captured URL (canonical)
  page: string; // source/<Title>
}

export async function record(
  rows: RecordRow[],
  ledger = PROCESSED,
  vault = VAULT,
): Promise<{ added: LedgerRow[]; skipped: string[]; missing: string[] }> {
  const have = ledgerKeys(await loadLedger(ledger));
  const added: LedgerRow[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const r of rows) {
    const key = canonicalUrl(r.key);
    if (have.has(key)) {
      skipped.push(key);
      continue;
    }
    const pagePath = `${vault}/${r.page}.md`;
    if (!(await Bun.file(pagePath).exists())) {
      missing.push(r.page);
      continue;
    }
    const row = { date: r.date.replace(/-/g, "_"), time: r.time, url: key, page: r.page };
    await appendFile(ledger, `${row.date}\t${row.time}\t${row.url}\t${row.page}\n`);
    have.add(key);
    added.push(row);
  }
  return { added, skipped, missing };
}

// ---------------------------------------------------------------------------
// CLI

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "worklist") {
    const limit = Number(arg("--limit") ?? 0) || undefined;
    const items = await worklist({ limit });
    const out = arg("--out");
    if (out) await Bun.write(out, JSON.stringify(items, null, 2) + "\n");
    for (const [i, it] of items.entries()) {
      const flag = it.existing ? `  → already: ${it.existing}` : it.target !== it.key ? `  → ${it.target}` : "";
      console.log(`${String(i + 1).padStart(3)}  ${it.date} ${it.time}  ${it.key}${flag}`);
    }
    console.log(`${items.length} unprocessed${out ? ` → ${out}` : ""}`);
    return;
  }
  if (cmd === "lookup") {
    const url = process.argv[3];
    if (!url) throw new Error("usage: lookup <url>");
    const target = await resolveShortLink(canonicalUrl(url));
    const pages = await pageIndex();
    const hit = pages.get(target) ?? pages.get(canonicalUrl(url));
    console.log(hit ?? "");
    process.exit(hit ? 0 : 1);
  }
  if (cmd === "check") {
    const titles = await sourceTitles();
    let bad = 0;
    for (const p of process.argv.slice(3)) {
      const r = await checkPage(p, titles);
      if (r.ok) console.log(`ok   ${basename(p)}`);
      else {
        bad++;
        console.log(`FAIL ${basename(p)}\n     ${r.problems.join("\n     ")}`);
      }
    }
    process.exit(bad ? 1 : 0);
  }
  if (cmd === "record") {
    const file = process.argv[3];
    if (!file) throw new Error("usage: record <rows.json> --note \"...\" [--no-git]");
    const rows = JSON.parse(await Bun.file(file).text()) as RecordRow[];
    const note = arg("--note") ?? `${rows.length} captures`;
    const res = await record(rows);
    await logRun("link-processor", res.added.length ? "ok" : "no-new-items", res.added.length, note);
    console.log(`ledger: ${res.added.length} added, ${res.skipped.length} already present, ${res.missing.length} pages missing`);
    for (const m of res.missing) console.log(`  missing page: ${m}`);
    if (process.argv.includes("--no-git")) return;
    const files = ["pipeline/processed.tsv", "pipeline/run-log.tsv", ...res.added.map((r) => `${r.page}.md`)];
    const git = await commitAndPush(files, `process captures: ${res.added.length} new source pages\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`);
    console.log(`git: ${git.detail}`);
    return;
  }
  console.log("usage: bun process.ts worklist|lookup|check|record ...");
  process.exit(2);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
