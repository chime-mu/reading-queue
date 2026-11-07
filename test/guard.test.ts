// What protects a server with no login from the web pages on the same device.

import { describe, expect, test } from "bun:test";
import { allowedHosts, requestAllowed } from "../guard";
import { SOURCE_DIR, COMPASS_DIR } from "../config";
import { isCompassFile, isSourceFile, validate } from "../session";

const hosts = allowedHosts("reading.mesh.example, 100.64.0.1");
const req = (host: string, opts: { method?: string; origin?: string } = {}) =>
  new Request("http://ignored/api/x", {
    method: opts.method ?? "GET",
    headers: { host, ...(opts.origin ? { origin: opts.origin } : {}) },
  });

describe("requestAllowed", () => {
  test("answers to known names, with or without a port", () => {
    expect(requestAllowed(req("localhost:4321"), hosts)).toBe(true);
    expect(requestAllowed(req("reading.mesh.example:4321"), hosts)).toBe(true);
    expect(requestAllowed(req("100.64.0.1"), hosts)).toBe(true);
    expect(requestAllowed(req("READING.mesh.example"), hosts)).toBe(true);
  });

  test("DNS rebinding: an unknown name is refused, even for a read", () => {
    expect(requestAllowed(req("evil.example.com"), hosts)).toBe(false);
    expect(requestAllowed(req("evil.example.com:4321"), hosts)).toBe(false);
    expect(requestAllowed(req(""), hosts)).toBe(false);
  });

  test("the extra names are not allowed unless configured", () => {
    expect(requestAllowed(req("reading.mesh.example"), allowedHosts())).toBe(false);
  });

  test("a write from the app's own page passes", () => {
    const r = req("reading.mesh.example:4321", { method: "POST", origin: "http://reading.mesh.example:4321" });
    expect(requestAllowed(r, hosts)).toBe(true);
  });

  test("a cross-site write is refused", () => {
    const r = req("reading.mesh.example:4321", { method: "POST", origin: "https://evil.example.com" });
    expect(requestAllowed(r, hosts)).toBe(false);
  });

  test("the same name on another port is another site", () => {
    const r = req("reading.mesh.example:4321", { method: "POST", origin: "http://reading.mesh.example:9000" });
    expect(requestAllowed(r, hosts)).toBe(false);
  });

  test("a sandboxed frame's null origin is refused", () => {
    expect(requestAllowed(req("localhost:4321", { method: "POST", origin: "null" }), hosts)).toBe(false);
  });

  test("a client that is not a web page sends no origin and passes", () => {
    expect(requestAllowed(req("localhost:4321", { method: "POST" }), hosts)).toBe(true);
  });
});

describe("file paths from the browser", () => {
  test("source files only, directly in the folder", () => {
    expect(isSourceFile(`${SOURCE_DIR}/An item.md`)).toBe(true);
    expect(isSourceFile(`${SOURCE_DIR}/../CLAUDE.md`)).toBe(false);
    expect(isSourceFile(`${SOURCE_DIR}/sub/item.md`)).toBe(false);
    expect(isSourceFile(`${SOURCE_DIR}/item.txt`)).toBe(false);
    expect(isSourceFile("/etc/passwd")).toBe(false);
  });

  test("compass names cannot climb out of the folder", () => {
    expect(isCompassFile(`${COMPASS_DIR}/Project - x.md`)).toBe(true);
    expect(isCompassFile(`${COMPASS_DIR}/Project - ../x.md`)).toBe(false);
    expect(isCompassFile(`${COMPASS_DIR}/Project - ../../../x.md`)).toBe(false);
  });

  test("validate refuses a decision pointing outside, whatever else it says", () => {
    const good = { file: `${SOURCE_DIR}/a.md`, action: "scanned" as const, snapshot: { status: "unread" } };
    expect(validate(good)).toBeNull();
    expect(validate({ ...good, file: "/Users/x/.ssh/config.md" })).toBe("not a source file");
    expect(validate({ ...good, for: "[[../../journals/x]]" })).toBe("not a compass object");
  });
});
