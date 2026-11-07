// The conceptual model of the reading system lives HERE, not in screens.

import { homedir } from "node:os";

export const VAULT = process.env.READING_VAULT ?? `${homedir()}/Documents/vault`;
export const SOURCE_DIR = `${VAULT}/source`;
export const COMPASS_DIR = `${VAULT}/compass`;
export const RUN_LOG = `${VAULT}/pipeline/run-log.tsv`;
export const PROCESSED = `${VAULT}/pipeline/processed.tsv`;
export const JOURNALS_DIR = `${VAULT}/journals`;
/** Where the "Reading capture" Shortcut appends `YYYY-MM-DD HH.mm <url>` lines, one file per device. */
export const CAPTURE_DIR =
  process.env.READING_CAPTURE_DIR ??
  `${homedir()}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents`;
export const APP_DIR = process.env.READING_APP_DIR ?? `${homedir()}/.reading-queue`;
export const PORT = Number(process.env.READING_PORT ?? 4321);
/** Address to listen on. The app has no login, so it is never a public address. */
export const HOST = process.env.READING_HOST ?? "127.0.0.1";
/** Extra names it answers to besides localhost, comma-separated (see guard.ts). */
export const ALLOWED_HOSTS = process.env.READING_ALLOWED_HOSTS ?? "";

// ---- status model (mirrors source/SPEC.md) ----
export const STATUSES = ["unread", "scanned", "queued", "read", "dropped", "fun"] as const;
export type Status = (typeof STATUSES)[number];

// Terminal states. `scanned` is a terminal SUCCESS: the summary was the reading.
export const TERMINAL: ReadonlySet<Status> = new Set(["scanned", "read", "dropped", "fun"]);

// Legal transitions. `dropped → queued|scanned` exists only for backlog-mode rescue;
// `queued → unread` exists only for the aging return.
export const TRANSITIONS: Record<string, Status[]> = {
  unread: ["scanned", "queued", "read", "dropped", "fun"],
  queued: ["read", "dropped", "fun", "unread"],
  dropped: ["queued", "scanned"],
};

// Frontmatter fields the app may write on source items. Everything else is
// owned by the pipeline (at creation) or by Michael (rating).
export const OWNED_FIELDS = ["status", "pull", "yield", "for", "closed"] as const;

// What each transition requires (enforced in the UI and re-checked at commit).
export const REQUIRES = {
  queued: ["pull"], // "what would the full read change?" — honest answers incl. "fun — weekend"
  read: ["yield"], // what it actually gave; appended to the compass target's Evidence
} as const;

// ---- session parameters ----
export const SCAN_CAP = 15; // items per scan session, oldest first
export const BACKLOG_CHUNK = 20; // items per backlog-mode chunk, newest first

// ---- aging rules (executed staged-not-silent on home load) ----
// Ages are counted in *active days*: days with a session that looked at the queue
// (run-log tasks below), not wall-clock days. A vacation or a pause ages nothing.
export const AGING_UNREAD_DAYS = 14; // unread for more active days than this → dropped + closed:
export const AGING_QUEUED_DAYS = 30; // queued longer, without an active project → back to unread
export const ACTIVE_TASKS = new Set(["scan", "backlog", "read"]);

// ---- compass caps (enforced in ceremony flows only) ----
export const CAPS = { intent: 5, thesis: 7, project: 3 } as const;
export const THESIS_MIN_EVIDENCE = 2; // minting requires ≥2 pre-existing evidence entries

// ---- keyboard map (single source of truth; the UI renders from this) ----
export const KEYS = {
  scan: {
    s: "scanned",
    d: "dropped",
    f: "fun",
    q: "queued", // → inline pull line + compass picker
    y: "scanned+yield", // → inline yield line + compass picker (thesis-feeding path)
    u: "undo",
    Escape: "end",
  },
  read: { o: "open", d: "dropped", Enter: "finish", Escape: "end" },
  review: { c: "continue", x: "close", k: "kill", Escape: "end" },
} as const;
