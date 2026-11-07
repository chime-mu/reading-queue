// Library search: pure, so no vault is needed.

import { describe, expect, test } from "bun:test";
import { searchItems, type SourceItem } from "../vault";

const item = (title: string, captured: string, extra: Partial<SourceItem> = {}): SourceItem => ({
  path: `/v/source/${title}.md`,
  file: `${title}.md`,
  title,
  type: "article",
  author: [],
  captured,
  sourceUrl: "",
  status: "unread",
  body: "",
  snapshot: {},
  ...extra,
});

const ITEMS = [
  item("Old agents", "2026-01-01"),
  item("New agents", "2026-06-01"),
  item("Holons", "2026-07-01", { body: "Agents appear in the body.", author: ["Ann Author"] }),
  item("Dropped note", "2026-08-01", { status: "dropped" }),
];
const titles = (r: { items: SourceItem[] }) => r.items.map((i) => i.title);

describe("searchItems", () => {
  test("no query lists everything, newest first", () => {
    expect(titles(searchItems(ITEMS))).toEqual(["Dropped note", "Holons", "New agents", "Old agents"]);
  });

  test("title hits outrank body hits, then newest first", () => {
    expect(titles(searchItems(ITEMS, { q: "agents" }))).toEqual(["New agents", "Old agents", "Holons"]);
  });

  test("every word must match, in any field, ignoring case", () => {
    expect(titles(searchItems(ITEMS, { q: "AGENTS author" }))).toEqual(["Holons"]);
    expect(titles(searchItems(ITEMS, { q: "agents nothinglikethis" }))).toEqual([]);
  });

  test("status filters, and total counts all hits, not just the page", () => {
    expect(titles(searchItems(ITEMS, { status: "dropped" }))).toEqual(["Dropped note"]);
    const page = searchItems(ITEMS, { offset: 1, limit: 2 });
    expect(titles(page)).toEqual(["Holons", "New agents"]);
    expect(page.total).toBe(4);
  });
});
