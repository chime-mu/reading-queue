// Processor v2 — the parts that must be exact: URL keys, input parsing,
// dedup against the ledger, page validation, idempotent recording.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalUrl, parseCaptureFile, parseJournal, parseLedger, ledgerKeys, checkPage, record, resolveShortLink } from "../process";

describe("canonicalUrl", () => {
  test("strips Substack share tracking", () => {
    expect(canonicalUrl("https://substack.com/@x/note/c-1?r=4t5t7&utm_medium=ios&utm_source=notes-share-action")).toBe(
      "https://substack.com/@x/note/c-1",
    );
  });
  test("strips LinkedIn rcm and share params", () => {
    expect(
      canonicalUrl("https://www.linkedin.com/posts/a_b-activity-1-x/?utm_source=share&utm_medium=member_ios&rcm=ACo"),
    ).toBe("https://www.linkedin.com/posts/a_b-activity-1-x/");
  });
  test("keeps content-identifying params (youtube v)", () => {
    expect(canonicalUrl("https://www.youtube.com/watch?v=abc&si=track")).toBe("https://www.youtube.com/watch?v=abc");
  });
  test("drops fragment, lower-cases host, tolerates garbage", () => {
    expect(canonicalUrl("HTTPS://Example.com/P#frag")).toBe("https://example.com/P");
    expect(canonicalUrl("not a url")).toBe("not a url");
  });
});

describe("inputs", () => {
  test("capture file: valid lines only, blanks and debris ignored", () => {
    const text = "\n2026-09-25 22.41 https://a/1\nbroken line\n2026-09-25 22:42 https://a/2\n\n";
    expect(parseCaptureFile(text, "iPhone")).toEqual([
      { date: "2026-09-25", time: "22.41", url: "https://a/1", origin: "capture:iPhone" },
      { date: "2026-09-25", time: "22.42", url: "https://a/2", origin: "capture:iPhone" },
    ]);
  });
  test("journal: DONE prefix, double space, conflict markers (both sides read)", () => {
    const text = [
      "-",
      "- **07.53** [[quick capture]]:  https://a/1",
      "<<<<<<< HEAD",
      "- DONE **12.12** [[quick capture]]: https://a/2",
      "=======",
      "- **12.13** [[quick capture]]:  https://a/3",
      ">>>>>>> theirs",
      "- some other note",
    ].join("\n");
    expect(parseJournal(text, "2026_09_25").map((c) => [c.time, c.url, c.date, c.origin])).toEqual([
      ["07.53", "https://a/1", "2026-09-25", "journal:2026_09_25"],
      ["12.12", "https://a/2", "2026-09-25", "journal:2026_09_25"],
      ["12.13", "https://a/3", "2026-09-25", "journal:2026_09_25"],
    ]);
  });
  test("ledger keys are canonical so old rows with rcm still dedup", () => {
    const rows = parseLedger("#h\n2026_08_11\t07.46\thttps://www.linkedin.com/posts/x?rcm=ACo\tsource/X\n");
    expect(ledgerKeys(rows).has("https://www.linkedin.com/posts/x")).toBe(true);
  });
  test("non-short links are returned untouched without a network call", async () => {
    expect(await resolveShortLink("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("checkPage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rq-proc-"));
  });
  const good = `---
title: "A Page"
description: "Teaser."
type: article
author: ["[[Someone]]"]
source-url: https://x/p
captured: 2026-09-25
status: unread
related: ["[[Other]]"]
---
A summary paragraph long enough to count as prose, with several claims, a date and a name in it for good measure.
`;
  test("accepts a spec-conformant page", async () => {
    const p = join(dir, "A Page.md");
    await Bun.write(p, good);
    expect(await checkPage(p, new Set(["Other"]))).toEqual({ path: p, ok: true, problems: [] });
  });
  test("flags bad filename, wrong status, rating, unresolved related, bullets", async () => {
    const p = join(dir, "Bad? Page.md");
    await Bun.write(p, good.replace("status: unread", "status: read\nrating: 4").replace("A summary", "- A summary"));
    const r = await checkPage(p, new Set());
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        "filename contains : / ? or \\",
        "status must be unread on creation",
        "rating is Michael's field — never written by the pipeline",
        "related link does not resolve: Other",
        "body uses outliner bullets; prose expected",
      ]),
    );
  });
  test("flags missing required fields", async () => {
    const p = join(dir, "Thin.md");
    await Bun.write(p, "---\ntitle: x\n---\nshort\n");
    const r = await checkPage(p);
    expect(r.problems).toEqual(expect.arrayContaining(["missing type", "missing source-url", "missing captured", "missing status", "body too short to be a summary"]));
  });
});

describe("record", () => {
  test("appends canonical rows once; skips known keys and missing pages", async () => {
    const vault = await mkdtemp(join(tmpdir(), "rq-vault-"));
    await mkdir(join(vault, "source"), { recursive: true });
    await mkdir(join(vault, "pipeline"), { recursive: true });
    const ledger = join(vault, "pipeline", "processed.tsv");
    await Bun.write(ledger, "#captured-date\tcaptured-time\tsource-url\tpage\n2026_09_01\t10.00\thttps://a/old\tsource/Old\n");
    const page = "source/New Page";
    await Bun.write(join(vault, `${page}.md`), "---\ntitle: x\n---\nbody\n");
    const res = await record(
      [
        { date: "2026-09-25", time: "22.41", key: "https://a/new?r=1&utm_source=x", page },
        { date: "2026-09-25", time: "22.42", key: "https://a/old", page },
        { date: "2026-09-25", time: "22.43", key: "https://a/nopage", page: "source/Does Not Exist" },
      ],
      ledger,
      vault,
    );
    expect(res.added.map((r) => r.url)).toEqual(["https://a/new"]);
    expect(res.skipped).toEqual(["https://a/old"]);
    expect(res.missing).toEqual(["source/Does Not Exist"]);
    const text = await Bun.file(ledger).text();
    expect(text.endsWith(`2026_09_25\t22.41\thttps://a/new\t${page}\n`)).toBe(true);
    // idempotent
    const again = await record([{ date: "2026-09-25", time: "22.41", key: "https://a/new", page }], ledger, vault);
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual(["https://a/new"]);
  });
});
