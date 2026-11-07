import { describe, expect, test } from "bun:test";
import { parseSubstackArchive, parseFeed, parseSitemap, parsePostMeta, substackBase } from "../monitor";

describe("listings without a browser", () => {
  test("substack archive JSON → candidates in window, paid flagged", () => {
    const json = [
      { post_date: "2026-09-13T10:00:00.000Z", title: "New", canonical_url: "https://x.substack.com/p/new", audience: "everyone" },
      { post_date: "2026-09-01T10:00:00.000Z", title: "Paid", canonical_url: "https://x.substack.com/p/paid", audience: "only_paid" },
      { post_date: "2026-08-01T10:00:00.000Z", title: "Old", canonical_url: "https://x.substack.com/p/old" },
    ];
    expect(parseSubstackArchive(json, "S", "2026-08-11")).toEqual([
      { source: "S", url: "https://x.substack.com/p/new", title: "New", date: "2026-09-13" },
      { source: "S", url: "https://x.substack.com/p/paid", title: "Paid", date: "2026-09-01", paid: true },
    ]);
    expect(parseSubstackArchive({ posts: json }, "S", "2026-09-10").map((c) => c.title)).toEqual(["New"]);
    expect(() => parseSubstackArchive({ error: 1 }, "S", "2026-08-11")).toThrow("unexpected Substack archive shape");
    expect(substackBase("https://newsletter.substack.com/archive")).toBe("https://newsletter.substack.com");
    expect(substackBase("https://blog.example")).toBeNull();
  });
  test("RSS 2.0", () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Blog</title>
      <item><title><![CDATA[A Post Title]]></title><link>https://m.com/a?source=rss</link><pubDate>Mon, 24 Aug 2026 15:00:00 GMT</pubDate></item>
      <item><title>Old</title><link>https://m.com/old</link><pubDate>Mon, 03 Aug 2026 15:00:00 GMT</pubDate></item>
      </channel></rss>`;
    expect(parseFeed(xml, "Y", "2026-08-11")).toEqual([{ source: "Y", url: "https://m.com/a?source=rss", title: "A Post Title", date: "2026-08-24" }]);
  });
  test("Atom", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>W</title>
      <entry><title>Another post?</title><link rel="alternate" href="https://s.net/2026/Sep/20/hn/"/><published>2026-09-20T18:22:00+00:00</published></entry>
      <entry><title>Old</title><link href="https://s.net/old/"/><updated>2026-07-01T00:00:00+00:00</updated></entry>
      </feed>`;
    expect(parseFeed(xml, "W", "2026-08-11")).toEqual([{ source: "W", url: "https://s.net/2026/Sep/20/hn/", title: "Another post?", date: "2026-09-20" }]);
  });
});

describe("sitemap listings", () => {
  test("lastmod narrows, prefix filters, the listing page itself is dropped", () => {
    const xml = `<urlset>
      <url><loc>https://b.io/blog</loc><lastmod>2026-10-29T00:00:00Z</lastmod></url>
      <url><loc>https://b.io/blog/new-post</loc><lastmod>2026-10-28T10:00:00Z</lastmod></url>
      <url><loc>https://b.io/blog/old-post</loc><lastmod>2026-07-22T17:52:34Z</lastmod></url>
      <url><loc>https://b.io/trainings</loc><lastmod>2026-10-29T00:00:00Z</lastmod></url>
    </urlset>`;
    expect(parseSitemap(xml, "https://b.io/blog/", "2026-10-25")).toEqual([{ url: "https://b.io/blog/new-post", lastmod: "2026-10-28" }]);
  });
  test("post meta: JSON-LD datePublished wins over an edited lastmod", () => {
    const html = `<title>A Sitemap Post? | Example Site</title><script type="application/ld+json">{"datePublished":"2022-05-19T04:48:23Z"}</script>`;
    expect(parsePostMeta(html)).toEqual({ title: "A Sitemap Post?", date: "2022-05-19" });
    expect(parsePostMeta(`<meta property="article:published_time" content="2026-10-28T08:00:00Z">`).date).toBe("2026-10-28");
  });
});
