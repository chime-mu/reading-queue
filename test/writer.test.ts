// Writer tests — the one place tests matter. One synthetic fixture per `type`,
// shaped like real vault pages (field order, quoting, multi-line bodies).

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFields, appendEvidence, parseFrontmatter, fmtValue, unquote } from "../writer";

const page = (fields: string, body: string) => `---\n${fields}\n---\n${body}\n`;
const SOURCES: Record<string, string> = {
  // article (name starts with a quote)
  '"An Example Talk" (A Conference 2026, Jul 1).md': page(
    'title: "\\"An Example Talk\\" (A Conference 2026, Jul 1)"\ndescription: "A talk about examples."\ntype: article\nauthor: ["Ann Author"]\nsource-url: https://example.com/talk\ncaptured: 2026-07-11\nstatus: dropped\nclosed: 2026-08-04',
    "An article body.\n\n- with a list\n- and a [[Wiki Link]]",
  ),
  "A Note.md": page(
    'title: "A Note"\ndescription: "A short note."\ntype: note\nauthor: ["Ann Author"]\nsource-url: https://example.com/note\ncaptured: 2026-06-27\nstatus: dropped\ncaptured-time: "09.24"\nclosed: 2026-08-04',
    "A note body.",
  ),
  "A Paper - On Examples.md": page(
    'title: "A Paper - On Examples"\ndescription: "A paper."\ntype: paper\nauthor: ["Ann Author", "Bob Author"]\nsource-url: https://example.com/paper\ncaptured: 2026-07-04\nstatus: dropped\ncaptured-time: "16.06"\nrelated: ["[[Some Page]]"]\nclosed: 2026-08-04',
    "A paper body.\n\nSecond paragraph.",
  ),
  "A Video - review (with parentheses).md": page(
    'title: "A Video - review (with parentheses)"\ndescription: "A video."\ntype: video\nauthor: ["Ann Author"]\nsource-url: https://example.com/video\ncaptured: 2026-07-31\nstatus: unread',
    "A video body.",
  ),
  "A Talk - key points.md": page(
    'title: "A Talk - key points"\ndescription: "Notes on a talk."\ntype: video-notes\nauthor: ["Ann Author"]\ncaptured: 2026-07-30\nsource-url: https://example.com/notes\nstatus: unread\nspeaker: "Ann Author"\nvideo-title: "A Talk"\nvideo-source: "https://example.com/watch?v=abc"\nsummary-source: "third-party write-ups (example.com)"',
    "## Key points\n\n- one\n- two\n\n---\n\nText after a horizontal rule.",
  ),
  "A Reference Index.md": page(
    'title: "A Reference Index"\ndescription: "An index."\ntype: reference\nauthor: ["Ann Author"]\nsource-url: https://example.com/index\ncaptured: 2026-08-02\nstatus: unread\ncaptured-time: "09.10"\nrelated: ["[[Some Page]]"]',
    "A reference body.",
  ),
};
const FIXTURES = Object.keys(SOURCES);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rq-test-"));
  for (const f of FIXTURES) await Bun.write(join(dir, f), SOURCES[f]);
});

function bodyOf(text: string): string {
  const fm = parseFrontmatter(text)!;
  return fm.lines.slice(fm.closeIdx + 1).join("\n");
}

describe("setFields on all six representative types", () => {
  for (const f of FIXTURES) {
    test(`status replace preserves body + field order — ${f.slice(0, 30)}`, async () => {
      const path = join(dir, f);
      const before = await Bun.file(path).text();
      const fmBefore = parseFrontmatter(before)!;
      const cur = fmBefore.raw.get("status")!;
      const target = cur === "scanned" ? "read" : "scanned";
      const r = await setFields(path, { status: target }, { status: cur });
      expect(r.ok).toBe(true);
      const after = await Bun.file(path).text();
      // body byte-identical
      expect(bodyOf(after)).toBe(bodyOf(before));
      // exactly one line changed, in place
      const a = before.split("\n");
      const b = after.split("\n");
      expect(b.length).toBe(a.length);
      const diffs = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
      expect(diffs).toEqual([[`status: ${cur}`, `status: ${target}`]]);
      // field order preserved
      const fmAfter = parseFrontmatter(after)!;
      expect([...fmAfter.raw.keys()]).toEqual([...fmBefore.raw.keys()]);
    });
  }
});

describe("field insertion", () => {
  test("pull/for inserted before closing ---, quoted, escaping quotes", async () => {
    const path = join(dir, "A Note.md");
    const before = await Bun.file(path).text();
    const cur = parseFrontmatter(before)!.raw.get("status")!;
    const r = await setFields(
      path,
      {
        status: "queued",
        pull: 'would change the "topology" section of the essay',
        for: "[[Project - An example essay]]",
      },
      { status: cur, pull: undefined, for: undefined },
    );
    expect(r.ok).toBe(true);
    const after = await Bun.file(path).text();
    expect(bodyOf(after)).toBe(bodyOf(before));
    const fm = parseFrontmatter(after)!;
    expect(fm.raw.get("status")).toBe("queued");
    expect(unquote(fm.raw.get("pull"))).toBe('would change the "topology" section of the essay');
    expect(fm.raw.get("pull")).toBe('"would change the \\"topology\\" section of the essay"');
    expect(unquote(fm.raw.get("for"))).toBe("[[Project - An example essay]]");
    // inserted inside the frontmatter block
    const lines = after.split("\n");
    const closeIdx = lines.indexOf("---", 1);
    expect(lines.slice(1, closeIdx).some((l) => l.startsWith("pull:"))).toBe(true);
  });

  test("field removal deletes exactly the one line", async () => {
    const path = join(dir, "A Note.md");
    await setFields(path, { pull: "temp" }, {});
    const withPull = await Bun.file(path).text();
    const r = await setFields(path, { pull: null }, {});
    expect(r.ok).toBe(true);
    const after = await Bun.file(path).text();
    expect(after.split("\n").length).toBe(withPull.split("\n").length - 1);
    expect(parseFrontmatter(after)!.raw.has("pull")).toBe(false);
  });
});

describe("compare-and-swap", () => {
  test("skips when the field changed since snapshot", async () => {
    const path = join(dir, "A Note.md");
    // simulate another device flipping status after our session snapshot
    await setFields(path, { status: "read" }, {});
    const r = await setFields(path, { status: "scanned" }, { status: "unread" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("changed elsewhere");
    const after = await Bun.file(path).text();
    expect(parseFrontmatter(after)!.raw.get("status")).toBe("read"); // untouched
  });

  test("expected-absent fails when field exists", async () => {
    const path = join(dir, "A Note.md");
    await setFields(path, { pull: "already here" }, {});
    const r = await setFields(path, { pull: "new" }, { pull: undefined });
    expect(r.ok).toBe(false);
  });
});

describe("quarantine and malformed", () => {
  test("conflict markers → refused", async () => {
    const path = join(dir, "A Note.md");
    const text = await Bun.file(path).text();
    await Bun.write(path, text + "\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n");
    const r = await setFields(path, { status: "scanned" }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("conflict");
  });

  test("malformed frontmatter → refused", async () => {
    const path = join(dir, "broken.md");
    await Bun.write(path, "no frontmatter here\nstatus: unread\n");
    const r = await setFields(path, { status: "scanned" }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("malformed");
  });

  test("missing file → refused", async () => {
    const r = await setFields(join(dir, "nope.md"), { status: "scanned" }, {});
    expect(r.ok).toBe(false);
  });
});

describe("appendEvidence", () => {
  const compass = `---
type: thesis
claim: "test claim"
status: active
opened: 2026-08-01
reviewed: 2026-08-01
---
## Claim
Something. This dies if X.

## Evidence
- 2026-08-01 — first entry.

## Tensions
- A tension.
`;

  test("appends at end of Evidence section, before Tensions", async () => {
    const path = join(dir, "thesis.md");
    await Bun.write(path, compass);
    const r = await appendEvidence(path, "- 2026-08-03 — second entry ([[Some Item]]).");
    expect(r.ok).toBe(true);
    const after = await Bun.file(path).text();
    const lines = after.split("\n");
    const i = lines.indexOf("- 2026-08-03 — second entry ([[Some Item]]).");
    expect(i).toBeGreaterThan(lines.indexOf("- 2026-08-01 — first entry."));
    expect(i).toBeLessThan(lines.indexOf("## Tensions"));
  });

  test("idempotent on exact duplicate", async () => {
    const path = join(dir, "thesis.md");
    await Bun.write(path, compass);
    await appendEvidence(path, "- 2026-08-03 — entry.");
    const once = await Bun.file(path).text();
    await appendEvidence(path, "- 2026-08-03 — entry.");
    expect(await Bun.file(path).text()).toBe(once);
  });

  test("creates Evidence section when missing", async () => {
    const path = join(dir, "bare.md");
    await Bun.write(path, "---\ntype: project\nstatus: active\n---\nBody.\n");
    const r = await appendEvidence(path, "- 2026-08-03 — entry.");
    expect(r.ok).toBe(true);
    const after = await Bun.file(path).text();
    expect(after).toContain("## Evidence\n- 2026-08-03 — entry.");
  });
});

describe("fmtValue", () => {
  test("status/dates bare, strings quoted", () => {
    expect(fmtValue("status", "scanned")).toBe("scanned");
    expect(fmtValue("closed", "2026-08-03")).toBe("2026-08-03");
    expect(fmtValue("pull", "plain")).toBe('"plain"');
  });
});
