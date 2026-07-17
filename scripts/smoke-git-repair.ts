#!/usr/bin/env bun
import "reflect-metadata";
/**
 * Smoke: git-state repair affordances (mt#2820)
 *
 * Verifies the three acceptance tests from the mt#2820 spec end-to-end
 * through the FULL command-registry execute path (not just the underlying
 * domain functions — this exercises the same code the `git_status`,
 * `git_repair_lock`, and `git_repair_refs` MCP tools call) against a real
 * scratch git repository:
 *
 *   1. A stale zero-byte index.lock (no owning git process) is detected
 *      (age + liveness reported) and removed with confirm.
 *   2. A lock held by a LIVE git process is reported busy and NOT removed.
 *   3. A simulated bad remote-tracking ref is identified, repaired
 *      (delete + re-fetch), and a subsequent operation succeeds.
 *
 * Runnable: `bun scripts/smoke-git-repair.ts`. Exit 0 = pass, non-zero = fail.
 */

import { mkdtemp, rm, writeFile, mkdir, utimes } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execAsync(`git -C ${JSON.stringify(cwd)} ${args.join(" ")}`);
  return stdout.trim();
}

async function main(): Promise<number> {
  const failures: string[] = [];

  const { sharedCommandRegistry, CommandCategory } = await import(
    "../src/adapters/shared/command-registry"
  );
  const { registerGitCommands } = await import("../src/adapters/shared/commands/git");
  const { LOCK_STALE_THRESHOLD_MS } = await import("@minsky/domain/git/lock-operations");

  registerGitCommands();

  // --- Command registration wiring -----------------------------------------
  console.log("--- command registration ---");
  for (const id of ["git.repair_lock", "git.repair_refs", "git.status", "git.restore"]) {
    const cmd = sharedCommandRegistry.getCommand(id);
    console.log(`  ${id}: ${cmd ? `found (category=${cmd.category})` : "MISSING"}`);
    if (!cmd) {
      failures.push(`Expected sharedCommandRegistry to contain '${id}' after registration`);
    } else if (cmd.category !== CommandCategory.GIT) {
      failures.push(`Expected '${id}' category to be ${CommandCategory.GIT}, got ${cmd.category}`);
    }
  }

  const repairLockCmd = sharedCommandRegistry.getCommand("git.repair_lock");
  const repairRefsCmd = sharedCommandRegistry.getCommand("git.repair_refs");
  const statusCmd = sharedCommandRegistry.getCommand("git.status");
  const restoreCmd = sharedCommandRegistry.getCommand("git.restore");

  if (!repairLockCmd || !repairRefsCmd || !statusCmd || !restoreCmd) {
    console.error("\nFAIL: required commands not registered — aborting remaining checks.");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }

  // --- Fixture: a plain repo for lock scenarios -----------------------------
  const tmpBase = await mkdtemp(join(tmpdir(), "minsky-smoke-git-repair-"));
  const repoPath = join(tmpBase, "repo");
  await mkdir(repoPath, { recursive: true });
  await execAsync(`git init ${JSON.stringify(repoPath)}`);
  await execAsync(`git -C ${JSON.stringify(repoPath)} config user.email "test@example.com"`);
  await execAsync(`git -C ${JSON.stringify(repoPath)} config user.name "Test User"`);
  await writeFile(join(repoPath, "readme.md"), "# smoke test\n");
  await execAsync(`git -C ${JSON.stringify(repoPath)} add .`);
  await execAsync(`git -C ${JSON.stringify(repoPath)} commit -m "initial"`);
  const gitDir = await git(repoPath, "rev-parse", "--absolute-git-dir");
  const lockPath = join(gitDir, "index.lock");

  try {
    // --- Acceptance test 1: stale zero-byte lock, detect + remove w/ confirm
    console.log("\n--- AT1: stale zero-byte index.lock (no owning process) ---");
    await writeFile(lockPath, "");
    const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
    await utimes(lockPath, staleTime, staleTime);

    const diagnostic = (await repairLockCmd.execute({ repo: repoPath }, {})) as {
      present: boolean;
      staleEligible: boolean;
      liveProcess: boolean;
      ageMs: number;
      message: string;
    };
    console.log("  diagnostic (no confirm):", JSON.stringify(diagnostic));
    if (!diagnostic.present) failures.push("AT1: expected lock to be reported present");
    if (!diagnostic.staleEligible)
      failures.push("AT1: expected lock to be reported stale-eligible");
    if (diagnostic.liveProcess) failures.push("AT1: expected liveProcess=false for an unheld lock");
    if (existsSync(lockPath) !== true)
      failures.push("AT1: diagnostic call must NOT remove the lock");

    // Also exercise the enriched-error path via a blocked git.restore call.
    // NOTE: plain `git status` is lock-TOLERANT (since git 1.7.x it degrades
    // gracefully — skips refreshing the on-disk index cache but still
    // reports status, exit 0 — it does not hard-fail on index.lock
    // contention). `git restore` (like the original mt#2820 incident) DOES
    // require the exclusive lock and fails hard, so that's the tool this
    // enrichment path is demonstrated against.
    await writeFile(join(repoPath, "readme.md"), "# smoke test (modified)\n");
    const restoreResult = (await restoreCmd
      .execute({ repo: repoPath, paths: ["readme.md"] }, {})
      .catch((e: Error) => ({
        __threw: true,
        message: e.message,
      }))) as { __threw?: boolean; message?: string };
    console.log(
      "  git.restore while locked (no repairLock):",
      restoreResult.__threw ? "threw (expected)" : "DID NOT THROW"
    );
    if (!restoreResult.__threw) {
      failures.push("AT1: git.restore against a locked repo without repairLock should throw");
    } else if (!/index\.lock/.test(restoreResult.message ?? "")) {
      failures.push(`AT1: expected enriched lock error, got: ${restoreResult.message}`);
    } else {
      console.log(`    -> ${restoreResult.message?.split("\n")[1]}`);
    }

    // git_status itself confirms the lock-tolerant behavior noted above —
    // it succeeds even while the lock is present.
    const statusWhileLocked = (await statusCmd.execute({ repo: repoPath }, {})) as {
      success: boolean;
    };
    if (!statusWhileLocked.success) {
      failures.push("AT1: git.status is expected to be lock-tolerant (should succeed)");
    }

    const repairResult = (await repairLockCmd.execute({ repo: repoPath, confirm: true }, {})) as {
      removed: boolean;
      message: string;
    };
    console.log("  repair (confirm: true):", JSON.stringify(repairResult));
    if (!repairResult.removed) failures.push("AT1: expected the stale lock to be removed");
    if (existsSync(lockPath)) failures.push("AT1: lock file must be gone after repair");

    // Operation succeeds now that the lock is gone
    const statusAfter = (await statusCmd.execute({ repo: repoPath }, {})) as { success: boolean };
    if (!statusAfter.success) failures.push("AT1: git.status should succeed after lock repair");

    // --- Acceptance test 2: lock held by a LIVE process -> busy, not removed
    console.log("\n--- AT2: index.lock held by a LIVE git process ---");
    const holder = spawn("sh", ["-c", `exec 3<> ${JSON.stringify(lockPath)}; sleep 6`], {
      cwd: repoPath,
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      const liveDiagnostic = (await repairLockCmd.execute({ repo: repoPath }, {})) as {
        liveProcess: boolean;
        holderPid?: number;
        message: string;
      };
      console.log("  diagnostic (live holder):", JSON.stringify(liveDiagnostic));
      if (!liveDiagnostic.liveProcess) {
        failures.push("AT2: expected liveProcess=true while the holder is alive");
      }

      let repairThrew = false;
      let repairMessage = "";
      try {
        await repairLockCmd.execute({ repo: repoPath, confirm: true }, {});
      } catch (e) {
        repairThrew = true;
        repairMessage = e instanceof Error ? e.message : String(e);
      }
      console.log(
        `  repair attempt (confirm: true): ${repairThrew ? "threw (expected)" : "DID NOT THROW"}`
      );
      if (!repairThrew) {
        failures.push("AT2: repairing a live-held lock must throw (busy), not silently no-op");
      } else if (!/busy, not stale/.test(repairMessage)) {
        failures.push(`AT2: expected 'busy, not stale' in error, got: ${repairMessage}`);
      }
      if (!existsSync(lockPath)) failures.push("AT2: live-held lock must NOT be removed");
    } finally {
      holder.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rm(lockPath, { force: true });
    }

    // --- Acceptance test 3: simulated bad remote ref -> repaired, op succeeds
    console.log("\n--- AT3: simulated bad remote ref ---");
    const originPath = join(tmpBase, "origin.git");
    const workPath = join(tmpBase, "work");
    await mkdir(originPath, { recursive: true });
    await execAsync(`git init --bare ${JSON.stringify(originPath)}`);
    await mkdir(workPath, { recursive: true });
    await execAsync(`git clone ${JSON.stringify(originPath)} ${JSON.stringify(workPath)}`);
    await execAsync(`git -C ${JSON.stringify(workPath)} config user.email "test@example.com"`);
    await execAsync(`git -C ${JSON.stringify(workPath)} config user.name "Test User"`);
    await git(workPath, "checkout", "-b", "main");
    await writeFile(join(workPath, "readme.md"), "# work\n");
    await git(workPath, "add", ".");
    await git(workPath, "commit", "-m", '"initial"');
    await git(workPath, "push", "-u", "origin", "main");
    await git(workPath, "checkout", "-b", "task/mt-2304");
    await writeFile(join(workPath, "feature.md"), "# feature\n");
    await git(workPath, "add", ".");
    await git(workPath, "commit", "-m", '"feature"');
    await git(workPath, "push", "-u", "origin", "task/mt-2304");
    await git(workPath, "checkout", "main");

    const ref = "refs/remotes/origin/task/mt-2304";
    await mkdir(join(workPath, ".git", "refs", "remotes", "origin", "task"), { recursive: true });
    await writeFile(
      join(workPath, ".git", "refs", "remotes", "origin", "task", "mt-2304"),
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n"
    );

    const refDiagnostic = (await repairRefsCmd.execute({ repo: workPath, ref }, {})) as {
      bad: boolean;
      error?: string;
    };
    console.log("  identify:", JSON.stringify(refDiagnostic));
    if (!refDiagnostic.bad) failures.push("AT3: expected the corrupted ref to be reported bad");

    const refRepair = (await repairRefsCmd.execute({ repo: workPath, ref, confirm: true }, {})) as {
      deleted: boolean;
      refetched: boolean;
    };
    console.log("  repair:", JSON.stringify(refRepair));
    if (!refRepair.deleted || !refRepair.refetched) {
      failures.push("AT3: expected delete + re-fetch to both succeed");
    }

    const refRecheck = (await repairRefsCmd.execute({ repo: workPath, ref }, {})) as {
      bad: boolean;
    };
    console.log("  recheck:", JSON.stringify(refRecheck));
    if (refRecheck.bad) failures.push("AT3: ref should resolve cleanly after repair");
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }

  // --- Summary ---------------------------------------------------------------
  console.log("\n--- summary ---");
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("PASS: all git-state repair smoke checks passed.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: smoke-git-repair threw an unexpected error:", err);
    process.exit(1);
  });
