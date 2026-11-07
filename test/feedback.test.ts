import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFeedback, parseFeedback, FEEDBACK_MAX } from "../feedback";

describe("parseFeedback", () => {
  test("trims the text and keeps the context", () => {
    expect(parseFeedback({ text: "  too small ", screen: "card", task: "scan", item: "A Page" })).toEqual({
      text: "too small",
      screen: "card",
      task: "scan",
      item: "A Page",
    });
  });

  test("refuses missing, empty, non-string and oversized text", () => {
    for (const b of [null, {}, { text: "" }, { text: "   " }, { text: 7 }, { text: "x".repeat(FEEDBACK_MAX + 1) }]) {
      expect(parseFeedback(b)).toBeNull();
    }
  });

  test("drops anything else, and context that is not a string", () => {
    const fb = parseFeedback({ text: "t", screen: { a: 1 }, extra: "no", id: "forged" })!;
    expect(fb.screen).toBeUndefined();
    expect(Object.keys(fb)).not.toContain("extra");
    expect(Object.keys(fb)).not.toContain("id");
  });

  test("caps the context length", () => {
    expect(parseFeedback({ text: "t", item: "x".repeat(1000) })!.item!.length).toBe(300);
  });
});

describe("appendFeedback", () => {
  test("appends one parseable line per entry, creating the folder", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "rq-fb-")), "new");
    await appendFeedback({ text: 'line one\nwith "quotes"', screen: "home" }, dir);
    await appendFeedback({ text: "second" }, dir);
    const lines = (await Bun.file(`${dir}/feedback.jsonl`).text()).trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.text).toBe('line one\nwith "quotes"');
    expect(first.screen).toBe("home");
    expect(new Date(first.id).getTime()).not.toBeNaN();
  });
});
