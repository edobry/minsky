/* eslint-disable custom/no-real-fs-in-tests */
// Justification: git-exec integration test (same class as
// mt1509-deadlock.test.ts and lock-operations.test.ts) — corrupts a real
// remote-tracking ref by writing a bogus SHA directly into the packed/loose
// ref file, then verifies detection, confirm-gated repair, and re-fetch
// against a real bare "origin" + working clone. Not mockable without
// hollowing out the exact git object-store behavior under test.

/**
 * mt#2820 — stale/corrupt remote-ref repair affordance.
 *
 * Reproduces the mt#2820 incident shape: `fatal: bad object
 * refs/remotes/origin/<branch>` — simulated by writing an invalid SHA into
 * the loose ref file, then repairing via identify -> `update-ref -d` ->
 * re-fetch.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";

import { checkRef, scanForBadRefs, repairBadRef, parseBadObjectRef } from "./ref-repair-operations";

const execAsync = promisify(exec);

async function realExec(command: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execAsync(command);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const realDeps = { execAsync: realExec };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execAsync(`git -C ${JSON.stringify(cwd)} ${args.join(" ")}`);
  return stdout.trim();
}

let tmpBase: string;
let originPath: string;
let workPath: string;
const BRANCH = "task/mt-2304";

beforeAll(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), "minsky-mt2820-refs-"));
  originPath = join(tmpBase, "origin.git");
  workPath = join(tmpBase, "work");

  await mkdir(originPath, { recursive: true });
  await execAsync(`git init --bare ${JSON.stringify(originPath)}`);

  await mkdir(workPath, { recursive: true });
  await execAsync(`git clone ${JSON.stringify(originPath)} ${JSON.stringify(workPath)}`);
  await execAsync(`git -C ${JSON.stringify(workPath)} config user.email "test@example.com"`);
  await execAsync(`git -C ${JSON.stringify(workPath)} config user.name "Test User"`);
  await git(workPath, "checkout", "-b", "main");
  await writeFile(join(workPath, "readme.md"), "# test\n");
  await git(workPath, "add", ".");
  await git(workPath, "commit", "-m", '"initial"');
  await git(workPath, "push", "-u", "origin", "main");

  // Create + push a second branch (the one whose remote-tracking ref we'll
  // corrupt, matching the incident's `refs/remotes/origin/task/mt-2304`).
  await git(workPath, "checkout", "-b", BRANCH);
  await writeFile(join(workPath, "feature.md"), "# feature\n");
  await git(workPath, "add", ".");
  await git(workPath, "commit", "-m", '"feature commit"');
  await git(workPath, "push", "-u", "origin", BRANCH);
  await git(workPath, "checkout", "main");
});

afterAll(async () => {
  if (tmpBase) {
    await rm(tmpBase, { recursive: true, force: true });
  }
});

describe("parseBadObjectRef", () => {
  test("extracts the ref from the classic git fatal", () => {
    expect(parseBadObjectRef("fatal: bad object refs/remotes/origin/task/mt-2304")).toBe(
      "refs/remotes/origin/task/mt-2304"
    );
  });

  test("returns null for unrelated stderr", () => {
    expect(parseBadObjectRef("fatal: Unable to create index.lock: File exists")).toBeNull();
  });
});

describe("checkRef — healthy ref", () => {
  test("a valid remote-tracking ref is reported not bad", async () => {
    const result = await checkRef(
      { repoPath: workPath, ref: `refs/remotes/origin/${BRANCH}` },
      realDeps
    );
    expect(result.bad).toBe(false);
  });
});

describe("checkRef / repairBadRef — simulated corrupt remote ref", () => {
  const refPath = () => join(workPath, ".git", "refs", "remotes", "origin", ...BRANCH.split("/"));

  test("acceptance: a simulated bad remote ref is identified, repaired (delete + re-fetch), and the operation succeeds", async () => {
    // Arrange: corrupt the loose ref file with a bogus (well-formed-looking
    // but non-existent) SHA — reproduces `fatal: bad object
    // refs/remotes/origin/task/mt-2304` on any command that resolves it.
    await mkdir(join(workPath, ".git", "refs", "remotes", "origin", "task"), {
      recursive: true,
    });
    await writeFile(refPath(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");

    const ref = `refs/remotes/origin/${BRANCH}`;

    // Act: identify
    const check = await checkRef({ repoPath: workPath, ref }, realDeps);
    expect(check.bad).toBe(true);
    expect(check.error).toMatch(/bad object|not a valid object/i);

    // Repair without confirm must refuse
    await expect(
      repairBadRef({ repoPath: workPath, ref, confirm: false }, realDeps)
    ).rejects.toThrow(/confirm: true/);

    // Repair WITH confirm: delete + re-fetch
    const result = await repairBadRef({ repoPath: workPath, ref, confirm: true }, realDeps);
    expect(result.deleted).toBe(true);
    expect(result.refetched).toBe(true);
    expect(result.ref).toBe(ref);

    // The ref should now resolve cleanly again (re-created by the re-fetch,
    // since it still legitimately exists on origin).
    const recheck = await checkRef({ repoPath: workPath, ref }, realDeps);
    expect(recheck.bad).toBe(false);
  });

  test("refuses to delete a ref that is not actually bad", async () => {
    const ref = `refs/remotes/origin/${BRANCH}`;
    await expect(
      repairBadRef({ repoPath: workPath, ref, confirm: true }, realDeps)
    ).rejects.toThrow(/not corrupt/);
  });
});

describe("scanForBadRefs", () => {
  test("finds a corrupted ref among healthy ones under a prefix", async () => {
    const refDir = join(workPath, ".git", "refs", "remotes", "origin", "task");
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, "mt-2304"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");

    try {
      const results = await scanForBadRefs(
        { repoPath: workPath, refPrefix: "refs/remotes/origin" },
        realDeps
      );
      const mainRef = results.find((r) => r.ref === "refs/remotes/origin/main");
      const badRef = results.find((r) => r.ref === `refs/remotes/origin/${BRANCH}`);

      expect(mainRef?.bad).toBe(false);
      expect(badRef?.bad).toBe(true);
    } finally {
      // Repair it back so subsequent test files touching this fixture (if
      // any were added later) aren't left with a corrupt ref.
      await repairBadRef(
        { repoPath: workPath, ref: `refs/remotes/origin/${BRANCH}`, confirm: true },
        realDeps
      ).catch(() => {});
    }
  });
});
