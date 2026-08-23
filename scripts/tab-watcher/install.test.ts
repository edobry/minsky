/**
 * Tests for the tab-watcher install/drift helper (mt#3873).
 *
 * The whole point of this task is that two copies of one tool diverged silently for three
 * months, so the load-bearing behavior is `drift` — it must FAIL on a hand-edited install and
 * on a missing file, not merely on the happy path. Each test installs into a scratch directory
 * (`TAB_WATCHER_INSTALL_DIR`) and skips launchctl (`TAB_WATCHER_SKIP_LAUNCHCTL`), so nothing
 * here touches the operator's real daemon.
 *
 * Deliberately NOT guarded to Darwin, though the tooling it installs is macOS-only. `install.sh`
 * reaches for exactly one Darwin-specific command — `launchctl` — and this suite gates it off via
 * `TAB_WATCHER_SKIP_LAUNCHCTL`; everything the tests actually exercise (`cp`, `chmod`, `sed`,
 * `diff`, `mkdir`, `id -u`) is portable, so they run and pass on CI's Linux runners as-is.
 * A platform skip here would trade real cross-platform coverage of the install/drift logic for
 * protection against a failure that does not occur (raised NON-BLOCKING in PR #2980 R1).
 */

/* eslint-disable custom/no-real-fs-in-tests --
 * These tests spawn `bash install.sh` as a SUBPROCESS, so an injected or in-memory fs is
 * structurally invisible to the code under test: the script's own `cp`, `diff`, and `rm` run
 * against the real filesystem no matter what this file imports. Observing the real filesystem
 * is therefore the only way to assert anything about it, and mocking would leave the test
 * asserting against a surface the script never touches — the shape mem#704 names as a probe
 * that cannot fail. Blast radius is bounded by construction: every path comes from
 * `mkdtempSync`, is passed in via the script's own TAB_WATCHER_* env overrides, launchctl is
 * skipped, and `afterEach` removes all three scratch dirs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const INSTALL_SH = join(import.meta.dir, "install.sh");
const SCRIPTS = ["tab-watcher.sh", "resume-from-snapshot.sh", "resume-tabs-in-place.sh"];

let installDir: string;
let agentsDir: string;
let stateDir: string;

function run(command: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", INSTALL_SH, command], {
    env: {
      ...process.env,
      TAB_WATCHER_INSTALL_DIR: installDir,
      TAB_WATCHER_LAUNCH_AGENTS_DIR: agentsDir,
      TAB_WATCHER_STATE_DIR: stateDir,
      TAB_WATCHER_SKIP_LAUNCHCTL: "1",
    },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

beforeEach(() => {
  installDir = mkdtempSync(join(tmpdir(), "tw-install-"));
  agentsDir = mkdtempSync(join(tmpdir(), "tw-agents-"));
  stateDir = mkdtempSync(join(tmpdir(), "tw-state-"));
});

afterEach(() => {
  for (const dir of [installDir, agentsDir, stateDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("install", () => {
  test("installs every script the tooling owns, including resume-tabs-in-place", () => {
    const result = run("install");
    expect(result.exitCode).toBe(0);
    for (const script of SCRIPTS) {
      expect(existsSync(join(installDir, script))).toBe(true);
    }
  });

  test("installed scripts are byte-identical to the repo copies (AT1)", () => {
    run("install");
    for (const script of SCRIPTS) {
      const canonical = readFileSync(join(import.meta.dir, script), "utf8");
      const installed = readFileSync(join(installDir, script), "utf8");
      expect(installed).toBe(canonical);
    }
  });

  test("is idempotent — a second install leaves the same content", () => {
    run("install");
    const first = readFileSync(join(installDir, "tab-watcher.sh"), "utf8");
    expect(run("install").exitCode).toBe(0);
    expect(readFileSync(join(installDir, "tab-watcher.sh"), "utf8")).toBe(first);
  });
});

describe("drift", () => {
  test("passes immediately after an install", () => {
    run("install");
    const result = run("drift");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no drift");
  });

  test("fails when the installed copy is hand-edited (AT4)", () => {
    run("install");
    const target = join(installDir, "tab-watcher.sh");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n# hand edit\n`);

    const result = run("drift");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tab-watcher.sh differs");
    // The remedy has to be in the message — a drift report you cannot act on is
    // the silent-divergence failure with extra steps.
    expect(result.stderr).toContain("install");
  });

  test("fails when an installed script is missing entirely", () => {
    run("install");
    rmSync(join(installDir, "resume-tabs-in-place.sh"));

    const result = run("drift");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("resume-tabs-in-place.sh is not installed");
  });

  test("reports every drifted script in one run, not just the first", () => {
    run("install");
    for (const script of ["tab-watcher.sh", "resume-from-snapshot.sh"]) {
      const target = join(installDir, script);
      writeFileSync(target, `${readFileSync(target, "utf8")}\n# hand edit\n`);
    }

    const result = run("drift");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tab-watcher.sh differs");
    expect(result.stderr).toContain("resume-from-snapshot.sh differs");
  });

  test("fails before any install has happened", () => {
    const result = run("drift");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not installed");
  });
});

describe("uninstall", () => {
  test("removes every installed script", () => {
    run("install");
    expect(run("uninstall").exitCode).toBe(0);
    for (const script of SCRIPTS) {
      expect(existsSync(join(installDir, script))).toBe(false);
    }
  });
});
