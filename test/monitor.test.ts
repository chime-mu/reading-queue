import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSources, parseSeen, filterNew, recordMonitor, todayCopenhagen } from "../monitor";

const PAGE = `type:: [[index]]
alias:: source monitor

- **What this is.** A daily automated scan — https://example.com/not-a-source
- ## Trusted authors (the core list)
	- ### Ann Author — first topic, second topic
		- The Newsletter — https://newsletter.substack.com/archive
		- Substack notes — https://substack.com/@annauthor/notes
	- ### Bob Writer — third topic
		- Blog — https://bob.example/
- ## Institution (institutional)
	- Institution news — https://institution.example/news
	- Institution sessions — https://institution.example/sessions (+ playlist)
- ## Podcasts (secondary; cut anytime)
	- Pat Host — A Podcast — https://podcast.example/a-podcast
- ## Relevance filter
	- Keep: agentic coding — https://ignored.example
- ## Retired (cut)
	- Retired Person — https://retired.example
`;

describe("parseSources", () => {
  test("reads sections, authors, names and urls; skips prose, filter and retired", () => {
    const s = parseSources(PAGE);
    expect(s.map((x) => [x.label, x.url])).toEqual([
      ["Ann Author (Newsletter)", "https://newsletter.substack.com/archive"],
      ["Ann Author (notes)", "https://substack.com/@annauthor/notes"],
      ["Bob Writer (Blog)", "https://bob.example/"],
      ["Institution news", "https://institution.example/news"],
      ["Institution sessions", "https://institution.example/sessions"],
      ["Pat Host — A Podcast", "https://podcast.example/a-podcast"],
    ]);
    expect(s[0].section).toBe("Trusted authors");
    expect(s[3].author).toBe("");
  });
});

describe("filterNew", () => {
  test("drops known keys (canonical) and duplicates within the batch", () => {
    const known = new Set(["https://a/seen"]);
    const fresh = filterNew(
      [
        { source: "S", url: "https://a/seen?utm_source=x", title: "seen" },
        { source: "S", url: "https://a/new", title: "new" },
        { source: "S", url: "https://a/new#frag", title: "dup" },
      ],
      known,
    );
    expect(fresh.map((c) => c.title)).toEqual(["new"]);
  });
});

describe("recordMonitor", () => {
  test("appends monitor-seen + processed rows once, stamps last-run", async () => {
    const vault = await mkdtemp(join(tmpdir(), "rq-mon-"));
    await mkdir(join(vault, "pipeline"));
    await mkdir(join(vault, "source"));
    const seen = join(vault, "pipeline", "monitor-seen.tsv");
    const processed = join(vault, "pipeline", "processed.tsv");
    const last = join(vault, "pipeline", "monitor-last-run.txt");
    await Bun.write(seen, "#date-found\tsource\turl\ttitle\n");
    await Bun.write(processed, "#captured-date\tcaptured-time\tsource-url\tpage\n");
    await Bun.write(join(vault, "source", "New Thing.md"), "---\ntitle: x\n---\nbody\n");
    const rows = [
      { source: "Institution blog", url: "https://institution.example/blog/new?utm_source=rss", title: "New\tthing", date: "2026-09-20", page: "source/New Thing" },
      { source: "Institution blog", url: "https://institution.example/blog/missing", title: "no page", page: "source/Missing" },
    ];
    const res = await recordMonitor(rows, { today: "2026-09-26", seen, processed, lastRun: last, vault });
    expect(res.added.map((r) => r.url)).toEqual(["https://institution.example/blog/new"]);
    expect(res.missing).toEqual(["source/Missing"]);
    expect(await Bun.file(seen).text()).toBe("#date-found\tsource\turl\ttitle\n2026-09-26\tInstitution blog\thttps://institution.example/blog/new\tNew thing\n");
    expect(await Bun.file(processed).text()).toContain("2026_09_20\t00.00\thttps://institution.example/blog/new\tsource/New Thing\n");
    expect((await Bun.file(last).text()).trim()).toBe("2026-09-26");
    const again = await recordMonitor(rows.slice(0, 1), { today: "2026-09-27", seen, processed, lastRun: last, vault });
    expect(again.added).toEqual([]);
    expect(parseSeen(await Bun.file(seen).text())).toHaveLength(1);
  });
  test("todayCopenhagen is an ISO date", () => {
    expect(todayCopenhagen()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
