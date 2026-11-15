import { test, expect } from "bun:test";
import { parseEval, cleanText, profileFor } from "../tools/agweb";

test("parseEval decodes a JSON string returned by the page", () => {
  const out = '### Result\n"{\\"handle\\":\\"someone\\",\\"n\\":3}"\n### Page\n- URL: https://blog.example/p/x\n';
  expect(parseEval(out)).toEqual({ handle: "someone", n: 3 });
});

test("parseEval returns plain values and throws on an error reply", () => {
  expect(parseEval('### Result\n"none"\n')).toBe("none");
  expect(() => parseEval("Error: no visible element matches e9")).toThrow("no visible element");
});

test("cleanText drops the page header and the main-content note", () => {
  const out = "### Page\n- URL: https://blog.example/p/x\n- Title: X\n### Result\n# A post\n\nBody text.\n- Note: main content only: 3 of 90 words on the page; text --all for all of it\n";
  expect(cleanText(out)).toBe("# A post\n\nBody text.");
});

test("cleanText stops at a trailing page block", () => {
  expect(cleanText("### Result\n# A post\n\nEnd.\n### Page\n- URL: https://blog.example/p/x\n")).toBe("# A post\n\nEnd.");
});

test("profileFor picks the longest matching domain and ignores www.", () => {
  const map = { "blog.example": "other", "deep.blog.example": "third" };
  expect(profileFor("https://www.blog.example/p/x", map, "main")).toBe("other");
  expect(profileFor("https://news.deep.blog.example/p/x", map, "main")).toBe("third");
  expect(profileFor("https://notblog.example/p/x", map, "main")).toBe("main");
  expect(profileFor("not a url", map, "main")).toBe("main");
});
