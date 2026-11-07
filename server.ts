// HTTP layer only — all vault logic lives in vault.ts / session.ts / writer.ts.

import { basename } from "node:path";
import { allowedHosts, requestAllowed } from "./guard";
import {
  ALLOWED_HOSTS,
  HOST,
  PORT,
  SCAN_CAP,
  BACKLOG_CHUNK,
  AGING_UNREAD_DAYS,
  AGING_QUEUED_DAYS,
  ACTIVE_TASKS,
  CAPS,
  THESIS_MIN_EVIDENCE,
  COMPASS_DIR,
  VAULT,
} from "./config";
import { scanSource, scanCompass, searchItems, pickerTargets, activeDaysSince, type SourceItem } from "./vault";
import { applyDecision, applyAgingDrop, applyAgingReturn, applyUndo, compassPath, isCompassFile, type Decision } from "./session";
import { setCompassField } from "./writer";
import { journal, logRun, readRunLog, lastUndoSession, recordUndo } from "./journal";
import { pullRebase, commitAndPush } from "./git";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Best-effort git pull, never blocking a request: refreshed in the background,
// last result served.
let gitStatus = { when: "", detail: "not yet pulled" };
let pulling = false;
function refreshGit() {
  if (pulling) return;
  pulling = true;
  pullRebase()
    .then((r) => {
      gitStatus = { when: new Date().toISOString(), detail: r.ok ? "pulled" : `pull failed: ${r.detail.split("\n")[0]}` };
    })
    .finally(() => {
      pulling = false;
    });
}

function itemView(i: SourceItem) {
  return {
    file: i.path,
    name: basename(i.file, ".md"),
    title: i.title,
    type: i.type,
    author: i.author.join(" · "),
    captured: i.captured,
    status: i.status,
    description: i.description ?? "",
    sourceUrl: i.sourceUrl,
    body: i.body,
    pull: i.pull ?? "",
    for: i.for ?? "",
    snapshot: i.snapshot,
  };
}

async function agingCandidates() {
  const { items } = await scanSource();
  const compass = await scanCompass();
  const activeProjects = new Set(
    compass.filter((c) => c.type === "project" && c.status === "active").map((c) => `[[${basename(c.file, ".md")}]]`),
  );
  // Active days = days a session actually looked at the queue (run-log dates are underscored).
  const activeDays = (await readRunLog())
    .filter((r) => ACTIVE_TASKS.has(r.task))
    .map((r) => r.date.replace(/_/g, "-"));
  const age = (i: SourceItem) => activeDaysSince(i.captured, activeDays);
  const drops = items
    .filter((i) => i.status === "unread" && age(i) > AGING_UNREAD_DAYS)
    .map((i) => ({ ...itemView(i), kind: "drop" as const, days: age(i) }));
  const returns = items
    .filter((i) => i.status === "queued" && age(i) > AGING_QUEUED_DAYS && (!i.for || !activeProjects.has(i.for)))
    .map((i) => ({ ...itemView(i), kind: "return" as const, days: age(i) }));
  return [...drops, ...returns];
}

function streakLine(rows: Awaited<ReturnType<typeof readRunLog>>): string {
  const scans = rows.filter((r) => r.task === "scan");
  if (scans.length === 0) return "No scans yet — the first one starts the record.";
  const days = new Set(scans.map((r) => r.date));
  const now = new Date();
  let recent = 0;
  for (let back = 0; back < 7; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    const key = `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}_${String(d.getDate()).padStart(2, "0")}`;
    if (days.has(key)) recent++;
  }
  const last = scans[scans.length - 1];
  return `Scanned ${recent} of the last 7 days · last scan ${last.date.replace(/_/g, "-")} (${last.note}).`;
}

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "GET /api/state": async () => {
    refreshGit();
    const { items, quarantined, skipped } = await scanSource();
    const rows = await readRunLog();
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
    const t = new Date();
    const todayKey = `${t.getFullYear()}_${String(t.getMonth() + 1).padStart(2, "0")}_${String(t.getDate()).padStart(2, "0")}`;
    const monthKey = todayKey.slice(0, 7);
    const daysInMonth = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    const aging = await agingCandidates();
    const undoable = await lastUndoSession();
    return Response.json({
      counts,
      quarantined,
      skippedCount: skipped.length,
      scanDue: (counts.unread ?? 0) > 0 && !rows.some((r) => r.task === "scan" && r.date === todayKey),
      queuedCount: counts.queued ?? 0,
      reviewDue:
        daysInMonth - t.getDate() < 5 && !rows.some((r) => r.task === "review" && r.date.startsWith(monthKey)),
      droppedBacklog: items.filter((i) => i.status === "dropped" && i.closed).length,
      streak: streakLine(rows),
      aging,
      git: gitStatus,
      undoAvailable: undoable.length > 0,
    });
  },

  "GET /api/library": async (req) => {
    const p = new URL(req.url).searchParams;
    const offset = Number(p.get("offset") ?? 0) || 0;
    const { items } = await scanSource();
    const found = searchItems(items, { q: p.get("q") ?? "", status: p.get("status") ?? "", offset });
    return Response.json({
      items: found.items.map(itemView),
      total: found.total,
      offset,
      compass: pickerTargets(await scanCompass()).map((c) => ({
        name: basename(c.file, ".md"),
        type: c.type,
        claim: c.claim ?? "",
        due: c.due ?? "",
      })),
    });
  },

  "POST /api/scan/start": async () => {
    const { items } = await scanSource();
    const compass = await scanCompass();
    const inbox = items
      .filter((i) => i.status === "unread")
      .sort((a, b) => a.captured.localeCompare(b.captured))
      .slice(0, SCAN_CAP)
      .map(itemView);
    await journal({ event: "scan-start", count: inbox.length });
    return Response.json({
      items: inbox,
      compass: pickerTargets(compass).map((c) => ({
        name: basename(c.file, ".md"),
        type: c.type,
        claim: c.claim ?? "",
        due: c.due ?? "",
      })),
      intents: compass.filter((c) => c.type === "intent" && c.status === "active").map((c) => ({ role: c.role, test: c.test })),
    });
  },

  "POST /api/backlog/start": async (req) => {
    const { offset = 0 } = await req.json().catch(() => ({}));
    const { items } = await scanSource();
    const compass = await scanCompass();
    const pool = items
      .filter((i) => i.status === "dropped" && i.closed)
      .sort((a, b) => b.captured.localeCompare(a.captured));
    await journal({ event: "backlog-start", offset, total: pool.length });
    return Response.json({
      total: pool.length,
      offset,
      items: pool.slice(offset, offset + BACKLOG_CHUNK).map(itemView),
      compass: pickerTargets(compass).map((c) => ({
        name: basename(c.file, ".md"),
        type: c.type,
        claim: c.claim ?? "",
        due: c.due ?? "",
      })),
    });
  },

  "POST /api/read/start": async () => {
    const { items } = await scanSource();
    const queued = items
      .filter((i) => i.status === "queued")
      .sort((a, b) => (a.for ?? "").localeCompare(b.for ?? "") || a.captured.localeCompare(b.captured))
      .map(itemView);
    await journal({ event: "read-start", count: queued.length });
    return Response.json({ items: queued });
  },

  "POST /api/journal": async (req) => {
    await journal(await req.json());
    return Response.json({ ok: true });
  },

  "POST /api/commit": async (req) => {
    const { task, decisions } = (await req.json()) as { task: string; decisions: Decision[] };
    const sessionId = new Date().toISOString();
    const results = [];
    for (const d of decisions) results.push(await applyDecision(d, sessionId));
    const okCount = results.filter((r) => r.ok).length;
    const tally: Record<string, number> = {};
    for (let i = 0; i < decisions.length; i++) {
      if (results[i].ok) {
        const a = decisions[i].action === "scanned+yield" ? "scanned" : decisions[i].action;
        tally[a] = (tally[a] ?? 0) + 1;
      }
    }
    const note = Object.entries(tally)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    await logRun(task, results.every((r) => r.ok) ? "ok" : "partial", okCount, note || "none");
    await journal({ event: "commit", task, results });
    const touched = [
      ...results.filter((r) => r.ok).map((r) => r.file),
      ...decisions.filter((d, i) => results[i].ok && d.yield && d.for).map((d) => compassPath(d.for!)),
      `${VAULT}/pipeline/run-log.tsv`,
    ];
    const git = await commitAndPush([...new Set(touched)], `reading-app: ${task} (${decisions.length} items, ${note})`);
    return Response.json({ results, git: git.detail });
  },

  "POST /api/aging": async (req) => {
    const { accepted } = (await req.json()) as {
      accepted: { file: string; kind: "drop" | "return"; snapshot: Record<string, string | undefined> }[];
    };
    const sessionId = new Date().toISOString();
    const results = [];
    for (const a of accepted) {
      results.push(
        a.kind === "drop"
          ? await applyAgingDrop(a.file, a.snapshot, sessionId)
          : await applyAgingReturn(a.file, a.snapshot, sessionId),
      );
    }
    const ok = results.filter((r) => r.ok).length;
    await logRun("aging", results.every((r) => r.ok) ? "ok" : "partial", ok, `dropped:${accepted.filter((a) => a.kind === "drop").length} returned:${accepted.filter((a) => a.kind === "return").length}`);
    const git = await commitAndPush(
      [...results.filter((r) => r.ok).map((r) => r.file), `${VAULT}/pipeline/run-log.tsv`],
      `reading-app: aging (${ok} items)`,
    );
    return Response.json({ results, git: git.detail });
  },

  "POST /api/undo-last": async () => {
    const entries = await lastUndoSession();
    if (entries.length === 0) return Response.json({ results: [], detail: "nothing to undo" });
    const ageMs = Date.now() - new Date(entries[0].session).getTime();
    if (ageMs > 24 * 3600 * 1000) return Response.json({ results: [], detail: "last session is older than 24h" });
    const results = [];
    for (const e of entries) results.push(await applyUndo(e));
    // Mark the undone session so it can't be undone twice: journal a tombstone group.
    await recordUndo([]);
    await logRun("undo", results.every((r) => r.ok) ? "ok" : "partial", results.filter((r) => r.ok).length, `undid session ${entries[0].session}`);
    const git = await commitAndPush(
      [...results.filter((r) => r.ok).map((r) => r.file), `${VAULT}/pipeline/run-log.tsv`],
      `reading-app: undo last session`,
    );
    return Response.json({ results, git: git.detail });
  },

  "POST /api/review/start": async () => {
    const compass = await scanCompass();
    const { items } = await scanSource();
    const active = compass.filter((c) => (c.type === "thesis" || c.type === "project") && c.status === "active");
    const names = new Set(active.map((c) => `[[${basename(c.file, ".md")}]]`));
    const orphans = items
      .filter((i) => i.status === "queued" && i.for && !names.has(i.for))
      .map(itemView);
    const walk = active.map((c) => ({
      file: c.path,
      name: basename(c.file, ".md"),
      type: c.type,
      claim: c.claim ?? "",
      due: c.due ?? "",
      reviewed: c.reviewed ?? "",
      evidenceSinceReview: c.evidence.filter((e) => {
        const m = e.match(/^- (\d{4}-\d{2}-\d{2})/);
        return m && (!c.reviewed || m[1] > c.reviewed);
      }),
      evidenceCount: c.evidence.length,
    }));
    await journal({ event: "review-start", objects: walk.length, orphans: orphans.length });
    return Response.json({
      objects: walk,
      orphans,
      compass: pickerTargets(compass).map((c) => ({ name: basename(c.file, ".md"), type: c.type })),
      caps: CAPS,
      activeCounts: {
        thesis: active.filter((c) => c.type === "thesis").length,
        project: active.filter((c) => c.type === "project").length,
      },
    });
  },

  "POST /api/review/commit": async (req) => {
    const body = (await req.json()) as {
      decisions: { file: string; type: "thesis" | "project"; action: "continue" | "close" | "kill" }[];
      orphans: Decision[];
      mints: { kind: "thesis" | "project"; name: string; claim?: string; due?: string; serves?: string; evidence?: string[] }[];
    };
    const sessionId = new Date().toISOString();
    const results = [];
    const touched: string[] = [];
    const CLOSE: Record<string, string> = { thesis: "dormant", project: "shipped" };
    const KILL: Record<string, string> = { thesis: "killed", project: "abandoned" };
    for (const d of body.decisions ?? []) {
      if (!isCompassFile(d.file)) {
        results.push({ file: d.file, ok: false, detail: "not a compass file" });
        continue;
      }
      let r = await setCompassField(d.file, "reviewed", todayISO());
      if (r.ok && d.action !== "continue") {
        r = await setCompassField(d.file, "status", (d.action === "close" ? CLOSE : KILL)[d.type]);
      }
      results.push({ file: d.file, ok: r.ok, detail: r.ok ? d.action : (r as { reason: string }).reason });
      if (r.ok) touched.push(d.file);
    }
    for (const o of body.orphans ?? []) {
      const r = await applyDecision(o, sessionId);
      results.push(r);
      if (r.ok) touched.push(o.file);
    }
    // Cap-enforced minting — the ONLY place the app creates compass files.
    const compass = await scanCompass();
    for (const m of body.mints ?? []) {
      const activeNow = compass.filter((c) => c.type === m.kind && c.status === "active").length;
      const already = results.filter((r) => r.ok && r.detail === `minted ${m.kind}`).length;
      if (activeNow + already >= CAPS[m.kind]) {
        results.push({ file: m.name, ok: false, detail: `cap reached (${CAPS[m.kind]} active ${m.kind}s)` });
        continue;
      }
      if (m.kind === "thesis" && (m.evidence ?? []).length < THESIS_MIN_EVIDENCE) {
        results.push({ file: m.name, ok: false, detail: `thesis needs ≥${THESIS_MIN_EVIDENCE} pre-existing evidence entries` });
        continue;
      }
      const path = `${COMPASS_DIR}/${m.kind === "thesis" ? "Thesis" : "Project"} - ${m.name}.md`;
      if (!isCompassFile(path)) {
        results.push({ file: m.name, ok: false, detail: "not a valid name" });
        continue;
      }
      if (await Bun.file(path).exists()) {
        results.push({ file: m.name, ok: false, detail: "already exists" });
        continue;
      }
      const content =
        m.kind === "thesis"
          ? `---\ntype: thesis\nclaim: "${(m.claim ?? "").replace(/"/g, '\\"')}"\nstatus: active\nopened: ${todayISO()}\nreviewed: ${todayISO()}\n---\n## Claim\n${m.claim ?? ""} This dies if — (fill in at first review).\n\n## Evidence\n${(m.evidence ?? []).map((e) => (e.startsWith("- ") ? e : `- ${e}`)).join("\n")}\n\n## Tensions\n-\n\n## Snapshots\n-\n`
          : `---\ntype: project\ndue: ${m.due ?? ""}\nserves: "${(m.serves ?? "").replace(/"/g, '\\"')}"\nstatus: active\n---\nWhat shipping looks like: (fill in).\n`;
      await Bun.write(path, content);
      results.push({ file: m.name, ok: true, detail: `minted ${m.kind}` });
      touched.push(path);
    }
    await logRun("review", results.every((r) => r.ok) ? "ok" : "partial", results.filter((r) => r.ok).length, `objects:${(body.decisions ?? []).length} orphans:${(body.orphans ?? []).length} minted:${(body.mints ?? []).length}`);
    await journal({ event: "review-commit", results });
    const git = await commitAndPush([...new Set([...touched, `${VAULT}/pipeline/run-log.tsv`])], `reading-app: review ceremony`);
    return Response.json({ results, git: git.detail });
  },
};

const hosts = allowedHosts(ALLOWED_HOSTS);

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    if (!requestAllowed(req, hosts)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (handler) {
      try {
        return await handler(req);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    const f = Bun.file(`${import.meta.dir}/public${file}`);
    if (await f.exists()) return new Response(f);
    return new Response("not found", { status: 404 });
  },
});

console.log(`reading-queue on http://${HOST}:${server.port} (vault: ${VAULT})`);
