#!/usr/bin/env bun
/**
 * mt#4049 — verify the `all-suppressed` review-due leg against a REAL log.
 *
 * ## Why this exists rather than a unit test alone
 *
 * The unit tests feed `computeReviewDueLogs` hand-built fixtures. They pin the
 * routing rule, and they cannot tell you whether the rule fires for the log the
 * task was filed about: that depends on what the detector actually wrote, which
 * lives on disk and turns over (this corpus was re-rooted entirely by mt#4748's
 * migration, so the 243-record window the spec was written against is gone).
 *
 * ## Why it does not just run the sweep
 *
 * `minsky observability calibration-review` resolves its project key from the
 * repo root, and a session workspace is a DIFFERENT root — so running it from a
 * session returns a clean, plausible zero for every log (measured: `54` results,
 * `0` with records) rather than an error. That is the mem#704 shape: a probe
 * that returns the same output whether or not the thing under test works. This
 * script reads the log path EXPLICITLY and feeds the production sweep, so the
 * records it judges are the real ones no matter which workspace it runs from.
 *
 * Exit 0 = the named log routes with the expected reason.
 * Exit 1 = it does not (the finding).
 * Exit 2 = the check could not run — never conflated with a pass.
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readdirSync, existsSync } from "fs";

import {
  CALIBRATION_LOG_REGISTRY,
  computeReviewDueLogs,
  runSweep,
  type WatermarkStore,
} from "../src/domain/calibration/calibration-sweep";

const LOG_NAME = process.argv[2] ?? "knowledge-acquisition";
const EXPECTED_REASON = process.argv[3] ?? "all-suppressed";

/**
 * Find the one project-keyed state dir holding this log.
 *
 * Globbed rather than hardcoded: `<key>` is a hash of the repo root (mt#4748),
 * so it differs per machine and per checkout. Zero matches and two matches are
 * BOTH exit-2 — one means nothing was measured, the other means it is ambiguous
 * which corpus was, and neither is a verdict about the routing.
 */
function resolveLogPath(name: string): string {
  const projectsDir = join(homedir(), ".local", "state", "minsky", "projects");
  if (!existsSync(projectsDir)) {
    console.error(`[verify-all-suppressed] no state dir at ${projectsDir}`);
    process.exit(2);
  }
  const file = `${name}-calibration.jsonl`;
  const matches = readdirSync(projectsDir)
    .map((key) => join(projectsDir, key, file))
    .filter((p) => existsSync(p));

  if (matches.length !== 1) {
    const detail = matches.length > 1 ? `:\n  ${matches.join("\n  ")}` : "";
    console.error(
      `[verify-all-suppressed] expected exactly 1 log named ${file}, found ${matches.length}${detail}`
    );
    process.exit(2);
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return matches[0]!;
}

async function main(): Promise<void> {
  const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === LOG_NAME);
  if (!entry) {
    console.error(`[verify-all-suppressed] "${LOG_NAME}" is not in CALIBRATION_LOG_REGISTRY`);
    process.exit(2);
  }

  const logPath = resolveLogPath(LOG_NAME);
  let content: string;
  try {
    content = readFileSync(logPath, "utf-8");
  } catch (err) {
    console.error(`[verify-all-suppressed] cannot read ${logPath}: ${String(err)}`);
    process.exit(2);
  }

  // Deliberately an EMPTY watermark store: the question is whether the leg
  // routes this log's records, and a real watermark would subtract some of them
  // out. An all-suppressed log is ungated on the watermark by design, so this
  // exercises the same branch either way — see the leg's own comment.
  const watermarks: WatermarkStore = {};
  const results = await runSweep([entry], async () => content, watermarks);
  const result = results[0];
  if (!result) {
    console.error("[verify-all-suppressed] sweep returned no result");
    process.exit(2);
  }

  const due = computeReviewDueLogs(results, watermarks, Date.now());
  const routed = due.find((d) => d.name === LOG_NAME);

  console.log(
    JSON.stringify(
      {
        log: LOG_NAME,
        path: logPath,
        totalFires: result.totalFires,
        injectedFiresSinceLastReview: result.injectedFiresSinceLastReview,
        suppressedSinceLastReview: result.suppressedSinceLastReview,
        distinctPhrases: result.distinctPhrases,
        atCountThreshold: result.atCountThreshold,
        pastThreshold: result.pastThreshold,
        allSuppressed: result.allSuppressed,
        // The compounding trap the spec names: a routed log with no records to
        // show is a warning with no evidence attached.
        newRecordsSurfaced: result.newRecords.length,
        routedReason: routed?.reason ?? null,
      },
      null,
      2
    )
  );

  if (!routed) {
    console.error(
      `[verify-all-suppressed] FAIL — ${LOG_NAME} is NOT review-due. ` +
        `This is the defect mt#4049 exists to fix; if it reports here, the leg is not firing.`
    );
    process.exit(1);
  }
  if (routed.reason !== EXPECTED_REASON) {
    console.error(
      `[verify-all-suppressed] FAIL — ${LOG_NAME} routed as "${routed.reason}", expected "${EXPECTED_REASON}"`
    );
    process.exit(1);
  }
  if (result.newRecords.length === 0) {
    console.error(
      `[verify-all-suppressed] FAIL — ${LOG_NAME} routed as "${routed.reason}" but surfaced ZERO ` +
        `records. The reviewer would be told to judge a log and shown nothing.`
    );
    process.exit(1);
  }

  console.log(
    `[verify-all-suppressed] OK — ${LOG_NAME} routes as "${routed.reason}" with ` +
      `${result.newRecords.length} record(s) surfaced.`
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[verify-all-suppressed] unexpected failure: ${String(err)}`);
    process.exit(2);
  });
}
