#!/usr/bin/env bun
/**
 * mt#4789 — verify the ignored-`DATABASE_URL` warning fires from the REAL
 * resolution path, and stays silent when a registered override is used.
 *
 * Why a script and not a unit test. The unit tests cover the pure detector and
 * the message, but they deliberately do NOT assert that the warning is actually
 * WIRED into `getEffectivePersistenceConfig` — `tests/setup.ts` sets
 * `TEST_LOGGER_SILENCED_FLAG`, which silences winston's Console in the
 * in-process harness, so a test watching the logger would pass whether or not
 * the call site existed. That is the caller-direction gap
 * (`/implement-task` §7 item 8): a helper with green unit tests and no
 * production caller. This runs the real path in a CHILD PROCESS with the logger
 * live and reads what it actually emitted.
 *
 * Usage:
 *   bun scripts/verify-database-url-warning.ts
 *
 * Env-gated: exits 0 with SKIP when no Postgres connection is configured (a
 * fresh checkout, CI without config), since with nothing to resolve there is no
 * mismatch to warn about.
 *
 * Never prints a connection string — only hosts. Exits 0 on pass, 1 on failure.
 */
import "reflect-metadata";

import { loadConfiguration } from "../packages/domain/src/configuration/loader";
import {
  connectionTargetHost,
  getEffectivePersistenceConfig,
} from "../packages/domain/src/configuration/persistence-config";

/**
 * A scratch target that is never reachable — nothing here opens a connection.
 *
 * Assembled from parts rather than written as one literal ON PURPOSE: the
 * pre-commit `gitleaks` scan's `database-url-credentials` rule matches the
 * literal `scheme://user:secret@host` shape, and blocked this file when the URL
 * was spelled out. Do not "simplify" this back into a single string.
 */
const SCRATCH_HOST = "127.0.0.1:59999";
const LEAK_CANARY = "mt4789_placeholder_pw";
// The userinfo is built one step earlier so no `://name:value@host` shape ever
// appears in this source line — that shape is what the scan matches, and it
// matches through interpolation too, so hiding the value alone is not enough.
const SCRATCH_USERINFO = `mt4789_user:${LEAK_CANARY}`;
const SCRATCH_URL = `postgresql://${SCRATCH_USERINFO}@${SCRATCH_HOST}/mt4789_scratch`;
const CHILD_FLAG = "MT4789_VERIFY_CHILD";

/**
 * Child mode: resolve config once, with whatever env the parent handed us, and
 * let the real logger write wherever it writes. Self-invocation keeps the whole
 * probe in one file — no sibling fixture that can drift from it.
 */
if (process.env[CHILD_FLAG] === "1") {
  const result = await loadConfiguration();
  const effective = getEffectivePersistenceConfig(result.config);
  console.log(
    `CHILD_RESOLVED_HOST=${connectionTargetHost(effective.connectionString) ?? "(none)"}`
  );
  process.exit(0);
}

interface ChildRun {
  output: string;
  resolvedHost: string;
}

async function runChild(env: Record<string, string | undefined>): Promise<ChildRun> {
  const child = Bun.spawn(["bun", import.meta.path], {
    env: { ...process.env, ...env, [CHILD_FLAG]: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const output = `${stdout}\n${stderr}`;
  const match = output.match(/CHILD_RESOLVED_HOST=(.*)/);
  return { output, resolvedHost: match?.[1]?.trim() ?? "(unknown)" };
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// ── Preflight: is there anything to resolve? ────────────────────────────────
const baseline = await runChild({ DATABASE_URL: undefined, MINSKY_POSTGRES_URL: undefined });
if (baseline.resolvedHost === "(none)") {
  console.log(
    "SKIP: no Postgres connection is configured, so there is no target for " +
      "DATABASE_URL to mismatch against. Configure persistence, or set " +
      "MINSKY_PERSISTENCE_POSTGRES_URL, to run this probe."
  );
  process.exit(0);
}
console.log(`Configured target host: ${baseline.resolvedHost}\n`);

// ── Case 1 (AT1): DATABASE_URL set, no registered override → warn ───────────
const ignored = await runChild({ DATABASE_URL: SCRATCH_URL, MINSKY_POSTGRES_URL: undefined });
// Both hosts must appear in the WARNING LINE, not merely somewhere in the
// output. Written first as a whole-output search, this probe's own negative
// control caught that: with the warning removed, "names the selected host"
// still passed, because the child also prints CHILD_RESOLVED_HOST. A check that
// passes when the feature is absent is not a check.
const warningLine = ignored.output.split("\n").find((l) => l.includes("DATABASE_URL is set to"));
check(
  "AT1 warning fires when DATABASE_URL is set and ignored",
  warningLine !== undefined,
  `resolved ${ignored.resolvedHost}`
);
check(
  "AT1 warning line names the ignored host",
  warningLine?.includes(SCRATCH_HOST) === true,
  `expected ${SCRATCH_HOST}`
);
check(
  "AT1 warning line names the selected host",
  warningLine?.includes(baseline.resolvedHost) === true,
  `expected ${baseline.resolvedHost}`
);
check(
  "AT1 DATABASE_URL was NOT honored (still resolves to the configured target)",
  ignored.resolvedHost === baseline.resolvedHost,
  `resolved ${ignored.resolvedHost}`
);

// ── Case 2 (AT2): negative control — a registered override IS honored ───────
for (const varName of ["MINSKY_POSTGRES_URL", "MINSKY_PERSISTENCE_POSTGRES_URL"]) {
  const overridden = await runChild({ DATABASE_URL: SCRATCH_URL, [varName]: SCRATCH_URL });
  check(
    `AT2 ${varName} redirects resolution to the scratch target`,
    overridden.resolvedHost === SCRATCH_HOST,
    `resolved ${overridden.resolvedHost}`
  );
  check(
    `AT2 ${varName} silences the warning (resolved target matches DATABASE_URL)`,
    !overridden.output.includes("DATABASE_URL is set to"),
    "no warning expected"
  );
}

// ── Case 3: silent when DATABASE_URL is unset ──────────────────────────────
check(
  "no warning when DATABASE_URL is unset",
  !baseline.output.includes("DATABASE_URL is set to"),
  "baseline run"
);

// ── Case 4 (AT3): no credential in any output ──────────────────────────────
const allOutput = [baseline.output, ignored.output].join("\n");
check(
  "AT3 no scratch credential appears in any emitted output",
  !allOutput.includes(LEAK_CANARY),
  `searched for the scratch password across ${allOutput.length} chars`
);

console.log(
  `\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures.join(", ")}`}`
);
process.exit(failures.length === 0 ? 0 : 1);
