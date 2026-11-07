// Headless walk of the UI state machine — possible only because update/view/
// keymapFor are pure. Regression tests for the two v1 architecture bugs are
// marked BUG1 (key leaking into a fresh prompt input) and BUG2 (intent lenses
// vanishing after the first card).

import { describe, expect, test } from "bun:test";
import { initialState, update, view, keymapFor, sessionToSave, PICK_KEYS } from "../public/app.js";

const ITEMS = [0, 1, 2].map((i) => ({
  file: `/v/source/item${i}.md`,
  name: `item${i}`,
  title: `Item ${i}`,
  type: "article",
  author: "A",
  captured: `2026-07-0${i + 1}`,
  status: "unread",
  body: "Some **summary** text.",
  pull: "",
  for: "",
  snapshot: { status: "unread" },
}));
const COMPASS = [
  { name: "Project - Aug essay", type: "project" },
  { name: "Thesis - Org design", type: "thesis" },
];
const INTENTS = [
  { role: "student-of-the-field", test: "Does this deepen my mental model of LLMs?" },
  { role: "consultancy-owner", test: "Does this reveal industry structure?" },
];

/** apply an action, dropping effects (tests never run fetch) */
const step = (s, a) => update(s, a)[0];

function scanState() {
  return step(initialState, { type: "scanLoaded", data: { items: ITEMS, compass: COMPASS, intents: INTENTS } });
}

describe("touch: every action can be tapped", () => {
  const keysIn = (html: string) => [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);

  test("the bar's buttons are exactly the labelled bindings, on every card state", () => {
    const s = scanState();
    const labelled = keymapFor(s).filter((b) => b.label && b.action).map((b) => b.key);
    expect(keysIn(view(s))).toEqual(labelled);
  });

  test("a prompt carries its own confirm and cancel, and hides the screen's bar", () => {
    const s = step(scanState(), { type: "openPrompt", label: "Why?", withPicker: true, then: { type: "stageQueued" } });
    expect(keysIn(view(s))).toEqual(["Enter", "Escape"]);
  });

  test("picker rows are tappable, including the none row", () => {
    let s = step(scanState(), { type: "openPrompt", label: "Why?", withPicker: true, then: { type: "stageQueued" } });
    s = step(s, { type: "promptSubmit", value: "reason" });
    const html = view(s).replace(/&quot;/g, '"');
    expect(html).toContain('{"type":"promptPick","index":0}');
    expect(html).toContain(`{"type":"promptPick","index":${COMPASS.length}}`);
  });

  test("queued items open by tap", () => {
    let s = step(initialState, { type: "readLoaded", data: { items: ITEMS } });
    expect(view(s).replace(/&quot;/g, '"')).toContain('{"type":"readOpenAt","index":2}');
    s = step(s, { type: "readOpenAt", index: 2 });
    expect(s.mode).toBe("readitem");
    expect(s.current.title).toBe("Item 2");
  });
});

describe("links to originals", () => {
  const withUrl = (sourceUrl: string) =>
    step(initialState, { type: "scanLoaded", data: { items: [{ ...ITEMS[0], sourceUrl }], compass: [], intents: [] } });

  test("a card links to its original", () => {
    expect(view(withUrl("https://example.com/a?b=1"))).toContain('href="https://example.com/a?b=1"');
  });

  test("anything but http(s) is never linked or opened", () => {
    const s = withUrl("javascript:alert(1)");
    expect(view(s)).not.toContain("href=");
    let opened = 0;
    (globalThis as any).window = { open: () => opened++ };
    update(s, { type: "openSource" })[1]();
    delete (globalThis as any).window;
    expect(opened).toBe(0);
  });
});

describe("library", () => {
  const data = { items: ITEMS, total: 5, offset: 0 };
  const opened = () => {
    const s = step(initialState, { type: "openLibrary" });
    return step(s, { type: "libLoaded", data, req: s.lib.req });
  };

  test("lists results and offers the rest", () => {
    const s = opened();
    expect(s.mode).toBe("library");
    expect(view(s)).toContain("Item 2");
    expect(view(s)).toContain("Show more (2 left)");
  });

  test("more appends; a stale answer is ignored", () => {
    let s = step(opened(), { type: "libMore" });
    s = step(s, { type: "libLoaded", data: { items: [ITEMS[0]], total: 5, offset: 3 }, req: s.lib.req });
    expect(s.lib.items.length).toBe(4);
    const stale = step(s, { type: "libLoaded", data: { items: [], total: 0, offset: 0 }, req: s.lib.req - 1 });
    expect(stale.lib.items.length).toBe(4);
  });

  test("the typed query and filter survive opening an item and coming back", () => {
    let s = step(opened(), { type: "libType", value: "agents" });
    s = step(s, { type: "libOpen", index: 1 });
    expect(s.mode).toBe("libitem");
    expect(view(s)).toContain("Item 1");
    s = step(s, { type: "libBack" });
    expect(s.lib.q).toBe("agents");
    expect(view(s)).toContain('value="agents"');
  });
});

describe("deciding from the library", () => {
  const data = { items: ITEMS, total: 3, offset: 0, compass: COMPASS };
  const onItem = (status = "unread") => {
    let s = step(initialState, { type: "openLibrary" });
    s = step(s, { type: "libLoaded", data: { ...data, items: ITEMS.map((i) => ({ ...i, status, snapshot: { status } })) }, req: s.lib.req });
    return step(s, { type: "libOpen", index: 1 });
  };
  const labels = (s: any) => keymapFor(s).filter((b: any) => b.label).map((b: any) => b.key);

  test("only moves the status model allows are offered", () => {
    expect(labels(onItem("unread"))).toEqual(["s", "d", "f", "q", "y", "Escape"]);
    expect(labels(onItem("queued"))).toEqual(["d", "f", "Escape"]);
    expect(labels(onItem("dropped"))).toEqual(["s", "q", "y", "Escape"]);
    expect(labels(onItem("scanned"))).toEqual(["Escape"]);
    expect(labels(onItem("read"))).toEqual(["Escape"]);
  });

  test("a decision is not written until confirmed, and targets that item", () => {
    const s = step(onItem(), { type: "stage", action: "dropped" });
    expect(s.mode).toBe("end");
    expect(view(s)).toContain("nothing written yet");
    expect(s.decisions[0].item.title).toBe("Item 1");
    const [, effect] = update(s, { type: "commit" });
    expect(typeof effect).toBe("function");
  });

  test("cancel and undo both go back to the library flow, not a scan", () => {
    const s = step(onItem(), { type: "stage", action: "dropped" });
    const cancelled = step(s, keymapFor(s).find((b: any) => b.key === "Escape").action);
    expect(cancelled.mode).toBe("library");
    expect(cancelled.decisions).toEqual([]);
    const undone = step(s, { type: "unstage" });
    expect(undone.mode).toBe("libitem");
    expect(undone.idx).toBe(0);
  });

  test("the queue prompt works, with the compass from the library answer", () => {
    let s = step(onItem(), keymapFor(onItem()).find((b: any) => b.key === "q").action);
    s = step(s, { type: "promptSubmit", value: "because" });
    s = step(s, { type: "promptPick", index: 1 });
    expect(s.decisions[0].pull).toBe("because");
    expect(s.decisions[0].for).toBe(`[[${COMPASS[0].name}]]`);
  });

  test("after committing, done returns to the library; a scan still returns home", () => {
    let s = step(onItem(), { type: "stage", action: "dropped" });
    s = step(s, { type: "commit" });
    s = step(s, { type: "committed", data: { results: [{ ok: true, file: "a" }], git: "" } });
    expect(keymapFor(s)[0].action).toEqual({ type: "openLibrary" });
    expect(sessionToSave(s)).toBeNull();
    let scan = step(scanState(), { type: "stage", action: "scanned" });
    scan = step(scan, { type: "committed", data: { results: [], git: "" } });
    expect(keymapFor(scan)[0].action).toEqual({ type: "loadHome" });
  });

  test("a library decision is never saved as a resumable session", () => {
    expect(sessionToSave(step(onItem(), { type: "stage", action: "dropped" }))).toBeNull();
  });
});

describe("a reload does not lose a session", () => {
  const HOME = { counts: { unread: 3 }, aging: [], quarantined: [], git: { detail: "" }, streak: "" };
  // What a reload does: everything through JSON, into a fresh state.
  const reload = (s: any) => ({ ...initialState, saved: JSON.parse(JSON.stringify(sessionToSave(s))) });

  test("nothing to keep before the first decision", () => {
    expect(sessionToSave(scanState())).toBeNull();
  });

  test("home offers it, and it resumes where it was", () => {
    const scan = step(step(scanState(), { type: "stage", action: "dropped" }), { type: "stage", action: "scanned" });
    const home = step(reload(scan), { type: "homeLoaded", data: HOME });
    expect(view(home)).toContain("2 decided, not yet written");
    const resumed = step(home, keymapFor(home).find((b: any) => b.key === "c").action);
    expect(resumed.mode).toBe("card");
    expect(resumed.idx).toBe(2);
    expect(resumed.decisions.length).toBe(2);
    expect(resumed.saved).toBeNull();
    expect(view(resumed)).toContain("Item 2");
  });

  test("a session that reached the review screen resumes there", () => {
    let s = scanState();
    for (let i = 0; i < 3; i++) s = step(s, { type: "stage", action: "scanned" });
    const home = step(reload(s), { type: "homeLoaded", data: HOME });
    expect(step(home, { type: "resumeSession" }).mode).toBe("end");
  });

  test("undo still works after a reload, when items are no longer the same objects", () => {
    const scan = step(step(scanState(), { type: "stage", action: "dropped" }), { type: "stage", action: "scanned" });
    const resumed = step(reload(scan), { type: "resumeSession" });
    const undone = step(resumed, { type: "unstage" });
    expect(undone.idx).toBe(1);
    expect(undone.decisions.length).toBe(1);
  });

  test("the model screen is still inside the session", () => {
    const s = step(step(scanState(), { type: "stage", action: "scanned" }), { type: "showModel" });
    expect(sessionToSave(s)?.decisions.length).toBe(1);
  });

  test("discard removes the offer", () => {
    const scan = step(scanState(), { type: "stage", action: "scanned" });
    const home = step(step(reload(scan), { type: "homeLoaded", data: HOME }), { type: "discardSaved" });
    expect(view(home)).not.toContain("not yet written");
  });
});

describe("network failure", () => {
  test("a failed commit returns to review with every decision intact, and retry works", () => {
    let s = step(scanState(), { type: "stage", action: "scanned" });
    s = step(s, { type: "endSession" });
    s = step(s, { type: "commit" });
    expect(s.mode).toBe("committing");
    s = step(s, { type: "netError" });
    expect(s.mode).toBe("end");
    expect(s.decisions.length).toBe(1);
    expect(view(s)).toContain("Could not reach the server");
    expect(keymapFor(s).some((b) => b.key === "Enter")).toBe(true);
    expect(step(s, { type: "commit" }).error).toBe("");
  });

  test("a failed load offers a retry instead of hanging on LOADING", () => {
    const s = step(step(initialState, { type: "loadHome" }), { type: "netError" });
    expect(s.mode).toBe("neterror");
    expect(keymapFor(s).find((b) => b.key === "Enter")?.action).toEqual({ type: "loadHome" });
  });
});

describe("scan flow", () => {
  test("cards advance and every consumed key is a keymap entry", () => {
    let s = scanState();
    expect(s.mode).toBe("card");
    for (const k of ["s", "d", "f", "q", "y", "u", "?", "Escape"]) {
      expect(keymapFor(s).some((b) => b.key === k && b.action)).toBe(true);
    }
  });

  test("BUG2: intent lenses render on every card, not just the first", () => {
    let s = scanState();
    expect(view(s)).toContain("Does this deepen my mental model");
    s = step(s, { type: "stage", action: "scanned" });
    expect(s.idx).toBe(1);
    expect(view(s)).toContain("Does this deepen my mental model"); // second card
    s = step(s, { type: "stage", action: "dropped" });
    expect(view(s)).toContain("Does this deepen my mental model"); // third card
  });

  test("lenses toggle with ? as state, and the keybar label follows", () => {
    let s = scanState();
    expect(keymapFor(s).find((b) => b.key === "?").label).toBe("hide lenses");
    s = step(s, { type: "toggleTests" });
    expect(view(s)).not.toContain("Does this deepen my mental model");
    expect(keymapFor(s).find((b) => b.key === "?").label).toBe("show lenses");
  });

  test("BUG1: opening the queue prompt starts with an empty input", () => {
    let s = scanState();
    const q = keymapFor(s).find((b) => b.key === "q");
    expect(q).toBeDefined(); // bound ⇒ dispatcher preventDefaults ⇒ no leak
    s = step(s, q.action);
    expect(s.prompt.stage).toBe("text");
    expect(s.prompt.text).toBe("");
    expect(view(s)).toContain('value=""');
    // while prompting, card keys are NOT bound (they fall through to the input)
    expect(keymapFor(s).some((b) => b.key === "s")).toBe(false);
  });

  test("prompt: text → picker → staged decision with pull and for", () => {
    let s = scanState();
    s = step(s, keymapFor(s).find((b) => b.key === "q").action);
    s = step(s, { type: "promptSubmit", value: "would change the essay" });
    expect(s.prompt.stage).toBe("pick");
    s = step(s, { type: "promptPick", index: 1 });
    expect(s.prompt).toBeNull();
    const d = s.decisions[0];
    expect(d.action).toBe("queued");
    expect(d.pull).toBe("would change the essay");
    expect(d.for).toBe("[[Project - Aug essay]]");
    expect(s.idx).toBe(1);
  });

  test("a full compass (10 objects) is fully reachable from the picker", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `Obj ${i}`, type: i < 3 ? "project" : "thesis" }));
    let s = { ...scanState(), compass: ten };
    s = step(s, keymapFor(s).find((b) => b.key === "q").action);
    s = step(s, { type: "promptSubmit", value: "pull line" });
    const keys = keymapFor(s).filter((b) => b.hidden).map((b) => b.key);
    expect(keys).toEqual(["0", ...PICK_KEYS.slice(0, 10)]);
    s = step(s, { type: "promptPick", index: 10 }); // the "a" key — 10th object
    expect(s.decisions[0].for).toBe("[[Obj 9]]");
  });

  test("prompt cancel returns to the same card untouched", () => {
    let s = scanState();
    s = step(s, keymapFor(s).find((b) => b.key === "y").action);
    s = step(s, { type: "promptCancel" });
    expect(s.prompt).toBeNull();
    expect(s.idx).toBe(0);
    expect(s.decisions.length).toBe(0);
  });

  test("undo pops the decision and returns to that card", () => {
    let s = scanState();
    s = step(s, { type: "stage", action: "scanned" });
    s = step(s, { type: "stage", action: "fun" });
    s = step(s, { type: "unstage" });
    expect(s.idx).toBe(1);
    expect(s.decisions.length).toBe(1);
  });

  test("last card leads to end screen; commit produces an effect", () => {
    let s = scanState();
    s = step(s, { type: "stage", action: "scanned" });
    s = step(s, { type: "stage", action: "dropped" });
    s = step(s, { type: "stage", action: "fun" });
    expect(s.mode).toBe("end");
    expect(view(s)).toContain("Dropped 1 of 3 — healthy");
    const [next, fx] = update(s, { type: "commit" });
    expect(next.mode).toBe("committing");
    expect(typeof fx).toBe("function");
  });
});

describe("backlog variant", () => {
  test("no fun key, d means leave-without-write", () => {
    let s = step(initialState, {
      type: "backlogLoaded",
      data: { items: ITEMS, compass: COMPASS, offset: 0, total: 30 },
    });
    expect(keymapFor(s).some((b) => b.key === "f")).toBe(false);
    const d = keymapFor(s).find((b) => b.key === "d");
    expect(d.action.type).toBe("skip");
    s = step(s, d.action);
    expect(s.decisions.length).toBe(0);
    expect(s.idx).toBe(1);
    expect(view(s)).toContain("backlog · 2 of 30");
  });
});

describe("home keymap", () => {
  const home = (aging, extra = {}) =>
    step(initialState, {
      type: "homeLoaded",
      data: {
        counts: { unread: 5 },
        quarantined: [],
        aging,
        scanDue: true,
        queuedCount: 0,
        reviewDue: false,
        droppedBacklog: 10,
        streak: "s",
        git: { detail: "ok" },
        undoAvailable: true,
        ...extra,
      },
    });

  test("aging banner takes over a/v/i; review's v returns when it's gone", () => {
    const withAging = home([{ file: "x", kind: "drop", snapshot: {}, title: "t", days: 20 }]);
    expect(keymapFor(withAging).find((b) => b.key === "v").action.type).toBe("viewAging");
    const without = home([]);
    expect(keymapFor(without).find((b) => b.key === "v").action.type).toBe("go");
  });

  test("ignoring aging is state, so the keymap follows", () => {
    let s = home([{ file: "x", kind: "drop", snapshot: {}, title: "t", days: 20 }]);
    s = step(s, { type: "hideAging" });
    expect(keymapFor(s).find((b) => b.key === "v").action.type).toBe("go");
  });
});

describe("review flow", () => {
  test("verdicts walk objects then land on mint when no orphans", () => {
    let s = step(initialState, {
      type: "reviewLoaded",
      data: {
        objects: [
          { file: "/c/t1.md", name: "Thesis - A", type: "thesis", claim: "c", due: "", reviewed: "", evidenceSinceReview: [], evidenceCount: 0 },
          { file: "/c/p1.md", name: "Project - B", type: "project", claim: "", due: "2026-08-31", reviewed: "", evidenceSinceReview: [], evidenceCount: 1 },
        ],
        orphans: [],
        compass: COMPASS,
        caps: { thesis: 7, project: 3 },
        activeCounts: { thesis: 1, project: 1 },
      },
    });
    expect(s.mode).toBe("review");
    s = step(s, { type: "verdict", action: "continue" });
    s = step(s, { type: "verdict", action: "kill" });
    expect(s.mode).toBe("mint");
    expect(s.reviewDecisions.map((d) => d.action)).toEqual(["continue", "kill"]);
  });
});

describe("model screen", () => {
  test("m opens the model from home and card; esc returns to where you were", () => {
    let s = scanState();
    s = step(s, { type: "stage", action: "scanned" }); // now on card 2
    expect(keymapFor(s).some((b) => b.key === "m")).toBe(true);
    s = step(s, { type: "showModel" });
    expect(s.mode).toBe("model");
    expect(view(s)).toContain("Perceive → believe → act");
    expect(view(s)).toContain("this dies if");
    s = step(s, { type: "closeModel" });
    expect(s.mode).toBe("card");
    expect(s.idx).toBe(1); // exactly where we left off
  });
});

describe("view totality", () => {
  test("view renders every mode without throwing", () => {
    const states = [
      initialState,
      { ...initialState, mode: "committing" },
      { ...initialState, mode: "done", result: { title: "x", lines: ["a"], git: "g" } },
      scanState(),
    ];
    for (const s of states) expect(typeof view(s)).toBe("string");
  });
});
