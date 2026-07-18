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
 * state): `MINSKY_STATE_DIR`/`CLAUDE_PROJECT_DIR` are pointed at a fresh temp
 * directory ONLY around the canary-suite invocation, then restored to their
 * original values before this script's own self-review record (if any) is
 * written — so the canary sandbox never leaks into the real fire-log, and the
 * self-review record never lands in the sandbox.
 *
 * @see mt#2901 — this task
 * @see src/domain/calibration/rationalization-review.ts — pure panel/cadence logic
 * @see docs/architecture/evaluation-loop-phase2.md — design writeup (panel columns,
 *      auto-affirm threshold, family-metadata convention, cadence methodology)
 * @see scripts/run-guard-canaries.ts — the isolation-pattern precedent this mirrors
 */

// Required before any tsyringe-DI-consuming module (createCliContainer, used
// by resolveFamilyRecurrences below) — mirrors scripts/backfill-close-stale-asks.ts.
import "reflect-metadata";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPanel,
  computeCadenceRecommendation,
  type RawFireRecord,
  type CanaryStatusInput,
  type AttentionCostInput,
  type FamilyRecurrenceInput,
} from "../src/domain/calibration/rationalization-review";

const FAMILY_TAG_PREFIX = "family:";

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
  try {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    const { createCliContainer } = await import("../src/composition/cli");
    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

    await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
    const container = await createCliContainer();
    await container.initialize();

    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence || !(persistence instanceof PersistenceProvider)) return [];
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

  const records: RawFireRecord[] = [
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

  // -------------------------------------------------------------------------
  // 2. Family-recurrence resolution (best-effort; uses the records read above).
  // -------------------------------------------------------------------------
  const familyRecurrences = await resolveFamilyRecurrences(records);

  // -------------------------------------------------------------------------
  // 3. Canary suite — isolate MINSKY_STATE_DIR/CLAUDE_PROJECT_DIR for this
  //    sub-scope ONLY, then restore before anything else runs.
  // -------------------------------------------------------------------------
  const originalStateDir = process.env["MINSKY_STATE_DIR"];
  const originalProjectDir = process.env["CLAUDE_PROJECT_DIR"];
  const canaryStateDir = mkdtempSync(join(tmpdir(), "mt2901-rationalization-review-"));
  process.env["MINSKY_STATE_DIR"] = canaryStateDir;
  process.env["CLAUDE_PROJECT_DIR"] = canaryStateDir;

  let canaryStatuses: CanaryStatusInput[] = [];
  try {
    const { runAllRegistryCanaries, runAllStandaloneCanaries } = await import(
      "../.minsky/hooks/canary-runner"
    );
    const { STANDALONE_GUARD_CANARIES } = await import("./lib/standalone-guard-canaries");
    const registryResults = await runAllRegistryCanaries();
    const standaloneResults = await runAllStandaloneCanaries(STANDALONE_GUARD_CANARIES);
    canaryStatuses = [...registryResults, ...standaloneResults].map((r) => ({
      guardName: r.guardName,
      status: r.passed === undefined ? "MISSING" : r.passed ? "PASS" : "FAIL",
    }));
  } finally {
    if (originalStateDir === undefined) delete process.env["MINSKY_STATE_DIR"];
    else process.env["MINSKY_STATE_DIR"] = originalStateDir;
    if (originalProjectDir === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
    else process.env["CLAUDE_PROJECT_DIR"] = originalProjectDir;
    rmSync(canaryStateDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 4. Attention-cost annotations — pulled from GUARD_REGISTRY (real env
  //    already restored above; this import has no fs/env side effects).
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

  // -------------------------------------------------------------------------
  // 6. Report.
  // -------------------------------------------------------------------------
  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify({ panel, cadence, recordCount: records.length }, null, 2)}\n`
    );
  } else {
    console.log(`Rationalization review — ${new Date().toISOString()}`);
    console.log(
      `Corpus: ${records.length} records (${realFireLogEntries.length} real fire-log + ${calibrationEntries.length} legacy-calibration), ${panel.rows.length} guards.\n`
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
  }

  // -------------------------------------------------------------------------
  // 7. Self-review fire-logging (--execute only). Real env is already
  //    restored (step 3's finally block ran before this point).
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
