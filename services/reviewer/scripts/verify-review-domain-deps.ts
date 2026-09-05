#!/usr/bin/env bun
/**
 * Live binding check for the review's domain context (mt#4998).
 *
 * ## What only a live run can answer
 *
 * `sweeper.test.ts`'s mt#4998 block proves the deps are FORWARDED — it hands
 * `retriggerViaRunReview` opaque sentinels and asserts they arrive at
 * `runReview`. That is a seam-injected test, and per
 * `/implement-task` §7 item 8 (binding direction) a seam-injected test is not
 * evidence for the REAL-WIRED binding of the seam. It would pass identically
 * if `buildReviewDomainDeps` returned five nulls against a live container.
 *
 * That distinction is not hypothetical here. Every dep in this set is
 * `?: T | null` and degrades SILENTLY when absent — a null `taskService`
 * produces `specVerification: []`, a null `persistenceProvider` produces
 * `Tier: unknown`, and the review posts and looks normal either way. A
 * never-worked binding is therefore indistinguishable from "this PR has no
 * bound task" at every downstream surface, which is exactly the fail-open
 * shape §7 item 8 flags as the extra red flag. It is also how the original
 * defect survived in production unnoticed.
 *
 * So this script boots the REAL domain container, runs the REAL
 * `buildReviewDomainDeps`, and then EXERCISES the two deps whose absence
 * caused the observed symptoms rather than merely null-checking them.
 *
 * ## What it deliberately does NOT cover
 *
 * It does not drive a review. Whether a sweeper-initiated review ultimately
 * posts a populated `specVerification` array depends on the model as well as
 * the wiring, and forcing a real sweeper retrigger requires a genuinely
 * missed review in production, which cannot be manufactured pre-merge. This
 * verifies the half that is ours: that the container yields live, working
 * deps and that the builder passes them through. The remaining half is named
 * UNVERIFIED in the PR body rather than implied.
 *
 * It also does not exercise `memoryLookup` / `askLookup` / `sessionLookup`
 * beyond a null check — those resolve `mem#N` / `ask#N` / `ws#N` references
 * that only appear in some specs, they were never implicated in the observed
 * symptoms, and calling them would require a record known to exist. Stated
 * rather than implied, because a check that looks total and is not is worse
 * than one whose bound is written down.
 *
 * ## Usage
 *
 *   bun services/reviewer/scripts/verify-review-domain-deps.ts [--task=mt#4998] [--require]
 *
 * Exits 0 when every dep is present and both exercised deps respond, 2 on any
 * failure, and 0 with a SKIP notice when the domain container cannot boot
 * (no persistence configured — safe in an unconfigured CI job). Pass
 * `--require` to turn that SKIP into an exit 2 instead. Writes
 * `services/reviewer/scripts/verify-review-domain-deps-results.json`.
 */

// The domain container resolves tsyringe-decorated classes, which need the
// reflect-metadata polyfill installed before any of them is constructed —
// same reason `server.ts:16` and the other container-booting scripts import
// it first. Without this the boot throws a polyfill error that this script's
// catch would report as a SKIP, which reads exactly like "no persistence
// configured" and would make the check silently incapable of passing.
import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootDomainContainer, buildReviewDomainDeps } from "../src/domain-container";

const RESULTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "verify-review-domain-deps-results.json"
);

/**
 * The keys `buildReviewDomainDeps` must populate. Declared here rather than
 * imported from `sweeper.ts` so this script fails if the two ever diverge —
 * an independent statement of the contract, not an echo of it.
 */
const REQUIRED_KEYS = [
  "taskService",
  "persistenceProvider",
  "memoryLookup",
  "askLookup",
  "sessionLookup",
] as const;

interface Results {
  ranAt: string;
  outcome: "pass" | "fail" | "skip";
  skipReason?: string;
  presentKeys: string[];
  missingKeys: string[];
  exercised: {
    taskService: { ok: boolean; taskId: string; detail: string };
    persistenceProvider: { ok: boolean; detail: string };
  } | null;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function finish(results: Results, code: number): never {
  writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nWrote ${RESULTS_PATH}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const taskId = arg("task") ?? "mt#4998";
  const requireBoot = process.argv.includes("--require");
  const ranAt = new Date().toISOString();

  let domainServices: Awaited<ReturnType<typeof bootDomainContainer>>;
  try {
    domainServices = await bootDomainContainer();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`SKIP: domain container did not boot — ${reason}`);
    finish(
      {
        ranAt,
        outcome: "skip",
        skipReason: reason,
        presentKeys: [],
        missingKeys: [...REQUIRED_KEYS],
        exercised: null,
      },
      requireBoot ? 2 : 0
    );
  }

  // The real builder, on the real container — the binding under test.
  const deps = buildReviewDomainDeps(domainServices) as Record<string, unknown>;

  const presentKeys = REQUIRED_KEYS.filter((k) => deps[k] != null);
  const missingKeys = REQUIRED_KEYS.filter((k) => deps[k] == null);

  // Exercise, don't just null-check. A non-null handle to a dead binding is
  // the failure mode this script exists to catch (mem#654 / §7 item 8): the
  // reviewer widget's DB layer threw on every query for ~5 weeks while
  // rendering healthy zeros.
  let taskOk = false;
  let taskDetail = "not attempted (taskService missing)";
  if (deps["taskService"] != null) {
    try {
      const spec = await domainServices.taskService.getTaskSpecContent(taskId);
      const content = (spec as { content?: string } | null)?.content ?? "";
      taskOk = content.length > 0;
      taskDetail = taskOk
        ? `getTaskSpecContent(${taskId}) returned ${content.length} chars`
        : `getTaskSpecContent(${taskId}) returned empty content`;
    } catch (err) {
      taskDetail = `getTaskSpecContent(${taskId}) threw: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  let persistenceOk = false;
  let persistenceDetail = "not attempted (persistenceProvider missing)";
  if (deps["persistenceProvider"] != null) {
    try {
      // `resolveTier`'s ProvenanceService lookup needs SQL capability; a
      // provider that reports no SQL capability silently yields `Tier: unknown`
      // exactly as a null provider does.
      const caps = domainServices.persistenceProvider.capabilities;
      persistenceOk = caps?.sql === true;
      persistenceDetail = `capabilities.sql=${String(caps?.sql)}`;
    } catch (err) {
      persistenceDetail = `capabilities read threw: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  const outcome: Results["outcome"] =
    missingKeys.length === 0 && taskOk && persistenceOk ? "pass" : "fail";

  finish(
    {
      ranAt,
      outcome,
      presentKeys: [...presentKeys],
      missingKeys: [...missingKeys],
      exercised: {
        taskService: { ok: taskOk, taskId, detail: taskDetail },
        persistenceProvider: { ok: persistenceOk, detail: persistenceDetail },
      },
    },
    outcome === "pass" ? 0 : 2
  );
}

await main();
