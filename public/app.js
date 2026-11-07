// Reading queue — one-way loop: event → action → update → render.
//
// Architecture rules (the bugs of v1 came from breaking them):
//   1. `state` is the only source of truth. Nothing is stored in the DOM,
//      no render path takes parameters — view(state) is total and idempotent.
//   2. Modes are explicit values, and the prompt is a mode, not an overlay
//      bolted beside the machine.
//   3. keymapFor(state) is the single source of truth for input: the
//      dispatcher consumes it (and preventDefaults exactly what it consumes,
//      so no browser default ever leaks into a freshly-focused input), and
//      the keybar renders from it (hints can never disagree with behavior).
//   4. update(state, action) → [state, effect?] is pure; effects do fetch()
//      and dispatch plain result actions. No fetch touches the DOM.
//
// The pure core (update / view / keymapFor) is exported for headless tests;
// the boot section at the bottom only runs in a browser.

// ---------------------------------------------------------------- helpers

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function md(text) {
  return esc(text)
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, " ")}</p>`)
    .join("");
}

const plain = (wikilink) => String(wikilink ?? "").replace(/\[\[|\]\]/g, "");

// A tappable element: the action travels as data, read back at the boundary.
const act = (action) => `data-action="${esc(JSON.stringify(action))}"`;

// source-url comes from page frontmatter: only ever link to http(s).
const webUrl = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? u : "");
const sourceLink = (item) =>
  webUrl(item?.sourceUrl)
    ? ` · <a class="src" href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="o">original ↗</a>`
    : "";

export const LIB_STATUSES = ["", "unread", "queued", "scanned", "read", "fun", "dropped"];

// The two prompts behind `q` and `y`, shared by scan cards and the library.
const queuePrompt = {
  type: "openPrompt",
  label: "What would the full read change? (honest answers count — “fun — weekend” is valid)",
  withPicker: true,
  then: { type: "stageQueued" },
};
const yieldPrompt = {
  type: "openPrompt",
  label: "One line: what did the summary give you?",
  withPicker: true,
  then: { type: "stageYield" },
};

// Available from nearly every screen. A prompt is a layer over the current mode,
// so sending feedback leaves a session exactly where it was.
const feedback = {
  key: "!",
  label: "feedback",
  action: {
    type: "openPrompt",
    label: "What isn't working, or what would you change?",
    hint: "The screen and item you're on are saved with it.",
    multiline: true,
    then: { type: "sendFeedback" },
  },
};

/** Where the app was when feedback was written, so the note can stay short. */
export function feedbackContext(s) {
  const item =
    s.mode === "card"
      ? s.items[s.idx]
      : s.mode === "review"
        ? s.review?.objects?.[s.reviewIdx]
        : ["readitem", "libitem", "orphan"].includes(s.mode)
          ? s.current
          : null;
  return { screen: s.mode, task: s.mode === "card" || s.mode === "end" ? s.task : undefined, item: item?.name };
}

// A session's decisions live only in memory until commit, and phones reload
// tabs freely. This is the part worth keeping across a reload. Nothing is
// resumed blindly: commit re-checks every item against its snapshot.
const inSession = (s) => s.mode === "card" || s.mode === "end" || ((s.mode === "model" || s.mode === "guide") && (s.modelReturn === "card" || s.modelReturn === "end"));
export function sessionToSave(s) {
  if (!inSession(s) || s.task === "library" || !s.decisions.length) return null;
  const { task, items, idx, decisions, compass, intents, backlogOffset, backlogTotal } = s;
  return { task, items, idx, decisions, compass, intents, backlogOffset, backlogTotal };
}

// Picker selection keys: 0 = none, then one key per compass object. Digits
// first, letters after — a full compass (3 projects + 7 theses) stays reachable.
export const PICK_KEYS = "123456789abcdefghij";
const actionLabel = (a) => ({ "scanned+yield": "scanned + yield", return: "returned" }[a] ?? a);

// ---------------------------------------------------------------- state

export const initialState = {
  mode: "loading", // loading | home | agingview | card | end | committing | done
  //                  readpick | readitem | review | orphan | mint
  //                  library | libitem | neterror | model | guide
  error: "", // last network failure, shown until the next attempt
  notice: "", // a one-time confirmation, gone after the next action
  saved: null, // an unfinished session found after a reload (see sessionToSave)
  lib: { q: "", status: "", items: [], total: 0, req: 0 },
  showTests: true,
  agingHidden: false,
  home: null, // /api/state payload
  task: "scan", // scan | backlog (both use mode "card")
  items: [],
  idx: 0,
  decisions: [], // {item, action, pull?, yield?, for?}
  compass: [],
  intents: [],
  backlogOffset: 0,
  backlogTotal: 0,
  queued: [],
  sel: 0,
  current: null,
  review: null,
  reviewIdx: 0,
  reviewDecisions: [],
  orphanDecisions: [],
  mints: [],
  // prompt: null | {label, placeholder, withPicker, stage:"text"|"pick", text, then}
  //   `then` is a plain action object the prompt completes with — a
  //   continuation as data, never a closure.
  prompt: null,
  result: null, // done screen: {title, lines:[], git}
};

// ---------------------------------------------------------------- effects

// A non-2xx answer is a failure, never data: a screen must not render an error body as if it were state.
const json = (r) =>
  r.ok ? r.json() : r.json().catch(() => ({})).then((b) => Promise.reject(new Error(b.error || `server answered ${r.status}`)));

const post = (path, body) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(json);

const FX = {
  loadHome: () => (d) =>
    fetch("/api/state")
      .then(json)
      .then((data) => d({ type: "homeLoaded", data })),
  startScan: () => (d) => post("/api/scan/start").then((data) => d({ type: "scanLoaded", data })),
  startBacklog: (offset) => (d) => post("/api/backlog/start", { offset }).then((data) => d({ type: "backlogLoaded", data })),
  startRead: () => (d) => post("/api/read/start").then((data) => d({ type: "readLoaded", data })),
  startReview: () => (d) => post("/api/review/start").then((data) => d({ type: "reviewLoaded", data })),
  commit: (task, decisions) => (d) =>
    post("/api/commit", { task, decisions }).then((data) => d({ type: "committed", data })),
  aging: (accepted) => (d) => post("/api/aging", { accepted }).then((data) => d({ type: "agingApplied", data })),
  undoLast: () => (d) => post("/api/undo-last").then((data) => d({ type: "undone", data })),
  reviewCommit: (payload) => (d) => post("/api/review/commit", payload).then((data) => d({ type: "reviewCommitted", data })),
  jot: (event) => () => post("/api/journal", event).catch(() => {}),
  feedback: (text, context) => (d) =>
    post("/api/feedback", { text, ...context })
      .then(() => d({ type: "feedbackSaved" }))
      .catch(() => d({ type: "feedbackFailed", text })),
  library: ({ q, status, req }, offset) => (d) =>
    fetch(`/api/library?${new URLSearchParams({ q, status, offset: String(offset) })}`)
      .then(json)
      .then((data) => d({ type: "libLoaded", data, req })),
};

// ---------------------------------------------------------------- update

const decisionPayload = (d) => ({
  file: d.item.file,
  action: d.action,
  pull: d.pull,
  yield: d.yield,
  for: d.for,
  snapshot: d.item.snapshot,
});

export function update(s, a) {
  if (s.notice && a.type !== "feedbackSaved") s = { ...s, notice: "" };
  switch (a.type) {
    // ---- home ----
    case "loadHome":
      return [{ ...s, mode: "loading", prompt: null, error: "" }, FX.loadHome()];
    case "netError": {
      // Decisions live only in state, so a failed commit goes back to the
      // review screen with all of them intact and can simply be retried.
      const mode = s.mode === "committing" && s.decisions.length ? "end" : s.mode === "loading" || s.mode === "committing" ? "neterror" : s.mode;
      return [{ ...s, mode, error: a.detail ? `The server reported a problem: ${a.detail}` : "Could not reach the server. Nothing was lost; try again." }, null];
    }

    // ---- library (read-only) ----
    case "openLibrary":
    case "libSearch":
    case "libFilter": {
      const status = a.type === "libFilter" ? a.status : s.lib.status;
      const lib = { ...s.lib, status, req: s.lib.req + 1 };
      return [{ ...s, mode: "library", lib, error: "" }, FX.library(lib, 0)];
    }
    case "libMore": {
      const lib = { ...s.lib, req: s.lib.req + 1 };
      return [{ ...s, lib, error: "" }, FX.library(lib, s.lib.items.length)];
    }
    case "libType":
      return [{ ...s, lib: { ...s.lib, q: a.value } }, null];
    case "libLoaded": {
      if (a.req !== s.lib.req) return [s, null]; // a newer search overtook this answer
      const items = a.data.offset > 0 ? [...s.lib.items, ...a.data.items] : a.data.items;
      return [{ ...s, compass: a.data.compass ?? s.compass, lib: { ...s.lib, items, total: a.data.total } }, null];
    }
    case "libOpen": {
      // A one-item session: deciding here goes through the same stage → review
      // → commit path as a scan, so nothing is written without a confirmation.
      const item = s.lib.items[a.index];
      return [{ ...s, mode: "libitem", current: item, task: "library", items: [item], idx: 0, decisions: [], intents: [] }, null];
    }
    case "libBack":
      return [{ ...s, mode: "library", items: [], idx: 0, decisions: [], prompt: null }, null];
    case "homeLoaded":
      return [{ ...s, mode: "home", home: a.data, task: "scan" }, null];
    case "resumeSession": {
      const v = s.saved;
      if (!v) return [s, null];
      return [{ ...s, ...v, saved: null, mode: v.idx < v.items.length ? "card" : "end" }, null];
    }
    case "discardSaved":
      return [{ ...s, saved: null }, null];
    case "go":
      if (a.name === "scan") return [s, FX.startScan()];
      if (a.name === "read") return [s, FX.startRead()];
      if (a.name === "review") return [s, FX.startReview()];
      if (a.name === "backlog") return [s, FX.startBacklog(0)];
      return [s, null];
    case "hideAging":
      return [{ ...s, agingHidden: true }, null];
    case "viewAging":
      return [{ ...s, mode: "agingview" }, null];
    case "acceptAging": {
      const accepted = s.home.aging.map((x) => ({ file: x.file, kind: x.kind, snapshot: x.snapshot }));
      return [{ ...s, mode: "committing" }, FX.aging(accepted)];
    }
    case "agingApplied": {
      const ok = a.data.results.filter((x) => x.ok).length;
      return [
        { ...s, mode: "done", result: { title: `${ok} item${ok === 1 ? "" : "s"} aged out.`, lines: [], git: a.data.git } },
        null,
      ];
    }
    case "undoLast":
      return [{ ...s, mode: "committing" }, FX.undoLast()];
    case "undone": {
      const ok = a.data.results.filter((x) => x.ok).length;
      return [
        {
          ...s,
          mode: "done",
          result: { title: a.data.detail || `${ok} field${ok === 1 ? "" : "s"} restored.`, lines: [], git: a.data.git ?? "" },
        },
        null,
      ];
    }

    // ---- scan / backlog cards ----
    case "scanLoaded":
      if (!a.data.items.length) return [s, FX.loadHome()];
      return [
        {
          ...s,
          mode: "card",
          task: "scan",
          items: a.data.items,
          compass: a.data.compass,
          intents: a.data.intents,
          idx: 0,
          decisions: [],
        },
        FX.jot({ event: "scan-start", count: a.data.items.length }),
      ];
    case "backlogLoaded":
      if (!a.data.items.length) return [s, FX.loadHome()];
      return [
        {
          ...s,
          mode: "card",
          task: "backlog",
          items: a.data.items,
          compass: a.data.compass,
          intents: [],
          backlogOffset: a.data.offset,
          backlogTotal: a.data.total,
          idx: 0,
          decisions: [],
        },
        FX.jot({ event: "backlog-start", offset: a.data.offset }),
      ];
    case "toggleTests":
      return [{ ...s, showTests: !s.showTests }, null];
    case "showModel":
      return [{ ...s, mode: "model", modelReturn: s.mode }, null];
    case "showGuide":
      // Opened from the model, "back" still returns to where the model was opened.
      return [{ ...s, mode: "guide", modelReturn: s.mode === "model" ? s.modelReturn : s.mode }, null];
    case "closeModel":
      return [{ ...s, mode: s.modelReturn ?? "home", modelReturn: null }, null];
    case "sendFeedback":
      return [s, FX.feedback(a.text, feedbackContext(s))];
    case "feedbackSaved":
      return [{ ...s, notice: "Feedback saved." }, null];
    case "feedbackFailed":
      // Never lose what was typed: reopen it, ready to send again.
      return [
        {
          ...s,
          prompt: {
            ...feedback.action,
            label: "Could not save that. The server may be out of reach. Send it again?",
            placeholder: "",
            withPicker: false,
            stage: "text",
            text: a.text,
          },
        },
        null,
      ];
    case "stage": {
      const item = s.items[s.idx];
      const d = { item, action: a.action, pull: a.pull, yield: a.yield, for: a.for };
      const idx = s.idx + 1;
      const next = { ...s, decisions: [...s.decisions, d], idx, prompt: null, saved: null };
      if (idx >= s.items.length) next.mode = "end";
      return [next, FX.jot({ event: "stage", file: item.name, action: a.action })];
    }
    case "skip": {
      // backlog only: leave dropped, no write
      const idx = s.idx + 1;
      return [{ ...s, idx, mode: idx >= s.items.length ? "end" : "card" }, null];
    }
    case "unstage": {
      if (!s.decisions.length) return [s, null];
      const decisions = s.decisions.slice(0, -1);
      const popped = s.decisions[s.decisions.length - 1];
      // By file, not identity: a resumed session's items are fresh objects.
      const idx = s.items.findIndex((i) => i.file === popped.item.file);
      return [{ ...s, decisions, idx, mode: s.task === "library" ? "libitem" : "card" }, FX.jot({ event: "unstage" })];
    }
    case "endSession":
      return s.decisions.length ? [{ ...s, mode: "end" }, null] : [s, FX.loadHome()];
    case "resumeCards":
      return [{ ...s, mode: s.idx < s.items.length ? "card" : "end" }, null];
    case "commit":
      return [{ ...s, mode: "committing", error: "" }, FX.commit(s.task, s.decisions.map(decisionPayload))];
    case "committed": {
      const fails = a.data.results.filter((x) => !x.ok);
      return [
        {
          ...s,
          mode: "done",
          decisions: [],
          result: {
            title: `${a.data.results.length - fails.length} written${fails.length ? `, ${fails.length} skipped` : ""}.`,
            lines: fails.map((f) => `skipped ${f.file.split("/").pop()} — ${f.detail}`),
            git: a.data.git,
          },
        },
        null,
      ];
    }

    // ---- prompt (a mode of the machine; `then` is a continuation-as-data) ----
    case "openPrompt":
      return [
        { ...s, prompt: { label: a.label, hint: a.hint, multiline: !!a.multiline, placeholder: a.placeholder ?? "", withPicker: !!a.withPicker, stage: "text", text: "", then: a.then } },
        null,
      ];
    case "promptSubmit": {
      if (!a.value.trim()) return [s, null];
      const p = s.prompt;
      if (p.withPicker) return [{ ...s, prompt: { ...p, stage: "pick", text: a.value.trim() } }, null];
      return update({ ...s, prompt: null }, { ...p.then, text: a.value.trim(), for: undefined });
    }
    case "promptPick": {
      const p = s.prompt;
      const forName = a.index === 0 ? undefined : s.compass[a.index - 1] ? `[[${s.compass[a.index - 1].name}]]` : null;
      if (forName === null) return [s, null]; // digit out of range
      return update({ ...s, prompt: null }, { ...p.then, text: p.text, for: forName });
    }
    case "promptCancel":
      return [{ ...s, prompt: null }, null];

    // continuations the prompt completes with:
    case "stageQueued":
      return update(s, { type: "stage", action: "queued", pull: a.text, for: a.for });
    case "stageYield":
      return update(s, { type: "stage", action: "scanned+yield", yield: a.text, for: a.for });
    case "finishReadWithYield":
      return [
        { ...s, mode: "committing" },
        FX.commit("read", [
          { file: s.current.file, action: "read", yield: a.text, for: s.current.for || undefined, snapshot: s.current.snapshot },
        ]),
      ];
    case "orphanReassigned": {
      const o = s.current;
      const done = [...s.orphanDecisions, { file: o.file, action: "queued", pull: a.text, for: a.for, snapshot: o.snapshot }];
      return nextOrphan({ ...s, orphanDecisions: done });
    }

    // ---- read ----
    case "readLoaded":
      if (!a.data.items.length) return [s, FX.loadHome()];
      return [{ ...s, mode: "readpick", queued: a.data.items, sel: 0 }, null];
    case "readSel":
      return [{ ...s, sel: Math.max(0, Math.min(s.queued.length - 1, s.sel + a.delta)) }, null];
    case "readOpen":
      return [{ ...s, mode: "readitem", current: s.queued[s.sel] }, null];
    case "readOpenAt":
      return [{ ...s, mode: "readitem", sel: a.index, current: s.queued[a.index] }, null];
    case "readBack":
      return [{ ...s, mode: "readpick" }, null];
    case "openSource": {
      const url = webUrl((s.mode === "card" ? s.items[s.idx] : s.current)?.sourceUrl);
      return [s, () => url && window.open(url, "_blank", "noopener")];
    }
    case "dropAfterReading":
      return [
        { ...s, mode: "committing" },
        FX.commit("read", [{ file: s.current.file, action: "dropped", snapshot: s.current.snapshot }]),
      ];

    // ---- review ceremony ----
    case "reviewLoaded":
      if (!a.data.objects.length) return [s, FX.loadHome()];
      return [
        { ...s, mode: "review", review: a.data, compass: a.data.compass, reviewIdx: 0, reviewDecisions: [], orphanDecisions: [], mints: [] },
        null,
      ];
    case "verdict": {
      const o = s.review.objects[s.reviewIdx];
      const reviewDecisions = [...s.reviewDecisions, { file: o.file, type: o.type, action: a.action }];
      const reviewIdx = s.reviewIdx + 1;
      const next = { ...s, reviewDecisions, reviewIdx };
      if (reviewIdx >= s.review.objects.length) return nextOrphan(next);
      return [next, null];
    }
    case "toOrphans":
      return nextOrphan(s);
    case "orphanReturn": {
      const o = s.current;
      const done = [...s.orphanDecisions, { file: o.file, action: "return", snapshot: o.snapshot }];
      return nextOrphan({ ...s, orphanDecisions: done });
    }
    case "toMint":
      return [{ ...s, mode: "mint" }, null];
    case "reviewCommit": {
      const mints = a.mint && a.mint.name ? [...s.mints, a.mint] : s.mints;
      return [
        { ...s, mode: "committing", mints },
        FX.reviewCommit({ decisions: s.reviewDecisions, orphans: s.orphanDecisions, mints }),
      ];
    }
    case "reviewCommitted": {
      const fails = a.data.results.filter((x) => !x.ok);
      return [
        {
          ...s,
          mode: "done",
          result: {
            title: `Ceremony: ${a.data.results.length - fails.length} applied${fails.length ? `, ${fails.length} refused` : ""}.`,
            lines: fails.map((f) => `${String(f.file).split("/").pop()} — ${f.detail}`),
            git: a.data.git,
          },
        },
        null,
      ];
    }

    default:
      return [s, null];
  }
}

function nextOrphan(s) {
  const pending = (s.review?.orphans ?? []).filter((o) => !s.orphanDecisions.some((d) => d.file === o.file));
  if (!pending.length) return [{ ...s, mode: "mint" }, null];
  return [{ ...s, mode: "orphan", current: pending[0] }, null];
}

// ---------------------------------------------------------------- keymaps
// One table per state; consumed by BOTH the dispatcher and the keybar.
// `action` may be a plain object or (state, domRead) => action, where domRead
// gives the boundary controlled access to input values.

export function keymapFor(s) {
  if (s.prompt) {
    const p = s.prompt;
    if (p.stage === "text") {
      return [
        { key: "Enter", label: p.withPicker ? "next: pick target" : p.multiline ? "send" : "confirm", action: (_s, dom) => ({ type: "promptSubmit", value: dom.inputValue("#prompt-input") }) },
        { key: "Escape", label: "cancel", action: { type: "promptCancel" } },
        // every other key falls through to the input — by design
      ];
    }
    return [
      { key: "0", hidden: true, action: { type: "promptPick", index: 0 } },
      ...s.compass.map((_, i) => ({ key: PICK_KEYS[i], hidden: true, action: { type: "promptPick", index: i + 1 } })),
      { key: `1–${PICK_KEYS[Math.max(0, s.compass.length - 1)] ?? "9"}`, label: "pick (0 = none)", display: true },
      { key: "Escape", label: "cancel", action: { type: "promptCancel" } },
    ];
  }
  switch (s.mode) {
    case "home": {
      const agingActive = (s.home?.aging?.length ?? 0) > 0 && !s.agingHidden;
      return [
        ...(s.saved
          ? [
              { key: "c", label: "resume session", action: { type: "resumeSession" } },
              { key: "x", label: "discard it", action: { type: "discardSaved" } },
            ]
          : []),
        ...(agingActive
          ? [
              { key: "a", label: "accept aging", action: { type: "acceptAging" } },
              { key: "v", label: "view aging", action: { type: "viewAging" } },
              { key: "i", label: "ignore", action: { type: "hideAging" } },
            ]
          : [{ key: "v", label: "review", action: { type: "go", name: "review" } }]),
        { key: "s", label: "scan", action: { type: "go", name: "scan" } },
        { key: "r", label: "read", action: { type: "go", name: "read" } },
        { key: "l", label: "library", action: { type: "openLibrary" } },
        ...(s.home?.droppedBacklog ? [{ key: "b", label: "backlog", action: { type: "go", name: "backlog" } }] : []),
        ...(s.home?.undoAvailable ? [{ key: "U", label: "undo last session", action: { type: "undoLast" } }] : []),
        { key: "m", label: "the model", action: { type: "showModel" } },
        { key: "g", hidden: true, action: { type: "showGuide" } },
        feedback,
      ];
    }
    case "model":
      return [
        { key: "g", label: "user guide", action: { type: "showGuide" } },
        feedback,
        { key: "Escape", label: "back", action: { type: "closeModel" } },
      ];
    case "guide":
      return [feedback, { key: "Escape", label: "back", action: { type: "closeModel" } }];
    case "library":
      return [
        { key: "Enter", label: "search", action: { type: "libSearch" } },
        feedback,
        { key: "Escape", label: "home", action: { type: "loadHome" } },
      ];
    case "libitem": {
      // Only what the status model allows from here (TRANSITIONS in config.ts).
      const st = s.current?.status;
      const scanned = { key: "s", label: "scanned", action: { type: "stage", action: "scanned" } };
      const drop = { key: "d", label: "drop", action: { type: "stage", action: "dropped" } };
      const fun = { key: "f", label: "fun", action: { type: "stage", action: "fun" } };
      const queue = { key: "q", label: "queue", action: queuePrompt };
      const yieldIt = { key: "y", label: "yield", action: yieldPrompt };
      const moves = st === "unread" ? [scanned, drop, fun, queue, yieldIt] : st === "queued" ? [drop, fun] : st === "dropped" ? [scanned, queue, yieldIt] : [];
      return [
        ...moves,
        { key: "o", hidden: true, action: { type: "openSource" } },
        feedback,
        { key: "Escape", label: "back", action: { type: "libBack" } },
      ];
    }
    case "neterror":
      return [{ key: "Enter", label: "try again", action: { type: "loadHome" } }];
    case "agingview":
      return [
        { key: "Enter", label: "accept all", action: { type: "acceptAging" } },
        feedback,
        { key: "Escape", label: "back", action: { type: "loadHome" } },
      ];
    case "card": {
      const backlog = s.task === "backlog";
      return [
        { key: "s", label: backlog ? "rescue as scanned" : "scanned", action: { type: "stage", action: "scanned" } },
        backlog
          ? { key: "d", label: "leave dropped", action: { type: "skip" } }
          : { key: "d", label: "drop", action: { type: "stage", action: "dropped" } },
        ...(backlog ? [] : [{ key: "f", label: "fun", action: { type: "stage", action: "fun" } }]),
        { key: "q", label: backlog ? "rescue to queue" : "queue", action: queuePrompt },
        { key: "y", label: backlog ? "rescue + yield" : "yield", action: yieldPrompt },
        { key: "o", hidden: true, action: { type: "openSource" } },
        { key: "u", label: "undo", action: { type: "unstage" } },
        { key: "?", label: s.showTests ? "hide lenses" : "show lenses", action: { type: "toggleTests" } },
        { key: "m", label: "model", action: { type: "showModel" } },
        { key: "g", hidden: true, action: { type: "showGuide" } },
        feedback,
        { key: "Escape", label: "end", action: { type: "endSession" } },
      ];
    }
    case "end":
      return [
        { key: "Enter", label: "commit", action: { type: "commit" } },
        { key: "u", label: "remove last", action: { type: "unstage" } },
        feedback,
        s.task === "library"
          ? { key: "Escape", label: "cancel", action: { type: "libBack" } }
          : {
              key: "Escape",
              label: s.idx < s.items.length ? "back to scanning" : "discard & home",
              action: s.idx < s.items.length ? { type: "resumeCards" } : { type: "loadHome" },
            },
      ];
    case "readpick":
      return [
        { key: "j", label: "down", action: { type: "readSel", delta: 1 } },
        { key: "ArrowDown", hidden: true, action: { type: "readSel", delta: 1 } },
        { key: "k", label: "up", action: { type: "readSel", delta: -1 } },
        { key: "ArrowUp", hidden: true, action: { type: "readSel", delta: -1 } },
        { key: "Enter", label: "open", action: { type: "readOpen" } },
        { key: "m", label: "model", action: { type: "showModel" } },
        { key: "g", hidden: true, action: { type: "showGuide" } },
        feedback,
        { key: "Escape", label: "home", action: { type: "loadHome" } },
      ];
    case "readitem":
      return [
        { key: "o", label: "open source", action: { type: "openSource" } },
        {
          key: "Enter",
          label: "finished — write the yield",
          action: (st) => ({
            type: "openPrompt",
            label: `What did it actually give you? ${st.current.for ? `(filed to ${plain(st.current.for)})` : ""}`,
            withPicker: false,
            then: { type: "finishReadWithYield" },
          }),
        },
        { key: "d", label: "drop after reading", action: { type: "dropAfterReading" } },
        feedback,
        { key: "Escape", label: "back", action: { type: "readBack" } },
      ];
    case "review":
      return [
        { key: "c", label: "continue", action: { type: "verdict", action: "continue" } },
        { key: "x", label: "close", action: { type: "verdict", action: "close" } },
        { key: "k", label: "kill", action: { type: "verdict", action: "kill" } },
        feedback,
        { key: "Escape", label: "end review", action: { type: "loadHome" } },
      ];
    case "orphan":
      return [
        {
          key: "r",
          label: "reassign",
          action: (st) => ({
            type: "openPrompt",
            label: "Reassign — keep or rewrite the pull line, then pick the new object",
            placeholder: st.current.pull,
            withPicker: true,
            then: { type: "orphanReassigned" },
          }),
        },
        { key: "i", label: "return to inbox", action: { type: "orphanReturn" } },
        feedback,
        { key: "Escape", label: "skip to minting", action: { type: "toMint" } },
      ];
    case "mint":
      return [
        {
          key: "Enter",
          label: "commit ceremony",
          action: (_s, dom) => ({
            type: "reviewCommit",
            mint: {
              kind: "project",
              name: dom.inputValue("#m-name").trim(),
              due: dom.inputValue("#m-due").trim(),
              serves: dom.inputValue("#m-serves").trim()
                ? `[[Thesis - ${dom.inputValue("#m-serves").trim().replace(/^Thesis - /, "")}]]`
                : "",
            },
          }),
        },
        { key: "Escape", label: "commit without minting", action: { type: "reviewCommit" } },
      ];
    case "done":
      return s.task === "library"
        ? [{ key: "Enter", label: "back to library", action: { type: "openLibrary" } }, feedback]
        : [{ key: "Enter", label: "home", action: { type: "loadHome" } }, feedback];
    default:
      return [];
  }
}

// ---------------------------------------------------------------- view

// Rendered from the keymap, so a tap and a keystroke are the same binding.
const keybar = (bindings) =>
  `<div class="keybar">${bindings
    .filter((b) => b.label)
    .map((b) => {
      const cap = `<kbd>${esc(b.key === "Escape" ? "esc" : b.key === "Enter" ? "enter" : b.key)}</kbd>`;
      return b.action
        ? `<button type="button" class="keybtn${b.key === "Enter" ? " primary" : ""}" data-key="${esc(b.key)}">${cap} ${esc(b.label)}</button>`
        : `<span class="keyhint">${cap} ${esc(b.label)}</span>`;
    })
    .join("")}</div>`;

function promptView(s) {
  const p = s.prompt;
  if (!p) return "";
  const picker =
    p.withPicker && p.stage === "pick"
      ? `<div class="hint" style="margin-top:14px">Optional: what does this serve? A <em>project</em> is a dated commitment,
         a <em>thesis</em> is a running bet — your yield lines get filed into its Evidence.
         These live as plain files in the vault's <code>compass/</code> folder. Choosing none is a fine answer.</div>
        <ol>${[{ name: "(no compass object — just queue it)", type: "" }, ...s.compass]
          .map(
            (c, i) => `<li><button type="button" class="pickrow" ${act({ type: "promptPick", index: i })}><span class="n">${i === 0 ? "0" : PICK_KEYS[i - 1]}</span>${esc(c.name.replace(/^(Thesis|Project) - /, ""))}${c.type ? ` <span class="quiet">· ${c.type}${c.due ? `, due ${esc(c.due)}` : ""}</span>` : ""}
            ${c.claim ? `<br /><span class="quiet" style="font-size:0.82rem;font-style:italic;padding-left:1.6em">${esc(c.claim)}</span>` : ""}</button></li>`,
          )
          .join("")}</ol>`
      : "";
  const field = p.multiline
    ? `<textarea id="prompt-input" rows="5" enterkeyhint="send">${esc(p.text)}</textarea>`
    : `<input id="prompt-input" type="text" enterkeyhint="done" placeholder="${esc(p.placeholder)}" value="${esc(p.text)}" ${p.stage === "pick" ? "disabled" : ""} />`;
  return `<div class="overlay"><div class="prompt">
    <label>${esc(p.label)}</label>
    ${field}
    ${p.hint ? `<div class="hint">${esc(p.hint)}</div>` : ""}
    ${picker}
    ${keybar(keymapFor(s))}
  </div></div>`;
}

function homeView(s) {
  const st = s.home;
  const inbox = st.counts.unread ?? 0;
  const agingActive = st.aging.length > 0 && !s.agingHidden;
  return `
    <div class="eyebrow">READING · ${esc(s.today ?? "")}</div>
    ${st.quarantined.length ? `<div class="banner warn">${st.quarantined.length} file(s) quarantined with merge-conflict markers: ${st.quarantined.map(esc).join(", ")}. Resolve in git before they rejoin the queue.</div>` : ""}
    ${s.saved ? `<button class="due" ${act({ type: "resumeSession" })}>Resume your unfinished session — ${s.saved.decisions.length} decided, not yet written.<span class="k">c</span></button>` : ""}
    ${agingActive ? `<div class="banner">${st.aging.length} item${st.aging.length > 1 ? "s" : ""} aged out under the 14/30 active-day rule.</div>` : ""}
    <button class="due ${st.scanDue ? "" : "dim"}" data-action='{"type":"go","name":"scan"}'>
      ${st.scanDue ? `Scan the inbox — ${inbox} item${inbox === 1 ? "" : "s"} waiting, oldest first.` : inbox > 0 ? `Inbox scanned today. ${inbox} remain for tomorrow.` : "Inbox is empty."}
      <span class="k">s</span></button>
    <button class="due ${st.queuedCount ? "" : "dim"}" data-action='{"type":"go","name":"read"}'>
      ${st.queuedCount ? `Read — ${st.queuedCount} pulled item${st.queuedCount === 1 ? "" : "s"} waiting.` : "Nothing queued for deep reading. That is the system working."}
      <span class="k">r</span></button>
    <button class="due ${st.reviewDue ? "" : "dim"}" data-action='{"type":"go","name":"review"}'>
      ${st.reviewDue ? "Monthly review is due — walk the compass before the month ends." : "Monthly review — at month's end."}
      <span class="k">v</span></button>
    <button class="due" data-action='{"type":"openLibrary"}'>Library — search and browse everything.<span class="k">l</span></button>
    ${st.droppedBacklog ? `<button class="due dim" data-action='{"type":"go","name":"backlog"}'>Backlog — ${st.droppedBacklog} amnestied items, browsable when curiosity strikes. Optional, finite.<span class="k">b</span></button>` : ""}
    <button class="due dim" data-action='{"type":"showGuide"}'>Guide — what this is and how to use it.<span class="k">g</span></button>
    <div class="homeline">${esc(st.streak)}</div>
    <div class="homeline quiet" style="font-size:0.8rem">git: ${esc(st.git.detail)}</div>`;
}

function cardView(s) {
  const it = s.items[s.idx];
  const n = s.idx + 1;
  const where = s.task === "backlog" ? `backlog · ${s.backlogOffset + n} of ${s.backlogTotal}` : `${n} of ${s.items.length}`;
  return `
    <div class="progress">${esc(where)}</div>
    <h1>${esc(it.title)}</h1>
    <div class="meta">${esc(it.author || "—")} · ${esc(it.captured)} · ${esc(it.type)}${sourceLink(it)}</div>
    <div class="body">${md(it.body)}</div>
    ${s.showTests && s.intents.length ? `<ul class="tests">${s.intents.map((t) => `<li>${esc(t.test)}</li>`).join("")}</ul>` : ""}`;
}

function endView(s) {
  const n = s.decisions.length;
  const tally = {};
  for (const d of s.decisions) {
    const k = d.action === "scanned+yield" ? "scanned" : d.action;
    tally[k] = (tally[k] ?? 0) + 1;
  }
  const bits = Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ");
  const dropped = tally.dropped ?? 0;
  const stat = dropped > 0 ? `Dropped ${dropped} of ${n} — healthy. The scan is the reading.` : `${n} decided. The scan is the reading.`;
  return `
    <div class="eyebrow">SESSION REVIEW — nothing written yet</div>
    <ul class="decisions">${s.decisions
      .map(
        (d) => `<li><span class="act act-${d.action.split("+")[0]}">${actionLabel(d.action)}</span>
        <span>${esc(d.item.title)}</span>
        ${d.pull ? `<span class="note">pull: ${esc(d.pull)}</span>` : ""}
        ${d.yield ? `<span class="note">yield: ${esc(d.yield)}</span>` : ""}
        ${d.for ? `<span class="note">→ ${esc(plain(d.for))}</span>` : ""}</li>`,
      )
      .join("")}</ul>
    <div class="stat">${esc(stat)} <span class="quiet">(${esc(bits)})</span></div>`;
}

function readPickView(s) {
  let lastFor = " ";
  const rows = s.queued
    .map((q, i) => {
      const head = q.for !== lastFor ? `<span class="for">${esc(q.for ? plain(q.for) : "unassigned")}</span>` : "";
      lastFor = q.for;
      return `${head}<li class="${i === s.sel ? "sel" : ""}"><button type="button" class="pickrow" ${act({ type: "readOpenAt", index: i })}>${esc(q.title)}<br /><span class="pull">${esc(q.pull || "no pull line — a debt")}</span></button></li>`;
    })
    .join("");
  return `<div class="eyebrow">READ — pulled items, grouped by what pulls them</div><ul class="pick">${rows}</ul>`;
}

function readItemView(s) {
  const q = s.current;
  return `
    <div class="pull-head"><span class="quiet">YOU WANTED</span>${esc(q.pull || "(no pull line was recorded)")}</div>
    <h1 style="font-size:1.2rem">${esc(q.title)}</h1>
    <div class="meta">${esc(q.author || "—")} · ${esc(q.captured)}${q.for ? ` · for ${esc(plain(q.for))}` : ""}${sourceLink(q)}</div>
    <div class="body">${md(q.body)}</div>`;
}

function libraryView(s) {
  const { q, status, items, total } = s.lib;
  const chips = LIB_STATUSES.map(
    (st) => `<button type="button" class="chip${st === status ? " on" : ""}" ${act({ type: "libFilter", status: st })}>${st || "all"}</button>`,
  ).join("");
  const rows = items
    .map(
      (it, i) => `<li><button type="button" class="librow" ${act({ type: "libOpen", index: i })}>
        <span class="libtitle">${esc(it.title)}</span>
        <span class="libmeta">${esc(it.author || "—")} · ${esc(it.captured)} · ${esc(it.status)}</span>
        ${it.description ? `<span class="libdesc">${esc(it.description)}</span>` : ""}
      </button></li>`,
    )
    .join("");
  return `
    <div class="eyebrow">LIBRARY · ${total} item${total === 1 ? "" : "s"}</div>
    <input id="lib-q" class="libsearch" type="search" enterkeyhint="search" autocomplete="off" placeholder="Search titles, authors, summaries" value="${esc(q)}" />
    <div class="chips">${chips}</div>
    <ul class="lib">${rows}</ul>
    ${items.length < total ? `<button type="button" class="due dim" ${act({ type: "libMore" })}>Show more (${total - items.length} left)</button>` : ""}`;
}

function libItemView(s) {
  const it = s.current;
  return `
    <div class="eyebrow">LIBRARY · ${esc(it.status)}</div>
    <h1>${esc(it.title)}</h1>
    <div class="meta">${esc(it.author || "—")} · ${esc(it.captured)} · ${esc(it.type)}${sourceLink(it)}</div>
    <div class="body">${md(it.body)}</div>`;
}

function reviewView(s) {
  const o = s.review.objects[s.reviewIdx];
  return `
    <div class="eyebrow">REVIEW · ${s.reviewIdx + 1} of ${s.review.objects.length} · ${esc(o.type)}</div>
    <h1>${esc(o.name.replace(/^(Thesis|Project) - /, ""))}</h1>
    <div class="meta">${o.due ? `due ${esc(o.due)} · ` : ""}last reviewed ${esc(o.reviewed || "never")} · ${o.evidenceCount} evidence total</div>
    ${o.claim ? `<div class="body"><p><em>${esc(o.claim)}</em></p></div>` : ""}
    ${
      o.evidenceSinceReview.length
        ? `<div class="meta" style="margin-top:1rem">since last review:</div>` +
          o.evidenceSinceReview.map((e) => `<div class="evline">${esc(e)}</div>`).join("")
        : `<div class="evline">No new evidence since last review — is this bet still alive?</div>`
    }`;
}

function orphanView(s) {
  const o = s.current;
  const pending = s.review.orphans.filter((x) => !s.orphanDecisions.some((d) => d.file === x.file)).length;
  return `
    <div class="eyebrow">ORPHANS — queued items whose project/thesis is gone (${pending} left)</div>
    <h1 style="font-size:1.3rem">${esc(o.title)}</h1>
    <div class="meta">was queued for ${esc(plain(o.for))}</div>
    <div class="body"><p class="quiet">${esc(o.pull || "")}</p></div>`;
}

function mintView(s) {
  const { caps, activeCounts } = s.review;
  return `
    <div class="eyebrow">MINTING — next month's bets (theses ${activeCounts.thesis}/${caps.thesis}, projects ${activeCounts.project}/${caps.project})</div>
    <div class="prompt mintform" style="width:100%">
      <label>Mint next month's project (leave name empty to skip)</label>
      <input id="m-name" placeholder="project name, e.g. Sep essay How judgment develops" />
      <input id="m-due" placeholder="due YYYY-MM-DD" />
      <input id="m-serves" placeholder="serves (thesis name, optional)" />
    </div>
    <div class="homeline">${s.reviewDecisions.length} verdicts + ${s.orphanDecisions.length} orphan decisions staged.</div>`;
}

function modelView() {
  return `<div class="model">
    <div class="eyebrow">THE MODEL — how to see with this system</div>

    <h2>The inversion</h2>
    <p>Twenty years of reading systems failed the same way: every interesting item got an
    aspiration attached at capture time, so no aspiration meant anything. This system inverts
    that. <strong>Objects are minted top-down at ceremonies, never at item time</strong> —
    an article can <em>feed</em> a bet, it can never <em>create</em> one. And
    <strong>the scan is the reading</strong>: for most items the summary is all the value
    there is, so <em>scanned</em> is a terminal success, not a guilty pending state.</p>

    <h2>Three kinds of object</h2>
    <p><span class="lamp">Intent — a question.</span> A lens derived from a role you actually hold.
    It has no truth value: it can't be wrong, only useful or dead. It turns "is this
    interesting?" (everything is — that's the trap) into "is this relevant <em>to me-as-this-role</em>?"
    It accumulates nothing. It filters. The lenses under each card are your five intents.</p>
    <p><span class="lamp">Thesis — a claim.</span> A falsifiable bet about the world. It must be able
    to be embarrassed — every thesis carries a "<em>this dies if…</em>" sentence, and one that can't
    die is a slogan, which gets killed. Theses accumulate evidence (your yield lines land in them),
    collect tensions, and are snapshotted into essays. They are where reading compounds.</p>
    <p><span class="lamp">Project — a promise.</span> A dated commitment with a real deliverable.
    Projects are the <strong>only</strong> objects allowed to pull deep reads — a deadline may
    demand your time; a question or a belief may not. Zero active projects is a valid, honest state.</p>
    <p class="quiet">Perceive → believe → act. Intents sense, theses know, projects do.</p>

    <h2>Pace layers: 5 · 7 · 3</h2>
    <p>The caps price attention on different clocks. An intent <strong>bills you daily</strong> —
    every lens is a question asked of every summary, so five is already ~45 micro-judgments a
    morning. A thesis <strong>bills you monthly</strong> — holding a bet is cheap, but each needs
    enough evidence flow to stay honestly alive, so seven at most. A project <strong>bills you in
    weeks of your life</strong>, so three, and minting a fourth means admitting one of three dies.
    Intents change on the scale of years, theses months, projects weeks: the slower the layer,
    the smaller and more stable. The integers are honest guesses; the zero-sum caps are the principle.</p>

    <h2>The words at the gates</h2>
    <p><span class="lamp">pull</span> — required to queue anything: <em>"what would the full read
    change?"</em> If you can't answer, the summary already gave you everything. Honest
    non-instrumental answers ("fun — weekend") are valid.</p>
    <p><span class="lamp">yield</span> — required to finish a read, optional after a scan:
    <em>"what did it actually give you?"</em> One line, filed automatically into the Evidence of
    the object it served. The yield is where a read becomes part of a bet instead of a memory.</p>

    <h2>The six statuses</h2>
    <p><span class="act-scanned">scanned</span> — the summary was the reading. Success, done. ·
    <span class="act-fun">fun</span> — read for pleasure, no justification owed. ·
    <span class="act-dropped">dropped</span> — not for you, or aged out (amnesty, not failure —
    files stay searchable, rescuable from the backlog). ·
    <span class="act-queued">queued</span> — a pull line earned it a future deep read. ·
    <span class="act-queued">read</span> — deep-read, yield filed. ·
    unread — merely not yet decided.</p>

    <h2>Where it all lives</h2>
    <p>Every object is a plain markdown file in the vault's <code>compass/</code> folder — no
    machinery, readable in Obsidian, editable by hand. The monthly review ceremony (<kbd>v</kbd>
    from home) is where bets are continued, killed, or minted, and the only place minting happens.</p>
  </div>`;
}

// Keys are written next to the button's label because touch screens hide <kbd>:
// the sentence has to read correctly either way.
function guideView() {
  return `<div class="model guide">
    <div class="eyebrow">GUIDE — what this is and how to use it</div>

    <h2>What this is</h2>
    <p>This app is where you decide what the things you save deserve. Links you capture, and
    new posts from the sources you follow, become short summary pages in your vault. The app
    shows you those summaries and asks for a decision on each.</p>
    <p><strong>The scan is the reading.</strong> For most items the summary is all the value
    there is, so marking one <span class="act-scanned">scanned</span> is a success, not a
    postponement. A few items earn a deep read, and for those you say what the read would
    change. Dropping loses nothing, because every page stays searchable.</p>
    <p class="quiet">This guide covers how to use the app. <em>The model</em>, on the home
    screen, covers why it works this way.</p>

    <h2>The rhythm</h2>
    <ul>
      <li><strong>Daily:</strong> scan the inbox, at most 15 items, oldest first.</li>
      <li><strong>When you have time:</strong> read something you queued.</li>
      <li><strong>In the last five days of the month:</strong> do the monthly review.</li>
      <li><strong>Any time:</strong> search the library, or browse the backlog if you're curious.</li>
    </ul>
    <p>The home screen shows what's due. A dimmed row just means nothing is pressing, and you
    can still open it. On a keyboard, every action has the key shown beside it. On a touch
    screen, use the buttons at the bottom.</p>

    <h2>Scan</h2>
    <p>You get one card at a time. Decide from the summary:</p>
    <ul class="keys">
      <li><kbd>s</kbd> <strong>scanned</strong>: the summary was enough. This is the usual answer.</li>
      <li><kbd>d</kbd> <strong>drop</strong>: not for you.</li>
      <li><kbd>f</kbd> <strong>fun</strong>: it's for pleasure, and you owe no justification.</li>
      <li><kbd>q</kbd> <strong>queue</strong>: worth a deep read. You must answer “what would the
      full read change?”. “Fun — weekend” is a valid answer.</li>
      <li><kbd>y</kbd> <strong>yield</strong>: scanned, and the summary gave you something worth
      keeping. Write it in one line.</li>
      <li><kbd>u</kbd> <strong>undo</strong>: take back your last decision.</li>
      <li><kbd>esc</kbd> <strong>end</strong>: stop early and go to the session review.</li>
    </ul>
    <p>Queue and yield then offer a list of your projects and theses. Choosing one is optional.
    A yield line is added to the Evidence of whichever you choose.</p>
    <p>To see the full piece, tap “original” on the card, or press <code>o</code> on a keyboard.
    The questions under the card are your lenses. The “hide lenses” button hides them, or
    <code>?</code> on a keyboard.</p>

    <h2>Session review: when things are saved</h2>
    <p><strong>A scan writes nothing until you confirm it.</strong> The session review lists your
    decisions, and <kbd>enter</kbd> <strong>commit</strong> saves them. If the page reloads,
    which phones do often, the home screen offers to resume your session.</p>

    <h2>Read</h2>
    <p>Queued items are grouped by what they serve. Opening one shows the reason you gave at
    the top, so you read with that question in mind.</p>
    <ul class="keys">
      <li><kbd>o</kbd> <strong>open source</strong>: go to the original.</li>
      <li><kbd>enter</kbd> <strong>finished</strong>: write what it actually gave you. This is
      required, and it goes into the Evidence of the project or thesis the item serves.</li>
      <li><kbd>d</kbd> <strong>drop after reading</strong>: it wasn't worth keeping.</li>
    </ul>
    <p><strong>These are saved immediately</strong>, with no session review.</p>

    <h2>Library</h2>
    <p>Search titles, authors and summaries, and filter by status. Browsing changes nothing. You
    can also decide on an item from here, which goes through the session review like a scan. Which
    decisions are offered depends on the item's status: finished items offer none. Library
    decisions don't count as an active day.</p>

    <h2>Backlog</h2>
    <p>Items that were dropped in an amnesty or aged out, 20 at a time, newest first. It's
    optional and has an end. <strong>Leave dropped</strong> writes nothing. The other choices
    rescue an item: as scanned, to the queue, or with a yield.</p>

    <h2>Monthly review</h2>
    <p>You walk through each active thesis and project, seeing the evidence added since the last
    review, and give a verdict:</p>
    <ul class="keys">
      <li><kbd>c</kbd> <strong>continue</strong>: keep it going.</li>
      <li><kbd>x</kbd> <strong>close</strong>: a thesis goes dormant, a project is shipped.</li>
      <li><kbd>k</kbd> <strong>kill</strong>: a thesis is killed, a project is abandoned.</li>
    </ul>
    <p>Queued items whose project or thesis is gone come next: reassign them or return them to the
    inbox. Last, you can create next month's project, up to the limit of three active. Nothing is
    saved until the final commit, so ending the review early discards it. With no active thesis
    or project, there's nothing to walk through, and the review goes straight back home.</p>

    <h2>Aging</h2>
    <p>Items you never decide on age out, but never silently. The home screen tells you and waits:</p>
    <ul>
      <li><strong>Unread</strong> for more than 14 active days: dropped.</li>
      <li><strong>Queued</strong> for more than 30 active days, without an active project: back to the inbox.</li>
    </ul>
    <p>An <em>active day</em> is a day you ran a scan, backlog or read session, so a holiday ages
    nothing. You can <strong>accept</strong> all of them, <strong>view</strong> the list, or
    <strong>ignore</strong> it for now. On a keyboard, while this notice is showing,
    <code>v</code> views the aged items rather than opening the review.</p>

    <h2>Undo</h2>
    <p><strong>Undo last session</strong> appears on the home screen and works for 24 hours. It
    restores the fields on each item. A yield line already added to a thesis or project stays
    there, so remove that by hand if you need to. It also won't overwrite an item that has
    changed since.</p>

    <h2>Where your decisions go</h2>
    <p>Decisions are saved to the pages in your vault, then committed and pushed with git. New
    pages arrive the same way. The app pulls in the background each time the home screen loads,
    so a new page can take one more visit to appear. The <code>git:</code> line on the home screen
    shows how the last pull went. A failed pull doesn't stop you working.</p>
    <p>New links don't start here. You capture them with the share sheet, and they appear after
    the capture pipeline has processed them.</p>

    <h2>If something looks wrong</h2>
    <ul>
      <li><strong>“Skipped — changed elsewhere”:</strong> another device changed that item during
      your session. The other change was kept.</li>
      <li><strong>“Quarantined”:</strong> a file has git conflict markers and stays out of the queue
      until it's fixed in git.</li>
      <li><strong>The app won't load:</strong> it only answers over your private network, so check
      that NetBird is connected on this device. There is no offline mode.</li>
    </ul>

    <h2>Feedback</h2>
    <p>If something bothers you while you're using the app, press <kbd>!</kbd> <strong>feedback</strong>,
    which is available on nearly every screen, and say so in your own words. The screen and the item
    you're on are saved with it, and your session stays exactly where it was. Claude can read these
    notes on the server, but it doesn't check on its own: ask it to go through your feedback, and it
    will propose or make the changes you asked for.</p>
  </div>`;
}

function doneView(s) {
  const r = s.result ?? { title: "", lines: [], git: "" };
  return `
    <div class="eyebrow">DONE</div>
    <h1>${esc(r.title)}</h1>
    ${r.lines.map((l) => `<div class="evline">${esc(l)}</div>`).join("")}
    ${r.git ? `<div class="homeline quiet">git: ${esc(r.git)}</div>` : ""}`;
}

function agingViewView(s) {
  const a = s.home.aging;
  return `
    <div class="eyebrow">AGED OUT — ${a.length} items under the 14/30 active-day rule (days you scanned, not calendar days)</div>
    <ul class="decisions">${a
      .map(
        (x) => `<li><span class="act ${x.kind === "drop" ? "act-dropped" : "act-return"}">${x.kind === "drop" ? "drop" : "return"}</span>
      <span>${esc(x.title)}</span><span class="note">${x.days} active days</span></li>`,
      )
      .join("")}</ul>
    <div class="stat quiet">Dropping is amnesty, not failure — files stay searchable, and backlog mode can rescue any of them.</div>`;
}

export function view(s) {
  const inner =
    s.mode === "loading" || s.mode === "committing"
      ? `<div class="eyebrow">${s.mode === "committing" ? "WRITING…" : "LOADING…"}</div>`
      : s.mode === "home"
        ? homeView(s)
        : s.mode === "agingview"
          ? agingViewView(s)
          : s.mode === "card"
            ? cardView(s)
            : s.mode === "end"
              ? endView(s)
              : s.mode === "readpick"
                ? readPickView(s)
                : s.mode === "readitem"
                  ? readItemView(s)
                  : s.mode === "review"
                    ? reviewView(s)
                    : s.mode === "orphan"
                      ? orphanView(s)
                      : s.mode === "mint"
                        ? mintView(s)
                        : s.mode === "model"
                          ? modelView()
                          : s.mode === "guide"
                            ? guideView()
                          : s.mode === "library"
                            ? libraryView(s)
                            : s.mode === "libitem"
                              ? libItemView(s)
                              : s.mode === "neterror"
                                ? `<div class="eyebrow">OFFLINE</div>`
                                : doneView(s);
  const error = s.error ? `<div class="banner warn">${esc(s.error)}</div>` : "";
  const notice = s.notice ? `<div class="banner">${esc(s.notice)}</div>` : "";
  return `<div class="screen">${error}${notice}${inner}</div>${s.prompt ? "" : keybar(keymapFor(s))}${promptView(s)}`;
}

// ---------------------------------------------------------------- boot
// The only impure section: DOM mount, event boundary, focus management.

if (typeof document !== "undefined") {
  const app = document.getElementById("app");
  // Browser storage can be missing or throw (private mode); then a reload just
  // loses the session, as it always did.
  const SESSION_KEY = "reading-session";
  const store = {
    load() {
      try {
        const v = JSON.parse(localStorage.getItem(SESSION_KEY));
        return Array.isArray(v?.items) && Array.isArray(v?.decisions) && v.decisions.length ? v : null;
      } catch {
        return null;
      }
    },
    save(v) {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(v));
      } catch {}
    },
    clear() {
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {}
    },
  };

  let state = {
    ...initialState,
    saved: store.load(),
    today: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
  };

  function persist(prev, next, action) {
    const keep = sessionToSave(next);
    if (keep) store.save(keep);
    // Kept through "committing": a reload mid-commit must not lose the session.
    else if (action.type === "discardSaved" || (next.mode !== "committing" && (sessionToSave(prev) || prev.mode === "committing"))) store.clear();
  }

  const dom = {
    inputValue: (sel) => document.querySelector(sel)?.value ?? "",
  };

  const hasPointer = () => matchMedia("(hover: hover)").matches;
  const runBinding = (b) => dispatch(typeof b.action === "function" ? b.action(state, dom) : b.action);

  // Which screen is showing. A new screen starts at the top; the library list
  // keeps its place when you come back from an item.
  const screenKey = (s) => `${s.mode}:${s.idx}:${s.reviewIdx}:${s.current?.file ?? ""}`;
  let lastScreen = "";
  let libraryScroll = 0;
  let lastPrompt = null;

  function render() {
    const wasLibItem = lastScreen.startsWith("libitem:");
    const hadSearchFocus = document.activeElement?.id === "lib-q";
    // A result arriving redraws the screen, which must not wipe what is being typed.
    const typed = state.prompt === lastPrompt ? document.getElementById("prompt-input")?.value : undefined;
    lastPrompt = state.prompt;
    app.innerHTML = view(state);
    if (typed !== undefined) document.getElementById("prompt-input").value = typed;
    app.querySelectorAll("[data-action]").forEach((el) =>
      el.addEventListener("click", () => dispatch(JSON.parse(el.dataset.action))),
    );
    app.querySelectorAll("[data-key]").forEach((el) =>
      el.addEventListener("click", () => {
        const b = keymapFor(state).find((x) => x.key === el.dataset.key && x.action);
        if (b) runBinding(b);
      }),
    );
    const search = document.getElementById("lib-q");
    // No re-render on typing: the caret stays put and state still holds the text.
    if (search) search.addEventListener("input", () => (state = update(state, { type: "libType", value: search.value })[0]));

    const key = screenKey(state);
    const newScreen = key !== lastScreen;
    lastScreen = key;
    if (newScreen) window.scrollTo(0, state.mode === "library" && wasLibItem ? libraryScroll : 0);
    // A redraw replaces the input, so results arriving must not take the caret
    // away. Only auto-focus with a real pointer: on a phone it would pop up the
    // on-screen keyboard over the list.
    if (search && (hadSearchFocus || (newScreen && !wasLibItem && hasPointer()))) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }

    const input = document.getElementById("prompt-input");
    if (input && !input.disabled) input.focus();
    const mint = document.getElementById("m-name");
    if (mint) mint.focus();
  }

  function dispatch(action) {
    if (action.type === "libOpen") libraryScroll = window.scrollY;
    // Searching on a phone: put the on-screen keyboard away so the results show.
    if (action.type === "libSearch" && !hasPointer()) document.activeElement?.blur();
    const [next, effect] = update(state, action);
    persist(state, next, action);
    state = next;
    render();
    if (typeof effect === "function") {
      Promise.resolve()
        .then(() => effect(dispatch))
        .catch((e) => dispatch({ type: "netError", detail: e instanceof TypeError ? "" : e.message }));
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts stay the browser's
    if (e.key === "Enter" && e.shiftKey && e.target.tagName === "TEXTAREA") return; // a new line
    // In a bare input (mint, library search), only Enter/Escape are ours.
    if (!state.prompt && e.target.tagName === "INPUT" && e.key !== "Enter" && e.key !== "Escape") return;
    // A focused list row or chip: Enter means that element, not the screen's binding.
    if (e.key === "Enter" && e.target.matches?.("[data-action]")) return;
    const binding = keymapFor(state).find((b) => b.key === e.key && b.action);
    if (!binding) return;
    e.preventDefault(); // what the machine consumes never reaches the DOM
    runBinding(binding);
  });

  dispatch({ type: "loadHome" });
}
