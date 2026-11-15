import { test, expect } from "bun:test";
import { parseEval, cleanText } from "../tools/agweb";

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
