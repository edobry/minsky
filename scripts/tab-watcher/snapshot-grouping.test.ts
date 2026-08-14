/**
 * Tests for the unresponsive-iTerm window-grouping path (mt#4080).
 *
 * The defect these guard: an empty `dump_iterm_tabs` gave every session
 * `iterm_window_id: ""` — byte-identical to a genuine single-window state — so a wedged iTerm
 * produced a snapshot that looked complete and silently flattened a multi-window layout. The
 * fix records the observation's STATUS separately from its content, and recovers the grouping
 * from history by tty. So the load-bearing assertions here are the ones that distinguish
 * "unavailable" from "ok" and "recovered" from "observed" — not that a snapshot parses.
 *
 * Two groups, deliberately guarded differently:
 *
 * - **Consumer warning** — unguarded. It runs `resume-from-snapshot.sh` against snapshots this
 *   file writes, touching no process table and no iTerm; portable, and it runs on CI's Linux
 *   runners as-is.
 * - **Producer** — Darwin-only, and honestly so. It spawns the daemon body, which enumerates
 *   the live process table via `lsof`/`ps` and needs a running Claude session to have any
 *   session rows at all. That is a real platform+environment dependency, NOT the defensive
 *   guard declined in `install.test.ts` (mt#3873) — there, everything the tests exercised was
 *   portable and a skip would have traded real coverage for nothing.
 */

/* eslint-disable custom/no-real-fs-in-tests --
 * Same rationale as install.test.ts: these spawn shell scripts as SUBPROCESSES, so an injected
 * fs is invisible to the code under test — the scripts read and write the real filesystem
 * whatever this file imports. Every path is an `mkdtempSync` scratch dir passed in via the
 * scripts' own TAB_WATCHER_STATE_DIR seam, and torn down in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const WATCHER_SH = join(import.meta.dir, "tab-watcher.sh");
const RESUME_SH = join(import.meta.dir, "resume-from-snapshot.sh");

const isDarwin = process.platform === "darwin";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tw-grouping-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function runWatcher(env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", WATCHER_SH], {
    env: { ...process.env, TAB_WATCHER_STATE_DIR: stateDir, ...env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function readSnapshot(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(stateDir, "snapshot.json"), "utf8"));
}

function runResume(snapshotPath: string) {
  const proc = Bun.spawnSync(["bash", RESUME_SH, "--snapshot", snapshotPath, "--dry-run"], {
    env: { ...process.env, TAB_WATCHER_STATE_DIR: stateDir },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** A snapshot with one session, shaped like the producer's output. */
function writeSnapshot(name: string, extra: Record<string, unknown>): string {
  const path = join(stateDir, name);
  writeFileSync(
    path,
    JSON.stringify({
      timestamp: "2026-08-13T12:00:00Z",
      ...extra,
      sessions: [
        {
          pid: 1,
          session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          cwd: "/tmp",
          jsonl: "/nonexistent.jsonl",
          tty: "ttys999",
          iterm_window_id: "",
          iterm_tab_title: "",
          uptime_sec: 1,
        },
      ],
    })
  );
  return path;
}

describe("consumer warning (SC2)", () => {
  test("stays silent when the dump was observed", () => {
    const snap = writeSnapshot("ok.json", { iterm_dump: "ok", iterm_grouping_source: "live" });
    expect(runResume(snap).stderr).not.toContain("WARN: iTerm was unresponsive");
  });

  test("stays silent on a legacy snapshot carrying neither field", () => {
    const path = join(stateDir, "legacy.json");
    writeFileSync(path, JSON.stringify({ timestamp: "2026-08-01T00:00:00Z", sessions: [] }));
    expect(runResume(path).stderr).not.toContain("WARN: iTerm was unresponsive");
  });

  test("warns that grouping is unrecoverable when nothing was available", () => {
    const snap = writeSnapshot("none.json", {
      iterm_dump: "unavailable",
      iterm_grouping_source: "none",
    });
    const { stderr } = runResume(snap);
    expect(stderr).toContain("iTerm was unresponsive");
    expect(stderr).toContain("will NOT be reconstructed");
    // The hint is the operator's next command during a recovery, so it must be pasteable as
    // printed — a literal "$TAB_WATCHER_STATE_DIR" is not (PR #2993 R3).
    expect(stderr).toContain(`ls -t ${stateDir}/snapshot-*.json`);
    expect(stderr).not.toContain("$TAB_WATCHER_STATE_DIR");
  });

  test("warns that grouping was recovered, and names when it came from", () => {
    const snap = writeSnapshot("hist.json", {
      iterm_dump: "unavailable",
      iterm_grouping_source: "history",
      iterm_grouping_from: "2026-08-13T04:11:38Z",
    });
    const { stderr } = runResume(snap);
    expect(stderr).toContain("RECOVERED from an earlier snapshot");
    // The timestamp is the whole point — a recovered layout the operator cannot date is
    // indistinguishable from a fresh one for the decision they actually have to make.
    expect(stderr).toContain("2026-08-13T04:11:38Z");
  });
});

describe("memory reading when vm_stat is unavailable", () => {
  /**
   * Same defect class as the one this task fixes in the producer, found in the consumer while
   * responding to PR #2993 R1: an unavailable reading rendered as a definite value. `avail_gb`
   * printed "0.0" when vm_stat was missing, and 0.0 is below every floor — so `wait_for_memory`
   * would stall the full MAX_WAIT per tab against a reading that never arrives.
   *
   * Portable on purpose: no iTerm, no process table. On Linux vm_stat is genuinely absent, so
   * this exercises the real path there; the shim makes it deterministic on macOS too.
   */
  /**
   * `shimBody` is the whole point of the parameter. There are three distinct ways the reading
   * can be unavailable and they exercise DIFFERENT code: absent (never runs awk), failing
   * (never runs awk), and succeeding-but-unparseable (runs awk, which exits 1). R1 covered only
   * the first two, so the third stayed invisible until the reviewer found it on R2 — awk's
   * non-zero status propagated through `pipefail` into a bare assignment and `set -e` killed
   * the run. All three must end in the same honest "unknown".
   */
  function runResumeWithVmStatShim(snapshotPath: string, shimBody: string) {
    const shimDir = mkdtempSync(join(tmpdir(), "tw-shim-"));
    writeFileSync(join(shimDir, "vm_stat"), shimBody, { mode: 0o755 });
    try {
      const proc = Bun.spawnSync(["bash", RESUME_SH, "--snapshot", snapshotPath, "--dry-run"], {
        env: {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          TAB_WATCHER_STATE_DIR: stateDir,
        },
      });
      return {
        exitCode: proc.exitCode ?? -1,
        stdout: new TextDecoder().decode(proc.stdout),
      };
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  }

  const FAILING = "#!/bin/sh\nexit 127\n";
  const UNPARSEABLE = "#!/bin/sh\necho 'garbage output with no page size line'\nexit 0\n";

  test("reports the reading as unknown rather than inventing 0.0", () => {
    const snap = writeSnapshot("mem.json", { iterm_dump: "ok", iterm_grouping_source: "live" });
    const { stdout } = runResumeWithVmStatShim(snap, FAILING);
    expect(stdout).toContain("available memory unknown");
    // The pre-fix output. 0.0 is not merely wrong, it is below every floor.
    expect(stdout).not.toContain("0.0GB");
  });

  test("dry-run still exits 0 with no usable vm_stat", () => {
    const snap = writeSnapshot("mem-exit.json", {
      iterm_dump: "ok",
      iterm_grouping_source: "live",
    });
    expect(runResumeWithVmStatShim(snap, FAILING).exitCode).toBe(0);
  });

  test("survives a vm_stat that succeeds but emits unparseable output", () => {
    // The R2 regression: awk exits 1 here, and before the fix `set -euo pipefail` propagated
    // that through the bare `mem_now=$(avail_gb)` assignment and killed the run at exit 1,
    // never printing the summary line at all.
    const snap = writeSnapshot("mem-garbage.json", {
      iterm_dump: "ok",
      iterm_grouping_source: "live",
    });
    const { stdout, exitCode } = runResumeWithVmStatShim(snap, UNPARSEABLE);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("available memory unknown");
  });

  test("reports a real reading when vm_stat works", () => {
    const snap = writeSnapshot("mem-ok.json", { iterm_dump: "ok", iterm_grouping_source: "live" });
    const { stdout, exitCode } = runResume(snap);
    expect(exitCode).toBe(0);
    // On a machine with a working vm_stat this is a real number; without one (Linux CI) the
    // honest "unknown" is equally correct. What must never appear is a fabricated 0.0.
    expect(stdout).toMatch(/available memory (now \d+\.\dGB|unknown)/);
  });
});

describe.skipIf(!isDarwin)("producer (SC1, SC3, SC4, SC5)", () => {
  test("marks the dump unavailable and claims no grouping when history is empty", () => {
    const result = runWatcher({ TAB_WATCHER_FORCE_EMPTY_DUMP: "1" });
    expect(result.exitCode).toBe(0);

    const snap = readSnapshot();
    expect(snap.iterm_dump).toBe("unavailable");
    expect(snap.iterm_grouping_source).toBe("none");
    // Nothing was recovered, so there is no source to date.
    expect(snap).not.toHaveProperty("iterm_grouping_from");
  });

  test("recovers the prior grouping by tty and attributes it to history", () => {
    // Seed from a REAL run so the ttys are ones the next run will actually observe — the join
    // key has to match live processes for recovery to be visible at all.
    expect(runWatcher({ TAB_WATCHER_FORCE_EMPTY_DUMP: "1" }).exitCode).toBe(0);
    const baseline = readSnapshot() as { sessions: Array<Record<string, unknown>> };
    expect(baseline.sessions.length).toBeGreaterThan(0);

    writeFileSync(
      join(stateDir, "snapshot.json"),
      JSON.stringify({
        timestamp: "2026-08-13T04:11:38Z",
        iterm_dump: "ok",
        iterm_grouping_source: "live",
        sessions: baseline.sessions.map((s) => ({ ...s, iterm_window_id: "W1" })),
      })
    );

    expect(runWatcher({ TAB_WATCHER_FORCE_EMPTY_DUMP: "1" }).exitCode).toBe(0);
    const snap = readSnapshot() as {
      iterm_dump: string;
      iterm_grouping_source: string;
      iterm_grouping_from: string;
      sessions: Array<Record<string, unknown>>;
    };

    expect(snap.iterm_grouping_source).toBe("history");
    expect(snap.iterm_grouping_from).toBe("2026-08-13T04:11:38Z");
    // SC5: a recovered grouping still reports the dump as unavailable, so it can never be
    // mistaken for an observed one.
    expect(snap.iterm_dump).toBe("unavailable");
    expect(snap.sessions.filter((s) => s.iterm_window_id === "W1").length).toBeGreaterThan(0);
  });

  test("does not chain recovery off an already-recovered snapshot", () => {
    expect(runWatcher({ TAB_WATCHER_FORCE_EMPTY_DUMP: "1" }).exitCode).toBe(0);
    const baseline = readSnapshot() as { sessions: Array<Record<string, unknown>> };

    // A prior snapshot that was ITSELF recovered. Accepting it would keep re-dating a stale
    // layout forever, so `iterm_grouping_from` would stop meaning "when this was last seen".
    writeFileSync(
      join(stateDir, "snapshot.json"),
      JSON.stringify({
        timestamp: "2026-08-13T05:00:00Z",
        iterm_dump: "unavailable",
        iterm_grouping_source: "history",
        iterm_grouping_from: "2026-08-13T04:11:38Z",
        sessions: baseline.sessions.map((s) => ({ ...s, iterm_window_id: "W9" })),
      })
    );

    expect(runWatcher({ TAB_WATCHER_FORCE_EMPTY_DUMP: "1" }).exitCode).toBe(0);
    const snap = readSnapshot() as {
      iterm_grouping_source: string;
      sessions: Array<Record<string, unknown>>;
    };
    expect(snap.iterm_grouping_source).toBe("none");
    expect(snap.sessions.filter((s) => s.iterm_window_id === "W9").length).toBe(0);
  });

  test("treats a legacy snapshot with populated window ids as observed", () => {
    expect(runWatcher({ TAB_WATCHER_FORCE_EMPTY_DUMP: "1" }).exitCode).toBe(0);
    const baseline = readSnapshot() as { sessions: Array<Record<string, unknown>> };

    // Predates all three fields — every snapshot already on disk looks like this.
    writeFileSync(
      join(stateDir, "snapshot.json"),
      JSON.stringify({
        timestamp: "2026-08-09T01:48:14Z",
        sessions: baseline.sessions.map((s) => ({ ...s, iterm_window_id: "OLD" })),
      })
    );

    expect(runWatcher({ TAB_WATCHER_FORCE_EMPTY_DUMP: "1" }).exitCode).toBe(0);
    const snap = readSnapshot() as {
      iterm_grouping_source: string;
      sessions: Array<Record<string, unknown>>;
    };
    expect(snap.iterm_grouping_source).toBe("history");
    expect(snap.sessions.filter((s) => s.iterm_window_id === "OLD").length).toBeGreaterThan(0);
  });
});
