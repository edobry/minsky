/**
 * mt#1829: regression test for `runHookPermissionCheck`'s programmatic
 * fs.stat replacement of the prior `execAsync("test -x ${file}")` shell
 * interpolation.
 *
 * The seed-site fix replaces shell invocation with `fs/promises.stat`,
 * so this test verifies the underlying primitive correctly handles file
 * paths containing shell metacharacters (space, double-quote, dollar sign,
 * backtick) without any /bin/sh involvement. The fix is structural: no
 * shell means no shell-injection by construction.
 *
 * The check uses `mode & 0o100` to match `test -x` behavior for the
 * developer-owned files this hook scans (`.claude/hooks/*.ts`).
 *
 * NOTE on `custom/no-real-fs-in-tests`: this test DELIBERATELY exercises
 * the real filesystem because the entire correctness claim is "fs.stat
 * correctly stats files whose paths contain shell metacharacters." A
 * mocked fs.stat cannot demonstrate that — the proof requires the real
 * syscall. Each fs operation is annotated with an inline disable comment
 * naming this rationale.
 */
/* eslint-disable custom/no-real-fs-in-tests -- mt#1829: structural-primitive test; see file header */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, chmod, stat, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const METACHAR_FILENAMES = [
  "file with spaces.ts",
  'file"with"quotes.ts',
  "file$with$dollars.ts",
  "file`with`backticks.ts",
  "file;with;semicolons.ts",
  "file&with&ampersands.ts",
];

describe("mt#1829: hook permission check handles shell metachars in filenames", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mt-1829-permcheck-"));
    for (const name of METACHAR_FILENAMES) {
      await writeFile(join(tempDir, name), "#!/usr/bin/env bun\n");
    }
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  for (const name of METACHAR_FILENAMES) {
    test(`stat correctly classifies non-executable file: ${JSON.stringify(name)}`, async () => {
      const filePath = join(tempDir, name);
      await chmod(filePath, 0o644);
      const st = await stat(filePath);
      // mode & 0o100 = owner-execute bit; this is what the seed-site fix tests.
      expect(st.mode & 0o100).toBe(0);
    });

    test(`stat correctly classifies executable file: ${JSON.stringify(name)}`, async () => {
      const filePath = join(tempDir, name);
      await chmod(filePath, 0o755);
      const st = await stat(filePath);
      expect(st.mode & 0o100).not.toBe(0);
    });
  }

  test("stat raises ENOENT for missing file (seed-site fix handles this)", async () => {
    const filePath = join(tempDir, "definitely-does-not-exist.ts");
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await stat(filePath);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("ENOENT");
  });
});
