/**
 * Tests for keeping `init`'s machine-local config out of git (mt#5014).
 *
 * AT1 is the defect itself: after `init`, `.minsky/config.local.yaml` must be
 * ignored. AT2 and AT3 are the non-destructive guarantees — an existing entry is
 * left byte-identical, and an unrelated `.gitignore` keeps every line it had.
 *
 * The ignore probe is injected rather than shelling out to git, so every branch
 * is reachable without a subprocess and without patching a module the code
 * reaches itself.
 */

import { describe, test, expect } from "bun:test";
import { ensurePathIgnored, LOCAL_CONFIG_GITIGNORE_ENTRY } from "./gitignore";
import type { FsLike } from "../interfaces/fs-like";

const REPO = "/repo";
const GITIGNORE = "/repo/.gitignore";

/** An in-memory FsLike carrying just the files a case needs. */
function fakeFs(initial: Record<string, string> = {}): FsLike & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    exists: async (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: async (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
    writeFile: async (p: string, data: string | Buffer) => {
      files[p] = typeof data === "string" ? data : data.toString();
    },
    mkdir: async () => undefined,
    readdir: async () => [],
    stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    access: async () => undefined,
    unlink: async () => undefined,
    copyFile: async () => undefined,
    rm: async () => undefined,
  };
}

const notIgnored = async () => false;
const alreadyIgnored = async () => true;

/**
 * Read the written `.gitignore`, failing loudly if it is absent.
 *
 * Narrows away the `string | undefined` a bare index gives, so an assertion
 * never silently compares against `undefined` — "the file was never written" and
 * "the file has the wrong contents" are different failures and should read
 * differently.
 */
function readGitignore(fs: { files: Record<string, string> }): string {
  const text = fs.files[GITIGNORE];
  if (text === undefined) throw new Error(`${GITIGNORE} was not written`);
  return text;
}

describe("mt#5014 AT1 — a fresh repo ends up ignoring the local config", () => {
  test("creates .gitignore carrying the entry when none exists", async () => {
    const fs = fakeFs();
    const result = await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(result.action).toBe("created");
    expect(readGitignore(fs)).toBe(`${LOCAL_CONFIG_GITIGNORE_ENTRY}\n`);
  });

  test("the entry it writes is the path setup db puts the password in", () => {
    expect(LOCAL_CONFIG_GITIGNORE_ENTRY).toBe(".minsky/config.local.yaml");
  });

  test("appends to an existing .gitignore that does not list it", async () => {
    const fs = fakeFs({ [GITIGNORE]: "node_modules\ndist\n" });
    const result = await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(result.action).toBe("appended");
    expect(readGitignore(fs)).toBe(`node_modules\ndist\n${LOCAL_CONFIG_GITIGNORE_ENTRY}\n`);
  });
});

describe("mt#5014 AT2 — an already-ignored path is left alone", () => {
  test("writes nothing when git already ignores it", async () => {
    const before = "node_modules\n.minsky/config.local.yaml\n";
    const fs = fakeFs({ [GITIGNORE]: before });
    const result = await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, alreadyIgnored);

    expect(result.action).toBe("already-ignored");
    expect(readGitignore(fs)).toBe(before);
  });

  test("SC3: ignored by a PARENT or GLOBAL gitignore adds no redundant entry", async () => {
    // The repo's own .gitignore does not mention it; git says it is ignored
    // anyway — the case only `git check-ignore` can see.
    const before = "node_modules\n";
    const fs = fakeFs({ [GITIGNORE]: before });
    const result = await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, alreadyIgnored);

    expect(result.action).toBe("already-ignored");
    expect(readGitignore(fs)).toBe(before);
  });

  test("SC2: running twice does not duplicate the entry", async () => {
    const fs = fakeFs();
    await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);
    const afterFirst = readGitignore(fs);

    // Second run: git now ignores it, which is what a real re-run observes.
    await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, alreadyIgnored);

    expect(readGitignore(fs)).toBe(afterFirst);
    expect(
      readGitignore(fs)
        .split("\n")
        .filter((l) => l === LOCAL_CONFIG_GITIGNORE_ENTRY)
    ).toHaveLength(1);
  });

  test("does not duplicate even if the probe cannot answer, because the text is checked too", async () => {
    // A fail-to-false probe (no git, not a repository) must not append a line
    // the file already carries.
    const before = `node_modules\n${LOCAL_CONFIG_GITIGNORE_ENTRY}\n`;
    const fs = fakeFs({ [GITIGNORE]: before });
    const result = await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(result.action).toBe("already-ignored");
    expect(readGitignore(fs)).toBe(before);
  });

  test("matches an existing entry that carries surrounding whitespace", async () => {
    const before = `node_modules\n  ${LOCAL_CONFIG_GITIGNORE_ENTRY}  \n`;
    const fs = fakeFs({ [GITIGNORE]: before });
    const result = await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(result.action).toBe("already-ignored");
    expect(readGitignore(fs)).toBe(before);
  });

  test("does not treat a SUBSTRING match as the entry", async () => {
    // `.minsky/config.local.yaml.bak` contains the entry as a substring but is
    // a different path; the file must still gain the real entry.
    const fs = fakeFs({ [GITIGNORE]: `${LOCAL_CONFIG_GITIGNORE_ENTRY}.bak\n` });
    const result = await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(result.action).toBe("appended");
    expect(readGitignore(fs)).toBe(
      `${LOCAL_CONFIG_GITIGNORE_ENTRY}.bak\n${LOCAL_CONFIG_GITIGNORE_ENTRY}\n`
    );
  });
});

describe("mt#5014 AT3 — every pre-existing line survives", () => {
  test("preserves all prior content when appending", async () => {
    const before = "# build output\ndist/\n\n# deps\nnode_modules/\n";
    const fs = fakeFs({ [GITIGNORE]: before });
    await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(readGitignore(fs).startsWith(before)).toBe(true);
    for (const line of before.split("\n")) {
      expect(readGitignore(fs).split("\n")).toContain(line);
    }
  });

  test("inserts a separating newline when the file does not end in one", async () => {
    const fs = fakeFs({ [GITIGNORE]: "node_modules" });
    await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(readGitignore(fs)).toBe(`node_modules\n${LOCAL_CONFIG_GITIGNORE_ENTRY}\n`);
  });

  test("handles an empty .gitignore without a leading blank line", async () => {
    const fs = fakeFs({ [GITIGNORE]: "" });
    await ensurePathIgnored(REPO, LOCAL_CONFIG_GITIGNORE_ENTRY, fs, notIgnored);

    expect(readGitignore(fs)).toBe(`${LOCAL_CONFIG_GITIGNORE_ENTRY}\n`);
  });
});
