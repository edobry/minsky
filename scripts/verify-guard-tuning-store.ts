#!/usr/bin/env bun
/**
 * Real-binding check for the guard-tuning store (mt#3581, ADR-032 §D1).
 *
 * The unit tests inject an in-memory fs, which proves the LOGIC. They say
 * nothing about whether a value written to the real store is the value a real
 * guard actually reads — the binding direction of the convergence checklist's
 * production-wiring item, and the failure class mt#2076 shipped three features
 * on top of.
 *
 * So this script exercises the real path end to end:
 *
 *   1. Point `MINSKY_STATE_DIR` at a scratch dir (no production state touched).
 *   2. Write a tuned value through the real `writeTunedValue`, real fs.
 *   3. Import the REAL guard module in a fresh process and read the threshold
 *      constant it computed at import time.
 *   4. Assert it equals the tuned value, not the shipped default.
 *
 * Step 3 is why this is a script and not a test: the guard's threshold is a
 * module-level constant evaluated once at import, so the store has to be
 * populated BEFORE the module loads. A test in the same process as other tests
 * cannot guarantee that ordering.
 *
 * Exit 0 = pass, non-zero = fail.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const scratch = mkdtempSync(join(tmpdir(), "minsky-guard-tuning-verify-"));

interface Case {
  name: string;
  thresholdKey: string;
  shippedDefault: number;
  tunedValue: number;
  /** Named export on the guard module carrying the resolved threshold. */
  constantName: string;
  modulePath: string;
  /** When set, the env var is ALSO exported — exercising the precedence chain. */
  envOverride?: string;
  /** Expected resolved value; defaults to `tunedValue`. */
  expected?: number;
}

const CASES: Case[] = [
  {
    name: "wall-of-text word budget",
    thresholdKey: "MINSKY_WALL_OF_TEXT_WORD_BUDGET",
    shippedDefault: 200,
    tunedValue: 330,
    constantName: "LEAD_WORD_BUDGET",
    modulePath: "../.minsky/hooks/wall-of-text-detector.ts",
  },
  {
    name: "silent-stretch gap minutes",
    thresholdKey: "MINSKY_SILENT_STRETCH_GAP_MINUTES",
    shippedDefault: 10,
    tunedValue: 18,
    constantName: "GAP_MINUTES_THRESHOLD",
    modulePath: "../.minsky/hooks/silent-stretch-detector.ts",
  },
  {
    // The second threshold on the SAME module. Wiring one constant and not the
    // other is a live failure mode — they are separate call sites (PR #2577 R1).
    name: "silent-stretch tool calls",
    thresholdKey: "MINSKY_SILENT_STRETCH_TOOL_CALLS",
    shippedDefault: 15,
    tunedValue: 22,
    constantName: "TOOL_CALL_THRESHOLD",
    modulePath: "../.minsky/hooks/silent-stretch-detector.ts",
  },
  {
    // Precedence, exercised against the real modules rather than only in unit
    // tests: with the env var ALSO set, the env value must win over the tune.
    // Without this the script would pass just as happily if the store silently
    // outranked an operator's explicit setting.
    name: "env var outranks the tuned value",
    thresholdKey: "MINSKY_WALL_OF_TEXT_WORD_BUDGET",
    shippedDefault: 200,
    tunedValue: 330,
    envOverride: "450",
    expected: 450,
    constantName: "LEAD_WORD_BUDGET",
    modulePath: "../.minsky/hooks/wall-of-text-detector.ts",
  },
];

/**
 * Run one case in a FRESH bun process — the guard's constant is evaluated at
 * import, so each case needs its own module load with its own store state.
 */
async function runCase(testCase: Case): Promise<{ ok: boolean; detail: string }> {
  const { writeTunedValue } = await import("../.minsky/hooks/guard-tuning-store");

  process.env["MINSKY_STATE_DIR"] = scratch;
  writeTunedValue(testCase.thresholdKey, testCase.tunedValue, {
    appliedAt: new Date().toISOString(),
  });

  const child = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `process.env.MINSKY_STATE_DIR=${JSON.stringify(scratch)};` +
        `const m = await import(${JSON.stringify(join(import.meta.dir, testCase.modulePath))});` +
        `console.log(String(m[${JSON.stringify(testCase.constantName)}]));`,
    ],
    env: {
      ...process.env,
      MINSKY_STATE_DIR: scratch,
      ...(testCase.envOverride === undefined
        ? {}
        : { [testCase.thresholdKey]: testCase.envOverride }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new TextDecoder().decode(child.stdout).trim();
  const stderr = new TextDecoder().decode(child.stderr).trim();
  if (child.exitCode !== 0) {
    return { ok: false, detail: `child exited ${child.exitCode}: ${stderr || "(no stderr)"}` };
  }

  const expected = testCase.expected ?? testCase.tunedValue;
  const observed = Number(stdout.split("\n").pop());
  if (observed === expected) {
    const what =
      testCase.envOverride === undefined
        ? "tuned value in force"
        : "env var outranked the tuned value";
    return { ok: true, detail: `${testCase.shippedDefault} -> ${observed} (${what})` };
  }
  if (observed === testCase.shippedDefault) {
    return {
      ok: false,
      detail: `still the shipped default (${observed}) — the store is NOT bound to the guard`,
    };
  }
  if (testCase.envOverride !== undefined && observed === testCase.tunedValue) {
    return {
      ok: false,
      detail: `resolved the TUNED value (${observed}) with an env var set — precedence is inverted`,
    };
  }
  return {
    ok: false,
    detail: `unexpected value ${observed}, expected ${expected} (stdout: ${JSON.stringify(stdout)})`,
  };
}

async function main(): Promise<void> {
  const results: { name: string; ok: boolean; detail: string }[] = [];

  try {
    for (const testCase of CASES) {
      const result = await runCase(testCase);
      results.push({ name: testCase.name, ...result });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify({
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
    })
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
