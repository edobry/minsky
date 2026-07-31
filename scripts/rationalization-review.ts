#!/usr/bin/env bun
/**
 * Rationalization review CLI — mt#2901 (evaluation-loop RFC Part 3, first cycle,
 * Notion 392937f0-3cb4-8188-aad6-d7d041de814b).
 *
 * Reads the real fire-log (`~/.local/state/minsky/fire-log.jsonl`) plus the six
 * legacy `.minsky/*-calibration.jsonl` logs (via the mt#2889 schema adapter),
 * runs the full guard-canary suite, pulls each guard's static attention-cost
 * annotation from `GUARD_REGISTRY`, and (best-effort) resolves per-guard
 * recurrence-since-done counts from the task-metadata family convention
 * (docs/architecture/evaluation-loop-phase2.md). Hands all of that to the pure
 * `buildPanel` / `computeCadenceRecommendation` functions
 * (`src/domain/calibration/rationalization-review.ts`) and prints the
 * judgment-free per-guard panel the RFC specifies.
 *
 * This script does NOT call `asks_create` — an MCP tool, not reachable from a
 * standalone `bun` process. The operator/agent runs this script, reads the
 * panel, and files the ONE auto-affirm-plus-outliers ask by hand (or via the
 * MCP `asks_create` tool from agent context) per the RFC's "must end in
 * explicit decisions" requirement.
 *
 * Integration choice (per this task's spec — "pick the cheaper integration
 * and note it"): a standalone script, mirroring `scripts/run-guard-canaries.ts`
 * (mt#2889) rather than a new shared-command-registry MCP/CLI command. This
 * review needs three read-only real-world data sources (the fire-log, the
 * canary suite, `GUARD_REGISTRY`) that `run-guard-canaries.ts` already proves
 * out the wiring for, and it runs on a periodic/manual cadence (quarterly per
 * the RFC), not as an interactive user-facing command family member — the
 * same shape that led the canary runner to be a script, not a command.
 * Registering a new `observability.*`/`calibration.*` shared command would add
 * Zod-schema + registry boilerplate for a mechanism that isn't meant to be
 * invoked ad hoc from the CLI/MCP surface.
 *
 * Usage:
 *   bun scripts/rationalization-review.ts                  # human-readable report (read-only)
 *   bun scripts/rationalization-review.ts --json            # structured JSON report (read-only)
 *   bun scripts/rationalization-review.ts --execute          # ALSO appends this review's own
 *                                                             # fire-log execution record (see
 *                                                             # "Self-review fire-logging" below)
 *
 * Exit code: 0 always (this is a read-mostly reporting tool, not a guard —
 * there is no pass/fail condition at the process level; the panel's
 * auto-affirm/outlier split IS the result).
 *
 * Self-review fire-logging (RFC Threats: "its own execution is fire-logged";
 * RFC Part 3: "a review that produces only a report is recorded as a failed
 * review in its own fire-log"). This script cannot itself know whether the
 * operator/agent went on to create the ONE required ask (that step happens
 * OUTSIDE this process, via the `asks_create` MCP tool) — so `--execute` is
 * meant to be invoked ONCE, AFTER the ask has been filed, to record a
 * successful review (`decision: "allow"`). If a review pass produced only a
 * report with no ask filed, invoke `--execute --report-only` instead to
 * record the RFC's explicit failed-review signal (`decision: "deny"`).
 * `guardName: "rationalization-review"`, `event: "Review"` is the closest fit
 * in the existing tri-state `FireLogEntry` schema — no schema extension was
 * needed; the created ask's id is NOT stored here (the schema has no
 * free-form field for it) — it lives in the ask itself and in the PR body's
 * execution evidence, independently queryable via `asks_list`.
 *
 * Isolation (mt#2876 class — canary run never writes fixture records to real
 * state; review R1 hardening). The canary suite runs as a genuinely SEPARATE
 * `Bun.spawn` subprocess invoking `scripts/run-guard-canaries.ts` directly,
 * NOT via in-process dynamic `import()` with a mutated `process.env`. The
 * earlier in-process approach (mutate `MINSKY_STATE_DIR`/`CLAUDE_PROJECT_DIR`
 * for THIS process, dynamically import the canary modules, restore in a
 * `finally`) was carefully ordered to be correct — every real-state read in
 * this script happens strictly before the mutation window and every real-
 * state write strictly after restoration — but "carefully ordered" is a
 * property of THIS script's current code, not a structural guarantee: any
 * transitively-imported module that caches an env-derived value at IMPORT
 * time (module load), rather than reading `process.env` fresh per call,
 * would poison that cached value for the rest of THIS process's lifetime —
 * a class of bug that only shows up when someone adds such a module later,
 * far from this file. Running the canary suite in its own OS process
 * eliminates the class outright: `run-guard-canaries.ts` sets its OWN
 * environment for its OWN process only (that process exits and is reaped
 * before this script's own real-state reads/writes ever run), and no amount
 * of module-level caching inside the subprocess can leak back into this
 * process's `process.env` or its already-open file handles. See
 * `scripts/rationalization-review.test.ts` for a checksum-before/after test
 * confirming a full script run (dry AND `--execute`) never mutates anything
 * in the configured state dir except the ONE self-review record `--execute`
 * itself appends.
 *
 * @see mt#2901 — this task
 * @see src/domain/calibration/rationalization-review.ts — pure panel/cadence logic
 * @see docs/architecture/evaluation-loop-phase2.md — design writeup (panel columns,
 *      auto-affirm threshold, family-metadata convention, cadence methodology)
 * @see scripts/run-guard-canaries.ts — the subprocess this script now spawns rather
 *      than reimplementing canary-running in-process
 */

// Required before any tsyringe-DI-consuming module (createCliContainer, used
// by resolveFamilyRecurrences below) — mirrors scripts/backfill-close-stale-asks.ts.
import "reflect-metadata";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildPanel,
  computeCadenceRecommendation,
  dedupeLegacyCalibrationOverlap,
  type RawFireRecord,
  type CanaryStatusInput,
  type AttentionCostInput,
  type FamilyRecurrenceInput,
} from "../src/domain/calibration/rationalization-review";

const FAMILY_TAG_PREFIX = "family:";

/**
 * Run the full guard-canary suite as a SEPARATE subprocess
 * (`scripts/run-guard-canaries.ts --json`) rather than in-process — see the
 * module doc comment's "Isolation" section for why. Fail-open: any spawn
 * failure, non-zero-non-one exit combined with unparseable output, or a
 * `JSON.parse` failure degrades to `[]` (every guard then reports
 * `canary=MISSING`, an existing, already-handled panel state) rather than
 * crashing the whole review.
 */
async function runCanarySuite(): Promise<CanaryStatusInput[]> {
  try {
    const scriptPath = join(process.cwd(), "scripts", "run-guard-canaries.ts");
    const proc = Bun.spawn([process.execPath, scriptPath, "--json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const report = JSON.parse(stdout) as {
      results: Array<{ guardName: string; passed?: boolean }>;
    };
    return report.results.map((r) => ({
      guardName: r.guardName,
      status: r.passed === undefined ? "MISSING" : r.passed ? "PASS" : "FAIL",
    }));
  } catch (err) {
    if (process.env["MT2901_DEBUG"]) console.error("runCanarySuite failed:", err);
    return [];
  }
}

/**
 * Best-effort resolution of per-guard recurrence-since-done counts from the
 * task-metadata family convention. Bootstraps the real task service (same
 * pattern as `scripts/backfill-close-stale-asks.ts`) and scans ALL tasks for
 * a `family:<slug>` tag — the convention documented in
 * docs/architecture/evaluation-loop-phase2.md. Graceful degradation: any
 * bootstrap/query failure (no DB reachable in this exec context, etc.)
 * returns `[]` rather than throwing — this is a REVIEW tool, and the panel
 * must still print with `recurrencesSinceDone: "n/a"` rather than fail
 * entirely on a DB hiccup (mirrors the fire-log's own fail-open posture).
 */
async function resolveFamilyRecurrences(
  records: RawFireRecord[]
): Promise<FamilyRecurrenceInput[]> {
  // The persistence/config bootstrap below (`initializeConfiguration` ->
  // `createCliContainer`) emits its own winston `log.info(...)` lines
  // ("Persistence provider created", "Running migrations from...", etc.) —
  // `packages/shared/src/logger.ts`'s program logger sends "info" level to
  // STDOUT by design, and under some inherited environments (verified: any
  // env where a caller has set `MINSKY_LOG_MODE=STRUCTURED`, e.g. this
  // script's own isolation tests spawn it with an inherited test-runner
  // env) those lines land as JSON log records INTERLEAVED with this
  // script's own `--json` output on the SAME stdout stream, corrupting it
  // into unparseable output. `LOGLEVEL=error` (the logger's own documented
  // env knob) silences the "info"-level noise without touching this
  // script's own `console.log`/`process.stdout.write` calls, which are
  // unaffected by winston's level filtering. Respects an explicit caller
  // override (e.g. `LOGLEVEL=debug` while investigating) via `??=`.
  process.env["LOGLEVEL"] ??= "error";

  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  // Tracked outside the inner try so the `finally` below can close it on
  // EVERY exit path (success, early return, or thrown error) — an unclosed
  // Postgres connection keeps the process's event loop alive indefinitely
  // after main() otherwise finishes (verified: a full script run printed a
  // complete, correct report and then hung until killed, exit 143). Closing
  // the connection is the structural fix; letting the process exit
  // NATURALLY once the event loop empties (rather than a forced
  // `process.exit()`) also avoids truncating buffered stdout writes when
  // stdout is a pipe (the JSON report can exceed a single pipe-buffer flush).
  let persistenceToClose: { close(): Promise<void> } | undefined;
  try {
    await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
    const container = await createCliContainer();
    await container.initialize();

    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence || !(persistence instanceof PersistenceProvider)) return [];
    persistenceToClose = persistence;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return [];
    }

    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: persistence,
    });

    const allTasks = await taskService.listTasks({ all: true });

    // Group family-tagged tasks by slug; the ANCHOR for recurrencesSinceDone
    // is the EARLIEST DONE-status task carrying that family tag (the
    // original structural fix) — later same-family tags (e.g. a subsequent
    // incident/discovery task) do not reset the anchor. See the doc's
    // "Family-membership metadata convention" section.
    const bySlug = new Map<string, { taskId: string; status: string; updatedAt?: string }[]>();
    for (const task of allTasks) {
      const familyTags = (task.tags ?? []).filter((t) => t.startsWith(FAMILY_TAG_PREFIX));
      for (const tag of familyTags) {
        const slug = tag.slice(FAMILY_TAG_PREFIX.length);
        const list = bySlug.get(slug) ?? [];
        list.push({
          taskId: task.id,
          status: task.status,
          updatedAt: task.updatedAt ? task.updatedAt.toISOString() : undefined,
        });
        bySlug.set(slug, list);
      }
    }

    const results: FamilyRecurrenceInput[] = [];
    for (const [slug, entries] of bySlug) {
      const doneEntries = entries
        .filter((e) => e.status === "DONE" && e.updatedAt)
        .sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
      const anchor = doneEntries[0];
      if (!anchor || !anchor.updatedAt) continue;

      // Convention: the family slug IS the guard name for the common
      // single-guard-family case (see doc). recurrencesSinceDone counts
      // fire-log/calibration records for that guard AFTER the anchor's
      // DONE timestamp.
      const recurrencesSinceDone = records.filter(
        (r) => r.guardName === slug && r.timestamp > (anchor.updatedAt as string)
      ).length;

      results.push({
        guardName: slug,
        familySlug: slug,
        fixTaskId: anchor.taskId,
        fixTaskStatus: "DONE",
        fixTaskDoneAt: anchor.updatedAt,
        recurrencesSinceDone,
      });
    }
    return results;
  } catch (err) {
    // Fail-open — a DB/config hiccup degrades to "n/a" panel-wide, not a crash.
    if (process.env["MT2901_DEBUG"]) console.error("resolveFamilyRecurrences failed:", err);
    return [];
  } finally {
    // Always release the connection, on every exit path, so the process can
    // exit naturally once main() finishes — see the doc comment above.
    if (persistenceToClose) {
      try {
        await persistenceToClose.close();
      } catch (closeErr) {
        if (process.env["MT2901_DEBUG"]) console.error("persistence.close() failed:", closeErr);
      }
    }
  }
}

async function readCalibrationLogContent(path: string): Promise<string | null> {
  const abs = join(process.cwd(), path);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf-8");
}

/** Earliest/latest timestamp spanned by the corpus, in days. */
function corpusWindowDays(records: RawFireRecord[]): number {
  if (records.length === 0) return 0;
  let min = records[0]?.timestamp ?? "";
  let max = min;
  for (const r of records) {
    if (r.timestamp < min) min = r.timestamp;
    if (r.timestamp > max) max = r.timestamp;
  }
  const ms = new Date(max).getTime() - new Date(min).getTime();
  return ms <= 0 ? 0 : ms / (1000 * 60 * 60 * 24);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const execute = args.includes("--execute");
  const reportOnly = args.includes("--report-only");
  const startedAt = Date.now();

  // -------------------------------------------------------------------------
  // 1. Real reads FIRST — before any canary-sandbox env override below.
  // -------------------------------------------------------------------------
  const { readFireLogEntries } = await import("../.minsky/hooks/fire-log");
  const { CALIBRATION_LOG_REGISTRY, readAllCalibrationLogsAsFireLogEntries } = await import(
    "../src/domain/calibration/calibration-sweep"
  );

  const realFireLogEntries = readFireLogEntries();
  const calibrationEntries = await readAllCalibrationLogsAsFireLogEntries(
    CALIBRATION_LOG_REGISTRY,
    readCalibrationLogContent
  );

  const rawRecords: RawFireRecord[] = [
    ...realFireLogEntries.map(
      (e): RawFireRecord => ({
        timestamp: e.timestamp,
        guardName: e.guardName,
        decision: e.decision,
        durationMs: e.durationMs,
        overrideClassification: e.overrideClassification,
        source: "fire-log",
      })
    ),
    ...calibrationEntries.map(
      (e): RawFireRecord => ({
        timestamp: e.timestamp,
        guardName: e.guardName,
        decision: e.decision,
        durationMs: e.durationMs,
        source: "calibration",
      })
    ),
  ];

  // De-duplicate BEFORE any downstream consumer (recurrence resolution,
  // panel building, corpus-window/cadence math) — five of the six legacy
  // calibration detectors are ALSO dispatcher-instrumented, so a single real
  // fire can otherwise be double-counted across both corpora. See
  // dedupeLegacyCalibrationOverlap's doc comment for the guard-scoped rule.
  const records = dedupeLegacyCalibrationOverlap(rawRecords);

  // -------------------------------------------------------------------------
  // 2. Family-recurrence resolution (best-effort; uses the de-duplicated
  //    records above).
  // -------------------------------------------------------------------------
  const familyRecurrences = await resolveFamilyRecurrences(records);

  // -------------------------------------------------------------------------
  // 3. Canary suite — run as a separate subprocess (see module doc comment's
  //    "Isolation" section). No env mutation in THIS process at all.
  // -------------------------------------------------------------------------
  const canaryStatuses = await runCanarySuite();

  // -------------------------------------------------------------------------
  // 4. Attention-cost annotations — pulled from GUARD_REGISTRY.
  // -------------------------------------------------------------------------
  const { GUARD_REGISTRY } = await import("../.minsky/hooks/registry");
  const attentionCosts: AttentionCostInput[] = [];
  for (const reg of GUARD_REGISTRY) {
    if (reg.attentionCost) {
      attentionCosts.push({
        guardName: reg.name,
        denialMessageSizeChars: reg.attentionCost.denialMessageSizeChars,
        optionCount: reg.attentionCost.optionCount,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Build the panel + cadence recommendation (pure).
  // -------------------------------------------------------------------------
  const panel = buildPanel({ records, canaryStatuses, attentionCosts, familyRecurrences });
  const distinctGuardsWithFires = new Set(records.map((r) => r.guardName)).size;
  const cadence = computeCadenceRecommendation({
    totalFires: records.length,
    distinctGuardsWithFires,
    corpusWindowDays: corpusWindowDays(records),
  });
  const rowsWithRecurrences = panel.rows.filter(
    (r) => typeof r.recurrencesSinceDone === "number" && r.recurrencesSinceDone > 0
  );
  const recurrenceCaveat =
    rowsWithRecurrences.length > 0
      ? `CAVEAT (recurrencesSinceDone): the anchor timestamp is the family-tagged fix ` +
        `task's \`updatedAt\` — ANY subsequent edit to that task (including the family-tag ` +
        `edit itself) bumps it, so this count is a CONSERVATIVE UNDERCOUNT relative to the ` +
        `true DONE-transition time, never inflated. Affects: ${rowsWithRecurrences.map((r) => r.guardName).join(", ")}. ` +
        `Full explanation: docs/architecture/evaluation-loop-phase2.md "Known limitation."`
      : null;

  // -------------------------------------------------------------------------
  // 6. Report.
  // -------------------------------------------------------------------------
  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify(
        {
          panel,
          cadence,
          recordCount: records.length,
          droppedAsOverlap: rawRecords.length - records.length,
          caveats: recurrenceCaveat ? [recurrenceCaveat] : [],
        },
        null,
        2
      )}\n`
    );
  } else {
    console.log(`Rationalization review — ${new Date().toISOString()}`);
    console.log(
      `Corpus: ${records.length} records after de-duplication ` +
        `(${rawRecords.length} raw = ${realFireLogEntries.length} real fire-log + ` +
        `${calibrationEntries.length} legacy-calibration; ${rawRecords.length - records.length} ` +
        `dropped as fire-log/calibration overlap), ${panel.rows.length} guards.\n`
    );
    for (const row of panel.rows) {
      const latency = row.latency
        ? `p50=${row.latency.p50}ms p95=${row.latency.p95}ms p99=${row.latency.p99}ms`
        : "no real-fire-log latency data";
      const attn = row.attentionCost
        ? `${row.attentionCost.denialMessageSizeChars}ch/${row.attentionCost.optionCount}opt`
        : "unannotated";
      const reasonsSuffix =
        row.outlierReasons.length > 0 ? ` reasons=[${row.outlierReasons.join(", ")}]` : "";
      console.log(
        `[${row.disposition.toUpperCase()}] ${row.guardName} — fires=${row.fireCount} ` +
          `overrides=${row.overrideCount} (${(row.overrideRate * 100).toFixed(1)}%) ` +
          `canary=${row.canaryStatus} attentionCost=${attn} ` +
          `daysSinceLastFire=${row.daysSinceLastFire ?? "never"} ` +
          `recurrencesSinceDone=${row.recurrencesSinceDone} latency=${latency}${reasonsSuffix}`
      );
    }
    console.log(`\n${panel.autoAffirmSummaryLine}`);
    console.log(`Outliers requiring disposition (${panel.outliers.length}):`);
    for (const o of panel.outliers) {
      console.log(`  - ${o.guardName}: ${o.outlierReasons.join(", ")}`);
    }
    console.log(`\nCadence recommendation: ${cadence.recommendedDays} days`);
    console.log(cadence.rationale);
    if (recurrenceCaveat) console.log(`\n${recurrenceCaveat}`);
  }

  // -------------------------------------------------------------------------
  // 7. Self-review fire-logging (--execute only). This script's own process
  //    env was never mutated (the canary suite ran in a separate subprocess
  //    at step 3), so no restoration is needed here.
  // -------------------------------------------------------------------------
  if (execute) {
    const { recordFireLogEntry } = await import("../.minsky/hooks/fire-log");
    recordFireLogEntry({
      guardName: "rationalization-review",
      event: "Review",
      decision: reportOnly ? "deny" : "allow",
      durationMs: Date.now() - startedAt,
    });
    console.log(
      `\nSelf-review fire-log record written: decision=${reportOnly ? "deny (report-only / failed review)" : "allow (ended in explicit ask)"}`
    );
  }
}

await main();
// No explicit process.exit() here (deliberate — see resolveFamilyRecurrences's
// `finally` block): the task-service bootstrap's Postgres connection is now
// closed on every exit path, so the process exits NATURALLY once the event
// loop empties. A forced `process.exit()` immediately after a large stdout
// write (the JSON report can exceed a single pipe-buffer flush) risks
// truncating that write when stdout is a pipe rather than a TTY — verified
// directly: an earlier version of this script that force-exited produced
// truncated, unparseable JSON under `Bun.spawn({stdout: "pipe"})` in
// scripts/rationalization-review.test.ts. Closing the real resource that
// was keeping the event loop alive is the structural fix; forcing exit was
// the workaround it replaced.
