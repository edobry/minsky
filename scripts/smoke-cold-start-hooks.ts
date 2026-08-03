#!/usr/bin/env bun
/**
 * Cold-start hook-provisioning smoke test (mt#3578)
 *
 * Verifies that a PACKAGED install layout — the `dist/` tree alone, with no
 * source checkout anywhere near it — can provision working observability
 * hooks into a fresh project via `minsky init`.
 *
 * This is the hooks analog of `scripts/smoke-cold-start-migrate.ts` (mt#2369,
 * the Phase 0 portability floor): bundler-emits-assets (`build:copy-hooks`) +
 * ordered-candidate resolver (`resolveHookSourceDir`, mt#3499) + this
 * cold-start test. Until mt#3578, the resolver's bundled-layout candidate
 * (`./hooks` beside the module) was UNVERIFIED — nothing emitted it, and
 * provisioning worked only because the dev checkout IS the install.
 *
 * Method:
 *   1. Copy `dist/` to a temp "install" directory — crucially SEPARATED from
 *      the repo, so the resolver's dev-layout candidate cannot accidentally
 *      resolve and only the bundled layout (`<install>/hooks`) can win.
 *   2. `git init` a fresh, empty project in another temp directory.
 *   3. Run `bun <install>/minsky.js init` against that project with
 *      MINSKY_STATE_DIR pointed at a temp state dir.
 *   4. Assert: the baseline hook files landed in `<state>/hooks/`, executable;
 *      `.claude/settings.local.json` registers them; and each installed hook
 *      EXECUTES (exit 0 on a synthetic event — the baseline hooks are
 *      fail-open and self-contained by contract, so a non-zero exit means the
 *      installed closure is broken, e.g. a missing support module).
 *
 * No env vars required (no DB): provisioning is pure file I/O, and the hooks'
 * fail-open contract means they exit 0 even with no cockpit daemon running.
 *
 * Usage: bun scripts/smoke-cold-start-hooks.ts   (requires `bun run build` first)
 * Exit codes: 0 — pass; 1 — fail.
 *
 * @see mt#3578 — install-channel decision + asset inventory
 * @see mt#3499 — the provisioning + resolver this verifies
 * @see .github/workflows/cold-start-hooks.yml — CI gate running this script
 */

import { spawnSync } from "child_process";
import { accessSync, constants, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BASELINE_INSTALL_FILES,
  OBSERVABILITY_BASELINE_HOOKS,
} from "../packages/domain/src/setup/hook-provisioning";

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");
const distDir = join(repoRoot, "dist");
const bundlePath = join(distDir, "minsky.js");

if (!existsSync(bundlePath)) {
  console.error(`ERROR: dist/minsky.js not found at ${bundlePath}`);
  console.error("Run 'bun run build' first to produce the bundle.");
  process.exit(1);
}
if (!existsSync(join(distDir, "hooks", OBSERVABILITY_BASELINE_HOOKS[0]))) {
  console.error("ERROR: dist/hooks/ is missing or incomplete.");
  console.error("Run 'bun run build' (which includes build:copy-hooks) first.");
  process.exit(1);
}

// ── temp layout ──────────────────────────────────────────────────────────────

const tempRoot = mkdtempSync(join(tmpdir(), "minsky-cold-start-hooks-"));
const installDir = join(tempRoot, "install");
const projectDir = join(tempRoot, "project");
const stateDir = join(tempRoot, "state");

let failures = 0;
const fail = (msg: string): void => {
  failures++;
  console.error(`FAIL: ${msg}`);
};
const pass = (msg: string): void => {
  console.log(`ok: ${msg}`);
};

try {
  // 1. The "installed" layout: dist/ contents, nowhere near a source checkout.
  cpSync(distDir, installDir, { recursive: true });

  // 2. A fresh project.
  mkdirSync(projectDir, { recursive: true });
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: projectDir, encoding: "utf8" });
  if (gitInit.status !== 0) {
    console.error(`ERROR: git init failed: ${gitInit.stderr}`);
    process.exit(1);
  }

  // 3. Run init from the installed bundle. MINSKY_STATE_DIR isolates the
  //    machine-level install target; the project dir is passed explicitly.
  const initResult = spawnSync(
    "bun",
    // NOTE: no `--mcp false` — hook provisioning is part of Phase 2
    // (developer-local setup), which `initializeProject` skips entirely when
    // MCP is explicitly disabled. Provisioning-under-MCP-disabled is a product
    // coupling decision (ask#6671), not a smoke concern.
    [join(installDir, "minsky.js"), "init", "--repo", projectDir, "--backend", "minsky"],
    {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, MINSKY_STATE_DIR: stateDir },
    }
  );
  if (initResult.status !== 0) {
    console.error("ERROR: 'minsky init' failed from the installed layout.");
    console.error(`stdout:\n${initResult.stdout}`);
    console.error(`stderr:\n${initResult.stderr}`);
    process.exit(1);
  }
  pass("minsky init succeeded from the installed (no-source) layout");

  // 4a. Installed files present + executable.
  const installedHooksDir = join(stateDir, "hooks");
  for (const fileName of BASELINE_INSTALL_FILES) {
    const installed = join(installedHooksDir, fileName);
    if (!existsSync(installed)) {
      fail(`expected installed hook missing: ${installed}`);
      continue;
    }
    try {
      accessSync(installed, constants.X_OK);
      pass(`installed and executable: ${fileName}`);
    } catch {
      fail(`installed but not executable: ${installed}`);
    }
  }

  // 4b. Registered in the project's settings file.
  const settingsPath = join(projectDir, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) {
    fail(`expected settings file missing: ${settingsPath}`);
  } else {
    const settings = readFileSync(settingsPath, "utf8");
    for (const hookName of OBSERVABILITY_BASELINE_HOOKS) {
      if (settings.includes(hookName)) {
        pass(`registered in settings.local.json: ${hookName}`);
      } else {
        fail(`not registered in settings.local.json: ${hookName}`);
      }
    }
  }

  // 4c. The installed hooks EXECUTE from their installed location. The
  //     baseline hooks are fail-open (every path exits 0, including "no
  //     daemon running"), so a non-zero exit here means the installed set is
  //     not self-contained (e.g. a support module didn't ship).
  const syntheticEvents: Record<string, object> = {
    "record-conversation-run-state.ts": {
      hook_event_name: "PreToolUse",
      session_id: "cold-start-smoke",
      tool_name: "Bash",
      cwd: projectDir,
    },
    "transcript-ingest-on-session-end.ts": {
      hook_event_name: "SessionEnd",
      session_id: "cold-start-smoke",
      cwd: projectDir,
    },
  };
  for (const hookName of OBSERVABILITY_BASELINE_HOOKS) {
    const run = spawnSync("bun", [join(installedHooksDir, hookName)], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 30_000,
      input: JSON.stringify(syntheticEvents[hookName] ?? { hook_event_name: "Unknown" }),
      env: { ...process.env, MINSKY_STATE_DIR: stateDir },
    });
    if (run.status === 0) {
      pass(`executes from installed location: ${hookName}`);
    } else {
      fail(
        `installed hook exited ${run.status}: ${hookName}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
      );
    }
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncold-start hooks smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncold-start hooks smoke: PASS");
