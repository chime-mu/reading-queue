// Source monitor — the deterministic half of "watch trusted sources → source/ pages".
//
// The Logseq page `pages/Source monitor.md` is the source of truth for what is
// watched, the relevance filter and per-source notes. The browser crawl and the
// relevance judgement happen in a Claude Code session following
// .claude/skills/monitor/SKILL.md; this file owns what must be exact.
//
//   bun monitor.ts sources [--json]              the watched list, parsed from the page
//   bun monitor.ts status                        last collection date, whether one is due today
//   bun monitor.ts fetch [--since D] [--out f]   listings via Substack API / RSS (no browser); says which need one
//   bun monitor.ts new <candidates.json> [--out]  drop candidates already seen/processed/paged
//   bun monitor.ts record <rows.json> --note ""  monitor-seen + processed + last-run + run-log, commit, push
//
// Ledgers: pipeline/monitor-seen.tsv (#date-found source url title), pipeline/processed.tsv
// (same row as captures, time 00.00), pipeline/monitor-last-run.txt (YYYY-MM-DD).

import { appendFile } from "node:fs/promises";
import { VAULT, PROCESSED } from "./config";
import { logRun } from "./journal";
import { commitAndPush } from "./git";
import { canonicalUrl, loadLedger, ledgerKeys, pageIndex, record } from "./process";

export const MONITOR_PAGE = `${VAULT}/pages/Source monitor.md`;
export const MONITOR_SEEN = `${VAULT}/pipeline/monitor-seen.tsv`;
export const MONITOR_LAST_RUN = `${VAULT}/pipeline/monitor-last-run.txt`;

// ---------------------------------------------------------------------------
// The watched list

export interface Source {
  section: string; // a "##" heading on the page, e.g. "Podcasts"
  author: string; // "" for institutional sources
  name: string; // "The Newsletter", "Institution news"
  url: string;
  /** label used in monitor-seen.tsv, e.g. "Ann Author (Newsletter)" */
  label: string;
}

const SKIP_SECTIONS = /^(retired|relevance filter|per-source handling|reading|what this is)/i;

/** Parse the outliner page: `## Section` → `### Author — topic` → `- Name — https://…`. */
export function parseSources(text: string): Source[] {
  const out: Source[] = [];
  let section = "";
  let author = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*-\s*/, "").trim();
    const h2 = line.match(/^##\s+(.+?)(\s+\(.*)?$/);
    if (h2) {
      section = h2[1].trim();
      author = "";
      continue;
    }
    const h3 = line.match(/^###\s+(.+?)(\s+[—–-]\s+.*)?$/);
    if (h3) {
      author = h3[1].trim();
      continue;
    }
    if (!section || SKIP_SECTIONS.test(section)) continue;
    const m = line.match(/^(.*?)\s+[—–-]+\s+(https?:\/\/\S+)/) ?? line.match(/^()\s*(https?:\/\/\S+)/);
    if (!m) continue;
    const name = m[1].trim() || author;
    const url = m[2].replace(/[),.]+$/, "");
    const short = name.replace(/^(The|Substack)\s+/i, "").replace(/\s*\(.*\)$/, "");
    out.push({ section, author, name, url, label: author ? `${author} (${short})` : name });
  }
  return out;
}

export async function loadSources(path = MONITOR_PAGE): Promise<Source[]> {
  return parseSources(await Bun.file(path).text());
}

// ---------------------------------------------------------------------------
// State

export function todayCopenhagen(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function lastRun(path = MONITOR_LAST_RUN): Promise<string> {
  const f = Bun.file(path);
  return (await f.exists()) ? (await f.text()).trim() : "";
}

// ---------------------------------------------------------------------------
// Candidates → new items

export interface Candidate {
  source: string; // label from `sources`
  url: string;
  title: string;
  date?: string; // published, YYYY-MM-DD, when the listing shows it
  paid?: true; // listing says subscribers-only
}

export interface SeenRow {
  date: string;
  source: string;
  url: string;
  title: string;
}

export function parseSeen(text: string): SeenRow[] {
  return text
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [date, source, url, title] = l.split("\t");
      return { date, source: source ?? "", url: url ?? "", title: title ?? "" };
    });
}

export async function loadSeen(path = MONITOR_SEEN): Promise<SeenRow[]> {
  const f = Bun.file(path);
  return (await f.exists()) ? parseSeen(await f.text()) : [];
}

/** Everything the monitor must not surface again: seen, processed, or already a page. */
export async function knownKeys(paths: { seen?: string; processed?: string; source?: string } = {}): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const r of await loadSeen(paths.seen)) keys.add(canonicalUrl(r.url));
  for (const k of ledgerKeys(await loadLedger(paths.processed))) keys.add(k);
  for (const k of (await pageIndex(paths.source)).keys()) keys.add(k);
  return keys;
}

export function filterNew(candidates: Candidate[], known: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = canonicalUrl(c.url);
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, url: key });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Listings without a browser (metadata only — never article bodies)
//
// Substack publications expose `/api/v1/archive` as public JSON; blogs expose
// RSS/Atom. Both give title + url + date, which is all a listing needs. Sources
// that have neither (X profiles, Substack notes, Webflow/Next.js listings) are
// left to the browser and are reported as `unfetched`.

/** Per-source listing overrides, kept out of the repo because they name what is followed.
 *  See monitor.local.example.json. `feeds` is the feed URL for a source whose listing page has
 *  no API, or whose API lags: a feed wins over the API. `sitemaps` is for a listing page with
 *  neither API nor feed; `lastmod` moves on every edit, so it only narrows the candidates and
 *  the post page's JSON-LD `datePublished` decides. */
const LOCAL = Bun.file(`${import.meta.dir}/monitor.local.json`);
const overrides: {
  feeds?: Record<string, string>;
  sitemaps?: Record<string, { sitemap: string; prefix: string }>;
} = (await LOCAL.exists()) ? await LOCAL.json() : {};
export const FEEDS = overrides.feeds ?? {};
export const SITEMAPS = overrides.sitemaps ?? {};

/** `<loc>` under `prefix` whose `<lastmod>` is on or after `since`. */
export function parseSitemap(xml: string, prefix: string, since: string): { url: string; lastmod: string }[] {
  const out: { url: string; lastmod: string }[] = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1];
    const lastmod = m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] ?? "";
    if (loc && loc.startsWith(prefix) && !/\/page\/\d+\/?$/.test(loc) && lastmod.slice(0, 10) >= since) out.push({ url: loc, lastmod: lastmod.slice(0, 10) });
  }
  return out;
}

/** Title + publish date from a post page (JSON-LD, else og/article meta). */
export function parsePostMeta(html: string): { title: string; date: string } {
  const date =
    html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/article:published_time"\s+content="([^"]+)"/)?.[1] ??
    "";
  const title = (html.match(/property="og:title"\s+content="([^"]+)"/)?.[1] ?? html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "")
    .replace(/\s*\|\s*[^|]*$/, "")
    .replace(/&amp;/g, "&")
    .trim();
  return { title, date: date.slice(0, 10) };
}

export function substackBase(url: string): string | null {
  const m = url.match(/^(https?:\/\/[^/]+)\/archive\/?$/);
  return m ? m[1] : null;
}

interface SubstackPost {
  post_date: string;
  title: string;
  canonical_url: string;
  subtitle?: string;
  audience?: string;
}

export function parseSubstackArchive(json: unknown, source: string, since: string): Candidate[] {
  // Substack wrapped the array in { posts } (seen 2026-11-06). Anything else is an error, not "no new posts".
  const posts = Array.isArray(json) ? json : (json as { posts?: unknown } | null)?.posts;
  if (!Array.isArray(posts)) throw new Error(`unexpected Substack archive shape: ${JSON.stringify(json)?.slice(0, 80)}`);
  return (posts as SubstackPost[])
    .filter((p) => p.post_date && p.post_date.slice(0, 10) >= since)
    .map((p) => ({ source, url: p.canonical_url, title: p.title, date: p.post_date.slice(0, 10), ...(p.audience === "only_paid" ? { paid: true } : {}) }));
}

function rssDate(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Minimal RSS 2.0 / Atom reader: title, link, date. Enough for a listing. */
export function parseFeed(xml: string, source: string, since: string): Candidate[] {
  const out: Candidate[] = [];
  const text = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").replace(/<[^>]+>/g, "").trim() : "";
  };
  const isAtom = /<feed[\s>]/.test(xml);
  const blocks = xml.split(isAtom ? /<entry[\s>]/ : /<item[\s>]/).slice(1);
  for (const b of blocks) {
    const title = text(b, "title");
    let url = "";
    if (isAtom) {
      const alt = b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) ?? b.match(/<link[^>]*href="([^"]+)"/);
      url = alt ? alt[1] : "";
    } else {
      url = text(b, "link") || (b.match(/<guid[^>]*>([^<]+)</)?.[1] ?? "");
    }
    const date = rssDate(text(b, isAtom ? "published" : "pubDate") || text(b, "updated"));
    if (title && url && date >= since) out.push({ source, url: url.replace(/&amp;/g, "&"), title, date });
  }
  return out;
}

export interface FetchReport {
  candidates: Candidate[];
  fetched: { source: string; count: number }[];
  unfetched: Source[]; // need the browser
  failed: { source: string; error: string }[];
}

export async function fetchListings(sources: Source[], since: string): Promise<FetchReport> {
  const rep: FetchReport = { candidates: [], fetched: [], unfetched: [], failed: [] };
  const ua = { "user-agent": "Mozilla/5.0 (Macintosh)" };
  for (const s of sources) {
    const base = substackBase(s.url);
    const feed = FEEDS[s.url] ?? FEEDS[s.url.replace(/\/$/, "")];
    const sm = SITEMAPS[s.url.replace(/\/$/, "")];
    try {
      let items: Candidate[] | null = null;
      if (sm) {
        const r = await fetch(sm.sitemap, { headers: ua });
        items = [];
        for (const { url } of parseSitemap(await r.text(), sm.prefix, since)) {
          const meta = parsePostMeta(await (await fetch(url, { headers: ua })).text());
          // Category and pagination pages carry no publish date; every real post has JSON-LD.
          if (meta.date && meta.date >= since) items.push({ source: s.label, url, title: meta.title, date: meta.date });
        }
      } else if (feed) {
        const r = await fetch(feed, { headers: ua });
        items = parseFeed(await r.text(), s.label, since);
      } else if (base) {
        const r = await fetch(`${base}/api/v1/archive?sort=new&limit=25`, { headers: ua });
        items = parseSubstackArchive(await r.json(), s.label, since);
      } else if (/^https?:\/\/[^/]+\/?$/.test(s.url)) {
        // A bare domain may be a custom-domain Substack (newsletter.example.com).
        const r = await fetch(`${s.url.replace(/\/$/, "")}/api/v1/archive?sort=new&limit=25`, { headers: ua });
        const j = r.ok ? await r.json().catch(() => null) : null;
        if (Array.isArray(j) || Array.isArray(j?.posts)) items = parseSubstackArchive(j, s.label, since);
      }
      if (items === null) rep.unfetched.push(s);
      else {
        rep.candidates.push(...items);
        rep.fetched.push({ source: s.label, count: items.length });
      }
    } catch (e) {
      rep.failed.push({ source: s.label, error: String(e).slice(0, 120) });
    }
  }
  return rep;
}

// ---------------------------------------------------------------------------
// Record a collection

export interface MonitorRow extends Candidate {
  page: string; // source/<Title>
}

export async function recordMonitor(
  rows: MonitorRow[],
  opts: { today?: string; seen?: string; processed?: string; lastRun?: string; vault?: string } = {},
): Promise<{ added: MonitorRow[]; skipped: string[]; missing: string[] }> {
  const today = opts.today ?? todayCopenhagen();
  const res = await record(
    rows.map((r) => ({ date: r.date ?? today, time: "00.00", key: r.url, page: r.page })),
    opts.processed ?? PROCESSED,
    opts.vault ?? VAULT,
  );
  const addedKeys = new Set(res.added.map((r) => r.url));
  const seenKeys = new Set((await loadSeen(opts.seen)).map((r) => canonicalUrl(r.url)));
  const added: MonitorRow[] = [];
  for (const r of rows) {
    const key = canonicalUrl(r.url);
    if (!addedKeys.has(key) || seenKeys.has(key)) continue;
    await appendFile(opts.seen ?? MONITOR_SEEN, `${today}\t${r.source}\t${key}\t${r.title.replace(/\t/g, " ")}\n`);
    seenKeys.add(key);
    added.push({ ...r, url: key });
  }
  await Bun.write(opts.lastRun ?? MONITOR_LAST_RUN, `${today}\n`);
  return { added, skipped: res.skipped, missing: res.missing };
}

// ---------------------------------------------------------------------------
// CLI

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "sources") {
    const s = await loadSources();
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    for (const [i, x] of s.entries()) console.log(`${String(i + 1).padStart(3)}  ${x.label.padEnd(36)} ${x.url}`);
    return;
  }
  if (cmd === "status") {
    const last = await lastRun();
    const today = todayCopenhagen();
    const seen = await loadSeen();
    console.log(`last collection: ${last || "never"}\ntoday (Europe/Copenhagen): ${today}\ndue: ${last === today ? "no — already collected today" : "yes"}\nseen rows: ${seen.length}\nwindow: items published after ${last || "(no last run — choose --since)"}`);
    return;
  }
  if (cmd === "fetch") {
    const since = arg("--since") ?? (await lastRun());
    if (!since) throw new Error("no last run; pass --since YYYY-MM-DD");
    const rep = await fetchListings(await loadSources(), since);
    const out = arg("--out");
    if (out) await Bun.write(out, JSON.stringify(rep.candidates, null, 2) + "\n");
    for (const f of rep.fetched) console.log(`${String(f.count).padStart(3)}  ${f.source}`);
    for (const f of rep.failed) console.log(`ERR  ${f.source}: ${f.error}`);
    console.log(`${rep.candidates.length} candidates since ${since}${out ? ` → ${out}` : ""}`);
    console.log(`browser needed for: ${rep.unfetched.map((s) => s.label).join(", ") || "none"}`);
    return;
  }
  if (cmd === "new") {
    const file = process.argv[3];
    if (!file) throw new Error("usage: new <candidates.json> [--out new.json]");
    const cands = JSON.parse(await Bun.file(file).text()) as Candidate[];
    const fresh = filterNew(cands, await knownKeys());
    const out = arg("--out");
    if (out) await Bun.write(out, JSON.stringify(fresh, null, 2) + "\n");
    for (const c of fresh) console.log(`${(c.date ?? "----------").padEnd(10)}  ${c.source.padEnd(30)}  ${c.title.slice(0, 70)}\n${"".padEnd(44)}${c.url}`);
    console.log(`${fresh.length} new of ${cands.length} candidates${out ? ` → ${out}` : ""}`);
    return;
  }
  if (cmd === "record") {
    const file = process.argv[3];
    if (!file) throw new Error('usage: record <rows.json> --note "..." [--no-git]');
    const rows = JSON.parse(await Bun.file(file).text()) as MonitorRow[];
    const note = arg("--note") ?? `${rows.length} new`;
    const res = await recordMonitor(rows);
    await logRun("source-monitor", res.added.length ? "ok" : "no-new-items", res.added.length, note);
    console.log(`monitor: ${res.added.length} recorded, ${res.skipped.length} already known, ${res.missing.length} pages missing`);
    for (const m of res.missing) console.log(`  missing page: ${m}`);
    if (process.argv.includes("--no-git")) return;
    const files = ["pipeline/processed.tsv", "pipeline/monitor-seen.tsv", "pipeline/monitor-last-run.txt", "pipeline/run-log.tsv", ...res.added.map((r) => `${r.page}.md`)];
    const git = await commitAndPush(files, `source monitor: ${res.added.length} new source pages\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`);
    console.log(`git: ${git.detail}`);
    return;
  }
  console.log("usage: bun monitor.ts sources|status|new|record ...");
  process.exit(2);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
