#!/usr/bin/env bun
/**
 * Smoke: the cockpit changeset detail page's LIVE-PR data path (mt#3096).
 *
 * WHY THIS EXISTS (implement-task §7a, binding direction): the correctness of
 * mt#3096 depends on live external behavior no unit test can cover — whether
 * the cockpit daemon can actually authenticate to GitHub and resolve a PR by
 * number. The unit tests exercise the pure mappers against fixtures; they say
 * nothing about whether the REAL wired export (`getServerChangesetService`)
 * binds to a working credential.
 *
 * This matters more than usual here because the failure is fail-open by
 * design: when the reader is unavailable the endpoint degrades to the session
 * snapshot rather than erroring. That is the right product behavior, but it
 * makes a permanently-dead credential path indistinguishable from "no live
 * data" at every downstream surface — exactly the mt#2076 five-week blind spot.
 * This script is the check that tells the two apart.
 *
 * Usage:
 *   bun scripts/verify-changeset-live-source.ts [prNumber]
 *
 * Exit codes:
 *   0 — PASS (live PR resolved with a usable title + URL) or SKIP (no credential)
 *   1 — FAIL (reader present but the PR did not resolve, or resolved unusably)
 *
 * SKIPs rather than fails when GitHub isn't configured, so the script is safe
 * to run in an environment with no credential.
 */
// Required before anything that resolves configuration: the config layer is
// tsyringe-backed and throws "requires a reflect polyfill" without it. The
// daemon gets this from its own entry point; a standalone script must import
// it itself (same as every other script under scripts/).
import "reflect-metadata";
import { getServerChangesetService, getServerChecksReader } from "../src/cockpit/db-providers";

const DEFAULT_PR = "2222";

function emit(payload: Record<string, unknown>): void {
  // Never prints a token — only resolved PR metadata.
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * Initialize configuration. The cockpit daemon does this at its entry point, so
 * `getConfiguration()` (and therefore credential resolution) works there; a
 * standalone script must do it itself or the config layer throws
 * "Configuration not initialized".
 */
async function bootstrap(): Promise<void> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });
}

async function main(): Promise<number> {
  const prNumber = process.argv[2] ?? DEFAULT_PR;

  if (!/^[0-9]+$/.test(prNumber)) {
    emit({ status: "FAIL", reason: `invalid PR number: ${prNumber}` });
    return 1;
  }

  await bootstrap();

  const reader = await getServerChangesetService();
  if (!reader) {
    emit({
      status: "SKIP",
      prNumber,
      reason:
        "no changeset reader — GitHub repository backend not configured, or the credential " +
        "could not be resolved. The detail endpoint degrades to the session snapshot.",
    });
    return 0;
  }

  const cs = await reader.get(prNumber);
  if (!cs) {
    emit({
      status: "FAIL",
      prNumber,
      reason: `reader is available but PR #${prNumber} did not resolve (404 or wrong repo)`,
    });
    return 1;
  }

  const gh = cs.metadata?.github;
  const result: Record<string, unknown> = {
    status: "PASS",
    prNumber,
    title: cs.title,
    state: cs.status,
    author: cs.author?.username ?? null,
    bodyLength: (cs.description ?? "").length,
    additions: gh?.additions ?? null,
    deletions: gh?.deletions ?? null,
    changedFiles: gh?.changedFiles ?? null,
    mergedAt: gh?.mergedAt ?? null,
    mergedBy: gh?.mergedBy ?? null,
    htmlUrl: gh?.htmlUrl ?? null,
    commits: cs.commits?.length ?? 0,
    reviews: cs.reviews?.length ?? 0,
  };

  // The two assertions that map directly to the reported bugs.
  const problems: string[] = [];
  if (typeof cs.title !== "string" || cs.title.trim().length === 0) {
    problems.push("title is empty — the '(no title)' bug would still reproduce");
  }
  if (!gh?.htmlUrl) {
    problems.push("htmlUrl is missing — the 'Open on GitHub' break-out would not render");
  }

  // --- mt#3097: exercise the CI check-runs binding -----------------------
  //
  // This is the §7a binding check for the check-runs path: the unit tests
  // exercise the pure derivation against fixtures, which says nothing about
  // whether `getServerChecksReader` actually authenticates and returns real
  // check-runs. The endpoint degrades `checks` to null on failure, so a dead
  // binding would be indistinguishable from "this commit has no CI" at every
  // downstream surface — exactly the failure mode this script exists to catch.
  const headSha = gh?.headSha;
  if (!headSha) {
    result["checks"] = { status: "SKIP", reason: "no headSha on the resolved changeset" };
  } else {
    const checksReader = await getServerChecksReader();
    if (!checksReader) {
      result["checks"] = { status: "SKIP", reason: "no checks reader — GitHub not configured" };
    } else {
      try {
        const checks = await checksReader(headSha);
        result["checks"] = {
          status: "PASS",
          headSha,
          allPassed: checks.allPassed,
          total: checks.summary.total,
          passed: checks.summary.passed,
          failed: checks.summary.failed,
          pending: checks.summary.pending,
        };
        if (checks.summary.total === 0) {
          problems.push(
            `check-runs returned 0 checks for ${headSha} — expected CI on this commit; ` +
              `a zero result here may indicate a dead binding rather than a genuinely uncovered commit`
          );
        }
      } catch (checksErr) {
        result["checks"] = {
          status: "FAIL",
          headSha,
          error: checksErr instanceof Error ? checksErr.message : String(checksErr),
        };
        problems.push("check-runs fetch threw — the CI binding is not working");
      }
    }
  }

  if (problems.length > 0) {
    emit({ ...result, status: "FAIL", problems });
    return 1;
  }

  emit(result);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    emit({
      status: "FAIL",
      reason: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
