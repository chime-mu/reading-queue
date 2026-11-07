import { expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptureFiles, readJournals } from "../process";

test("unreadable or missing capture folder fails loudly instead of returning 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cap-"));
  await writeFile(join(dir, "capture-Phone.txt"), "2026-10-30 16.37 https://example.com/a\n");
  expect((await readCaptureFiles(dir)).length).toBe(1);
  await chmod(dir, 0o000);
  try {
    await expect(readCaptureFiles(dir)).rejects.toThrow(/cannot read capture files/);
  } finally {
    await chmod(dir, 0o755);
  }
  await expect(readCaptureFiles(join(dir, "nope"))).rejects.toThrow(/ENOENT|no such file/);
});

test("a missing journals folder is still an empty list", async () => {
  expect(await readJournals(join(tmpdir(), "no-such-journals-dir"))).toEqual([]);
});
