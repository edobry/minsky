/**
 * Tests for sessionCommit's mass-deletion sanity gate (mt#3021 SC3, AT2/AT3).
 *
 * Strategy mirrors session-commit-no-files.test.ts: real temp git repos,
 * because the gate shells out to git via dynamic imports and its correctness
 * depends on real `git diff --name-status` semantics.
 */
import { describe, test, expect, afterAll } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests -- real git repos required to exercise the gate end-to-end */
import { mkdtemp, rm, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "path";
import { execSync } from "child_process";
import { sessionCommit, MassDeletionGuardError } from "./session-commands";
import { DEFAULT_MASS_DELETION_THRESHOLD } from "../git/commit-deletion-stats";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "test-session-uuid",
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#3021",
    ...overrides,
  };
}

function makeSessionProvider(record: SessionRecord, workdir: string): FakeSessionProvider {
  return new FakeSessionProvider({ initialSessions: [record], sessionWorkdir: workdir });
}

async function makeTmpCleanGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-mass-deletion-test-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function addLocalRemote(repoDir: string): string {
  const bareDir = `${repoDir}.bare`;
  execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
  return bareDir;
}

function pushOriginMain(repoDir: string): void {
  execSync("git push origin main", { cwd: repoDir, stdio: "ignore" });
}

function remoteMainLog(repoDir: string): string {
  return execSync("git log --oneline -1 origin/main", { cwd: repoDir }).toString();
}

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // eslint-disable-line custom/no-real-fs-in-tests
  }
});

describe("sessionCommit mass-deletion sanity gate", () => {
  test("AT2: refuses to push a commit deleting more than the threshold, absent an override — commit stays local", async () => {
    const repoDir = await makeTmpCleanGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const fileCount = DEFAULT_MASS_DELETION_THRESHOLD + 5;
    for (let i = 0; i < fileCount; i++) {
      await writeFile(join(repoDir, `f${i}.txt`), String(i)); // eslint-disable-line custom/no-real-fs-in-tests
    }
    execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
    execSync('git commit -m "add many files"', { cwd: repoDir, stdio: "ignore" });
    pushOriginMain(repoDir);

    for (let i = 0; i < fileCount; i++) {
      await unlink(join(repoDir, `f${i}.txt`)); // eslint-disable-line custom/no-real-fs-in-tests
    }

    const record = makeSessionRecord({ sessionId: "mass-deletion-refused-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    let caught: unknown;
    try {
      await sessionCommit(
        {
          session: "mass-deletion-refused-session",
          message: "chore: delete everything",
          all: true,
        },
        sessionProvider
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MassDeletionGuardError);
    const guardErr = caught as MassDeletionGuardError;
    expect(guardErr.deletionCount).toBe(fileCount);
    expect(guardErr.threshold).toBe(DEFAULT_MASS_DELETION_THRESHOLD);

    // The commit landed LOCALLY (cheap to recover) but was never pushed.
    const localLog = execSync("git log --oneline -1", { cwd: repoDir }).toString();
    expect(localLog).toContain("delete everything");
    const remoteLog = remoteMainLog(repoDir);
    expect(remoteLog).not.toContain("delete everything");
  });

  test("AT2 (override path): the same commit succeeds and pushes when an override reason is supplied", async () => {
    const repoDir = await makeTmpCleanGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const fileCount = DEFAULT_MASS_DELETION_THRESHOLD + 5;
    for (let i = 0; i < fileCount; i++) {
      await writeFile(join(repoDir, `f${i}.txt`), String(i)); // eslint-disable-line custom/no-real-fs-in-tests
    }
    execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
    execSync('git commit -m "add many files"', { cwd: repoDir, stdio: "ignore" });
    pushOriginMain(repoDir);

    for (let i = 0; i < fileCount; i++) {
      await unlink(join(repoDir, `f${i}.txt`)); // eslint-disable-line custom/no-real-fs-in-tests
    }

    const record = makeSessionRecord({ sessionId: "mass-deletion-override-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      {
        session: "mass-deletion-override-session",
        message: "chore: intentional cleanup",
        all: true,
        destructiveOverrideReason: "intentional directory purge, verified by hand",
      },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    const remoteLog = remoteMainLog(repoDir);
    expect(remoteLog).toContain("intentional cleanup");
  });

  test("AT3: a normal-sized deletion is NOT refused (no-over-fire)", async () => {
    const repoDir = await makeTmpCleanGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    for (let i = 0; i < 10; i++) {
      await writeFile(join(repoDir, `f${i}.txt`), String(i)); // eslint-disable-line custom/no-real-fs-in-tests
    }
    execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
    execSync('git commit -m "add ten files"', { cwd: repoDir, stdio: "ignore" });
    pushOriginMain(repoDir);

    for (let i = 0; i < 5; i++) {
      await unlink(join(repoDir, `f${i}.txt`)); // eslint-disable-line custom/no-real-fs-in-tests
    }

    const record = makeSessionRecord({ sessionId: "normal-deletion-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      { session: "normal-deletion-session", message: "chore: delete a few files", all: true },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    const remoteLog = remoteMainLog(repoDir);
    expect(remoteLog).toContain("delete a few files");
  });
});
