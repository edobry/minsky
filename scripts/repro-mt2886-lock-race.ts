#!/usr/bin/env bun
/**
 * Repro harness: cross-process `.git/index.lock` race (mt#2886)
 *
 * mt#2820 closed two lock-abandonment gaps (staleness detection/repair,
 * 60s exec timeout hardening) but explicitly did NOT close a third,
 * structurally distinct gap: two separate MCP server processes racing for
 * the same repo's `.git/index.lock` during a rapid staleness-exit/respawn
 * cycle. This harness establishes whether that race class is reachable in
 * practice, and — once the mt#2886 fix (bounded retry-backoff in
 * `runGitCommandWithLockHandling`) is in place — demonstrates that it
 * absorbs the race without regressing genuine external contention.
 *
 * mt#2830 (merged 2026-07-17, same day as this task's plan decision)
 * idle-gap-sequenced staleness exits, NARROWING the naive respawn-churn
 * overlap window this task's spec evidence describes. It does not close
 * the cross-process gap: a fresh process B's call can still race a
 * winding-down process A's UNTRACKED (fire-and-forget) subprocess. Phase 2
 * below models exactly that residual window, not the pre-mt#2830 naive
 * churn.
 *
 * NEVER run against the real main workspace — this harness creates and
 * destroys its own scratch git repository under a temp directory.
 *
 * Dual-mode (mt#2886 Execution-evidence requirement):
 *   Phase 1 — RAW natural race: two real child OS processes running a
 *     tight loop of real `git commit --allow-empty` against the SAME
 *     scratch repo, concurrently, with NO Minsky wrapping. Establishes
 *     that `.git/index.lock` contention between two independent processes
 *     is a real, observable mechanism (not merely theoretical).
 *   Phase 2 — Controlled residual-window reproduction (RAW): a "dying
 *     process" holds `.git/index.lock` open for a short, deliberate
 *     window (simulating an untracked subprocess winding down), while a
 *     "fresh process" immediately attempts a real git write against the
 *     same repo with NO retry — demonstrating the race class is reachable
 *     for the EXACT scenario mt#2886's spec names.
 *   Phase 3 — Same controlled scenario, but the "fresh process" call goes
 *     through the FIXED `runGitCommandWithLockHandling` (mt#2886's
 *     bounded retry-backoff) — demonstrating the fix absorbs the
 *     transient race.
 *   Phase 4 — Non-regression, repairLock: false (default): a genuinely
 *     persistent (EXTERNAL-style) lock hold well beyond the retry budget —
 *     the FIXED path must still surface the actionable enriched busy
 *     error, bounded by ~2s, not hang indefinitely and not silently
 *     succeed.
 *   Phase 5 — Non-regression, repairLock: true (PR #2031 R1 addition): the
 *     SAME persistent LIVE lock, but with `repairLock: true` — the retry
 *     budget must still exhaust first, then `repairIndexLock`'s OWN busy
 *     error ("busy, not stale") must propagate unchanged, not be swallowed
 *     or replaced by a generic failure.
 *
 * Runnable: `bun scripts/repro-mt2886-lock-race.ts`. Exit 0 = all phases
 * behaved as expected, non-zero = a phase's assertion failed.
 */
import "reflect-metadata";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execAsync(`git -C ${shellQuote(cwd)} ${args.join(" ")}`);
  return stdout.trim();
}

async function setupRepo(): Promise<{ tmpBase: string; repoPath: string; lockPath: string }> {
  const tmpBase = await mkdtemp(join(tmpdir(), "minsky-mt2886-lock-race-"));
  const repoPath = join(tmpBase, "repo");
  await mkdir(repoPath, { recursive: true });
  await execAsync(`git init ${shellQuote(repoPath)}`);
  await execAsync(`git -C ${shellQuote(repoPath)} config user.email "test@example.com"`);
  await execAsync(`git -C ${shellQuote(repoPath)} config user.name "Test User"`);
  await writeFile(join(repoPath, "readme.md"), "# scratch\n");
  await execAsync(`git -C ${shellQuote(repoPath)} add .`);
  await execAsync(`git -C ${shellQuote(repoPath)} commit -m "initial"`);
  const gitDir = await git(repoPath, "rev-parse", "--absolute-git-dir");
  const lockPath = join(gitDir, "index.lock");
  return { tmpBase, repoPath, lockPath };
}

/**
 * Spawn an independent OS process that acquires `.git/index.lock` via a
 * TRUE exclusive-create — `fs.openSync(path, "wx")`, i.e.
 * `O_WRONLY|O_CREAT|O_EXCL` — faithfully mirroring git's own lockfile
 * acquisition protocol (`lockfile.c`'s `hold_lock_file_for_update` opens
 * with the same `O_CREAT|O_EXCL` combination, so it fails with EEXIST if
 * the path is already locked, exactly like this helper does). PR #2031 R1:
 * the prior version used a shell `exec 3>path` redirect, which is a
 * truncate-and-open (`O_WRONLY|O_CREAT|O_TRUNC`) — NOT exclusive — so it
 * would silently succeed even if the file already existed, unlike git's
 * real acquire. This helper is the faithful mirror instead.
 *
 * Runs in a genuinely separate process (not just an in-process fd) so it
 * represents "a different OS process holds this lock" — the exact
 * condition mt#2886 investigates — not merely a same-process open handle.
 * The close-listener is attached BEFORE any other await, per the
 * documented Node child_process race (a fast-finishing holder can close —
 * and fire its event — before a later `.on("close", ...)` attachment would
 * ever see it).
 */
function spawnExclusiveLockHolder(
  lockPath: string,
  holdMs: number
): { proc: ChildProcess; closed: Promise<unknown> } {
  const code = `
    const fs = require("fs");
    const [lockPath, holdMsStr] = process.argv.slice(1);
    const holdMs = Number(holdMsStr);
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (e) {
      console.error("ACQUIRE_FAILED:" + (e && e.message));
      process.exit(2);
    }
    fs.closeSync(fd);
    await new Promise((r) => setTimeout(r, holdMs));
    fs.rmSync(lockPath, { force: true });
  `;
  const proc = spawn("bun", ["-e", code, "--", lockPath, String(holdMs)], { stdio: "ignore" });
  const closed = new Promise((resolve, reject) => {
    proc.on("close", resolve);
    proc.on("error", reject);
  });
  return { proc, closed };
}

/** Spawn a child process that loops N real `git commit --allow-empty` calls as fast as possible. */
function spawnCommitLoop(repoPath: string, iterations: number): Promise<{ collisions: number }> {
  const script = `
    cd ${shellQuote(repoPath)}
    collisions=0
    for i in $(seq 1 ${iterations}); do
      out=$(git commit -q --allow-empty -m "race-$i" 2>&1)
      if echo "$out" | grep -q "index.lock"; then
        collisions=$((collisions+1))
      fi
    done
    echo "COLLISIONS=$collisions"
  `;
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const m = out.match(/COLLISIONS=(\d+)/);
      resolve({ collisions: m ? Number.parseInt(m[1] ?? "0", 10) : 0 });
    });
    child.on("error", reject);
  });
}

/**
 * Phase 1: two real, independent OS processes running tight commit loops
 * against the SAME repo, concurrently, with no coordination whatsoever.
 * A "collision" is a raw `index.lock: File exists` fatal.
 */
async function phase1RawNaturalRace(repoPath: string): Promise<{ pass: boolean; detail: string }> {
  const ITERATIONS = 60;
  const [a, b] = await Promise.all([
    spawnCommitLoop(repoPath, ITERATIONS),
    spawnCommitLoop(repoPath, ITERATIONS),
  ]);
  const totalCollisions = a.collisions + b.collisions;
  const detail =
    `${ITERATIONS * 2} concurrent commit attempts across 2 independent processes ` +
    `(${ITERATIONS} each) -> ${totalCollisions} raw index.lock collisions ` +
    `(process A: ${a.collisions}, process B: ${b.collisions})`;
  // This phase's PASS condition is just "ran to completion and reports a
  // number" — the interesting empirical finding is totalCollisions itself,
  // reported in the summary. A positive count is direct confirmation the
  // race class is reachable; a zero count on a fast/quiet machine is not
  // proof of absence (see phase 2's deterministic reproduction).
  return { pass: true, detail };
}

/**
 * Phase 2: controlled residual-window reproduction. Process A ("dying
 * process's untracked subprocess") acquires `.git/index.lock` via a TRUE
 * exclusive-create (mirroring git's own O_CREAT|O_EXCL acquire) and holds
 * it open for `holdMs`, then releases it. Process B ("freshly spawned
 * sibling process's new git_* call") starts ~0ms later and attempts a REAL
 * git write with NO retry (raw). Demonstrates the exact race class
 * mt#2886's spec describes is reachable when the windows overlap.
 */
async function phase2ControlledRaceRaw(
  repoPath: string,
  lockPath: string,
  holdMs: number
): Promise<{ pass: boolean; detail: string; raced: boolean }> {
  const { closed: holderClosed } = spawnExclusiveLockHolder(lockPath, holdMs);

  // Give the holder a brief instant to actually create the lock file
  // (mirrors the near-zero, but non-zero, scheduling gap between a dying
  // process's last subprocess spawn and a freshly spawned sibling
  // process's first call).
  await new Promise((resolve) => setTimeout(resolve, 20));
  const lockPresentAtRaceStart = existsSync(lockPath);

  let raced = false;
  let errorMessage = "";
  try {
    await execAsync(`git -C ${shellQuote(repoPath)} commit -q --allow-empty -m "fresh-process"`);
  } catch (err) {
    raced = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  await holderClosed;
  // Cleanup in case the holder's own unlink somehow didn't fire (e.g. B
  // raced the unlink) — never leave a real lock behind.
  await rm(lockPath, { force: true });

  const detail =
    `holdMs=${holdMs}, lock present at race start=${lockPresentAtRaceStart}, ` +
    `fresh-process raw call raced=${raced}${raced ? ` (${errorMessage.split("\n")[0]})` : ""}`;
  // PASS condition: the controlled scenario successfully demonstrates
  // whatever it's testing for — the caller inspects `raced` for the
  // finding itself. This function always "passes" in the sense of running
  // cleanly; the race determination is the payload.
  return { pass: true, detail, raced };
}

/**
 * Phase 3: same controlled scenario as phase 2, but the "fresh process"
 * call goes through the FIXED `runGitCommandWithLockHandling` (mt#2886).
 * Demonstrates the bounded retry-backoff absorbs a transient race.
 */
async function phase3ControlledRaceFixed(
  repoPath: string,
  lockPath: string,
  holdMs: number
): Promise<{ pass: boolean; detail: string }> {
  const { runGitCommandWithLockHandling } = await import(
    "../packages/domain/src/git/lock-operations"
  );

  const { closed: holderClosed } = spawnExclusiveLockHolder(lockPath, holdMs);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const execAsyncDep = (command: string) => execAsync(command);
  const start = Date.now();
  let succeeded = false;
  let errorMessage = "";
  try {
    await runGitCommandWithLockHandling(
      `git -C ${shellQuote(repoPath)} commit -q --allow-empty -m "fresh-process-fixed"`,
      { execAsync: execAsyncDep },
      { repoPath }
    );
    succeeded = true;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const elapsedMs = Date.now() - start;

  await holderClosed;
  await rm(lockPath, { force: true });

  const detail =
    `holdMs=${holdMs}, wrapped call succeeded=${succeeded}, elapsedMs=${elapsedMs}` +
    `${succeeded ? "" : ` (error: ${errorMessage.split("\n")[0]})`}`;
  // PASS: the transient (holdMs well within the retry budget) race is
  // fully absorbed — the wrapped call must succeed.
  return { pass: succeeded, detail };
}

/**
 * Phase 4: non-regression, repairLock: false (default). A genuinely
 * persistent, EXTERNAL-style lock hold (well beyond the retry budget) —
 * the FIXED path must still surface the actionable ENRICHED busy error
 * ("Git operation blocked by index.lock... Pass `repairLock: true`..."),
 * bounded by ~2s (not immediate, not indefinite, not silently swallowed).
 */
async function phase4NonRegressionBusyErrorNoRepair(
  repoPath: string,
  lockPath: string
): Promise<{ pass: boolean; detail: string }> {
  const { runGitCommandWithLockHandling } = await import(
    "../packages/domain/src/git/lock-operations"
  );

  // Hold the lock for 6s — far longer than the ~2s retry budget, modeling
  // a genuine external git process (or a wedged one, pre-mt#2820 timeout
  // notwithstanding) that is still legitimately running.
  const { proc: holder } = spawnExclusiveLockHolder(lockPath, 6000);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const execAsyncDep = (command: string) => execAsync(command);
  const start = Date.now();
  let threw = false;
  let message = "";
  try {
    await runGitCommandWithLockHandling(
      `git -C ${shellQuote(repoPath)} commit -q --allow-empty -m "should-not-succeed"`,
      { execAsync: execAsyncDep },
      { repoPath, repairLock: false }
    );
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  const elapsedMs = Date.now() - start;

  holder.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(lockPath, { force: true });

  const detail =
    `wrapped call threw=${threw}, elapsedMs=${elapsedMs} ` +
    `(expect: threw=true, elapsedMs in [~2000, ~4000)), message contains 'repairLock: true'=` +
    `${message.includes("repairLock: true")}`;
  const pass =
    threw &&
    message.includes("repairLock: true") &&
    elapsedMs >= 1900 && // the full ~2s backoff budget was actually spent
    elapsedMs < 4500; // but bounded — nowhere near the 6s external hold
  return { pass, detail };
}

/**
 * Phase 5 (PR #2031 R1 addition): non-regression, repairLock: true. The
 * SAME persistent LIVE lock hold as phase 4, but with `repairLock: true`.
 * The retry budget must still exhaust first (a genuinely live lock is
 * never "stale", so the retries can't absorb it), and then
 * `repairIndexLock`'s OWN busy error ("busy, not stale... will not
 * remove") must propagate unchanged — the R1 review's concern was that
 * this branch could swallow the actionable error; this phase proves it
 * does not, against a REAL cross-process lock (not a mock).
 */
async function phase5NonRegressionBusyErrorWithRepairLock(
  repoPath: string,
  lockPath: string
): Promise<{ pass: boolean; detail: string }> {
  const { runGitCommandWithLockHandling } = await import(
    "../packages/domain/src/git/lock-operations"
  );

  const { proc: holder } = spawnExclusiveLockHolder(lockPath, 6000);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const execAsyncDep = (command: string) => execAsync(command);
  const start = Date.now();
  let threw = false;
  let message = "";
  try {
    await runGitCommandWithLockHandling(
      `git -C ${shellQuote(repoPath)} commit -q --allow-empty -m "should-not-succeed-repairlock"`,
      { execAsync: execAsyncDep },
      { repoPath, repairLock: true }
    );
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  const elapsedMs = Date.now() - start;

  holder.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(lockPath, { force: true });

  const detail =
    `wrapped call (repairLock:true) threw=${threw}, elapsedMs=${elapsedMs} ` +
    `(expect: threw=true, elapsedMs in [~2000, ~5000)), message contains 'busy, not stale'=` +
    `${message.includes("busy, not stale")}`;
  const pass =
    threw &&
    message.includes("busy, not stale") &&
    elapsedMs >= 1900 && // the full ~2s retry budget was actually spent first
    elapsedMs < 5000; // repairIndexLock's own diagnostic exec calls add a little more
  return { pass, detail };
}

async function main(): Promise<number> {
  const results: { name: string; pass: boolean; detail: string }[] = [];

  const { tmpBase, repoPath, lockPath } = await setupRepo();
  try {
    console.log("--- Phase 1: RAW natural race (2 concurrent commit-loop processes) ---");
    const p1 = await phase1RawNaturalRace(repoPath);
    console.log(`  ${p1.detail}`);
    results.push({ name: "phase1-raw-natural-race", pass: p1.pass, detail: p1.detail });

    console.log(
      "\n--- Phase 2: controlled residual-window reproduction (RAW, no Minsky wrapping) ---"
    );
    const p2 = await phase2ControlledRaceRaw(repoPath, lockPath, 250);
    console.log(`  ${p2.detail}`);
    results.push({
      name: "phase2-controlled-race-raw",
      pass: p2.raced, // the finding IS the pass condition here: race reachable?
      detail: p2.detail,
    });

    console.log("\n--- Phase 3: same controlled scenario, through the FIXED wrapped call ---");
    const p3 = await phase3ControlledRaceFixed(repoPath, lockPath, 250);
    console.log(`  ${p3.detail}`);
    results.push({ name: "phase3-controlled-race-fixed", pass: p3.pass, detail: p3.detail });

    console.log(
      "\n--- Phase 4: non-regression (repairLock: false) — persistent external contention " +
        "still surfaces the enriched busy error (~2s bound) ---"
    );
    const p4 = await phase4NonRegressionBusyErrorNoRepair(repoPath, lockPath);
    console.log(`  ${p4.detail}`);
    results.push({
      name: "phase4-non-regression-busy-error-no-repair",
      pass: p4.pass,
      detail: p4.detail,
    });

    console.log(
      "\n--- Phase 5: non-regression (repairLock: true) — persistent LIVE lock still surfaces " +
        "repairIndexLock's own busy error (~2s+ bound), not swallowed ---"
    );
    const p5 = await phase5NonRegressionBusyErrorWithRepairLock(repoPath, lockPath);
    console.log(`  ${p5.detail}`);
    results.push({
      name: "phase5-non-regression-busy-error-with-repair-lock",
      pass: p5.pass,
      detail: p5.detail,
    });
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }

  console.log("\n--- summary ---");
  let allPass = true;
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log(JSON.stringify({ results }, null, 2));

  if (!allPass) {
    console.error("\nFAIL: one or more harness phases did not behave as expected.");
    return 1;
  }
  console.log("\nPASS: all harness phases behaved as expected.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: repro-mt2886-lock-race threw an unexpected error:", err);
    process.exit(1);
  });
