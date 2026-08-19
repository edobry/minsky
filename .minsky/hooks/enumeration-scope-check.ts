#!/usr/bin/env bun
// PreToolUse observer: a PR that changes a SERIALIZED contract surface whose
// gate-(h) consumer sweep never reached `docs/` (mt#4171).
//
// THE QUESTION IS THE STRONGER ONE. The sibling `duplicate-check-search-provenance`
// (mt#4004) asks whether a search happened; `claim-provenance-scan` (mt#4168) asks
// whether a claim has a call behind it. Gate (h)'s recorded failures are neither:
// in every one, the agent DID sweep, and the sweep missed a prescribed directory.
//
//   - mt#1610 enumerated 25+ code sites and missed three `docs/` files, then
//     missed the Railway env-var consumers entirely and crashed production.
//   - mt#3969 grepped one symbol correctly and missed seven callers that never
//     mention it.
//   - mt#4252 (2026-08-18) produced a six-row consumer table and correctly ruled
//     the Rust side out by READING `rustConsumedFields` rather than assuming —
//     and did not sweep `docs/`. `docs/principal-channel.md:86` states its field
//     lists are "exhaustive per variant"; the change made that sentence false
//     rather than merely dating it. Caught by the reviewer as BLOCKING on
//     PR #3101.
//
// So the checkable question is not "did you search?" but "did the search you ran
// cover the prescribed set?"
//
// ===========================================================================
// WHY THIS FIRES AT `session_pr_create` AND NOT AT READY, AGAINST ADR-042's
// TABLE — measured, not preferred (mt#4171 planning + implementation, 2026-08-19)
// ===========================================================================
//
// ADR-042 assigns gate (h)'s backstop to PreToolUse on `tasks_status_set` where
// the target is READY. Its DISCRIMINATOR, stated in the same Decision section, is
// to "place each mechanizable one at the seam where its evidence first exists."
// Two premises under the READY assignment are false, and the ADR's own rule then
// points elsewhere:
//
// 1. **"The sweep's directories are structured arguments."** Measured across the
//    589 on-disk transcripts: `Bash` 27561 search calls vs 339 `session_grep_search`,
//    180 `repo_search`, 21 `Grep`, 9 `git_search`, 5 `Glob`. ~98% of this repo's
//    searching is a shell command string. (Handled — see the shared table's
//    sweep section, which parses the command string.)
//
// 2. **"The change type is inferable at READY."** It is not, because at READY the
//    spec does not yet NAME the artifact. Checked against the originating
//    recurrence directly: mt#4252's spec as surfaced at its own READY transition
//    is 7,590 characters containing ZERO `/api/…` routes, ZERO `contract/`
//    references, ZERO `-shape.json`, and ZERO `docs/` paths. It says
//    "principal-channel" and "health" as bare words. A trigger able to fire there
//    would have to key on those bare words — prose, with a paraphrase axis, which
//    is the ADR-024 arms race this task's spec explicitly forbids.
//
// A READY-seam version therefore misses its own founding incident, which mt#4171's
// AT2 names as disqualifying: "a check that cannot see it is not this check."
// Measured fire rates for the same trigger at each seam:
//
//     READY seam        53 triggered / 998 recoverable  (5.3%)   — misses mt#4252
//     PR-create seam   123 triggered / 1131 calls      (10.9%)   — catches it
//
// THIS IS THE ADR'S OWN MOVE, not a departure from it. §Sibling reconciliation
// re-scoped gate (n) on exactly this reasoning — "Its mechanism reads a diff and
// its title promises the gap 'surfaces at plan time.' No diff exists at plan
// time. It moves to the `pr` seam... Its value is unchanged; its claim about WHEN
// is not." The (h) row needs the same correction, and the ADR text should be
// amended to record it rather than left contradicting a shipped guard.
//
// TWO CONSEQUENCES FOR THE SIBLINGS, both recorded in the amendment task:
//   - This row no longer pays for a `registry-status-set-guards.ts` family module
//     or for wiring the dispatcher onto `tasks_status_set`. It joins the existing
//     `registry-pr-create-guards.ts` instead, at zero wiring cost.
//   - mt#4172 (gate (p) nominator) was to INHERIT that wiring for free. It must
//     now pay it, or move seams itself.
//
// WHAT V1 DECIDES, AND WHAT IT DECLINES (SC2/SC3). It decides ONE row of gate
// (h)'s consumer table — `Config key / schema field`, the only row whose
// prescribed set includes `docs/`, and the omission every recorded incident
// shares. It declines every other change type, recorded as its OWN outcome so
// "declined to decide" is never conflated with "decided, no gap".
//
// ROW MEMBERSHIP FOLLOWS EXPOSURE, NOT DECLARATION (mt#4265, mt#4252). An
// internal-only type and a type serialized into an HTTP response produce
// identical-looking diffs; only the second one's consumers include `docs/`. The
// trigger therefore looks at WHICH FILES THE SESSION EDITED — a golden contract
// fixture, a generated manifest, a route handler — never at how the change is
// declared or described.
//
// Never denies. Calibration-first per ADR-024 and ADR-042 §Posture, which assigns
// `tuningOwnership: advisory` to the claim-provenance rows including this one.
// Override: MINSKY_SKIP_ENUMERATION_SCOPE=1.
//
// @see .minsky/hooks/evidence-provenance-table.ts — the shared discharge table (SC4)
// @see docs/architecture/hooks/enumeration-scope-check.md — mechanism + calibration
// @see ADR-042 — the seam discriminator this applies, and the row it amends
// @see mt#4215 — why a path ARGUMENT is not proof the path was searched

import { readInput } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { findToolCallsWithResults } from "./transcript";
import type { ToolCallWithResult } from "./transcript";
import { normalizeToolName, sessionSweptDirectories } from "./evidence-provenance-table";

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_ENUMERATION_SCOPE";

// ---------------------------------------------------------------------------
// What the session changed
// ---------------------------------------------------------------------------

/**
 * Tools through which a session edits a file.
 *
 * The harness-native `Edit`/`Write` are included alongside the session-scoped
 * tools because `/implement-task` permits them for MAIN-workspace files, and a
 * docs edit made that way is still a docs edit. Missing one would under-count
 * coverage, which is the false-POSITIVE direction.
 */
const EDIT_TOOL_NAMES: readonly string[] = [
  "session_write_file",
  "session_search_replace",
  "session_edit_file",
  "session_move_file",
  "session_rename_file",
  "edit",
  "write",
  "notebookedit",
];

/**
 * The input fields those tools carry a path in.
 *
 * `sourcePath`/`targetPath` (move) and `path`/`newName` (rename) are here because
 * a PATH-LEVEL change to a serialized contract is still a change to it (PR #3141
 * R1). Renaming `contract/foo.json` or moving a generated manifest alters the
 * published shape's address, and reading only `path`/`file_path` returned
 * `declined` for it — a silent coverage gap in a trigger whose whole premise is
 * "what did this session change?". Both ends of a move are read: moving a
 * contract OUT of `contract/` and moving one IN are both events this guard wants.
 */
const EDIT_PATH_FIELDS: readonly string[] = [
  "path",
  "file_path",
  "sourcePath",
  "targetPath",
  "newName",
];

/**
 * Every path written since the previous `session_pr_create`, in transcript order.
 *
 * THE WINDOW IS THE POINT, and the replay is what established it. A long
 * conversation ships several PRs — one measured session (`c1b904ea`, 2026-08-19)
 * created SEVEN, for mt#4232, mt#4227, mt#4260, mt#4267, mt#4272, mt#4275 and
 * mt#4277. Reading the whole prefix credits every edit in the conversation to
 * whichever PR is being created now, so a `contract/cockpit-health-shape.json`
 * edit belonging to an earlier task flagged mt#4232's PR ("Restart the cockpit
 * daemon by signal"), which touched no contract at all. That is a false positive
 * fired at an author who did nothing wrong — the dangerous direction.
 *
 * A PR covers the work done since the last PR, so the previous `session_pr_create`
 * is the natural boundary and needs no task→session mapping to compute.
 */
export function callsSinceLastPr(
  calls: readonly ToolCallWithResult[]
): readonly ToolCallWithResult[] {
  let start = 0;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call && normalizeToolName(call.toolName) === "session_pr_create") start = i + 1;
  }
  return calls.slice(start);
}

/** The paths written inside that window. */
export function editedPaths(calls: readonly ToolCallWithResult[]): string[] {
  const out: string[] = [];
  for (const call of callsSinceLastPr(calls)) {
    if (!EDIT_TOOL_NAMES.includes(normalizeToolName(call.toolName))) continue;
    for (const field of EDIT_PATH_FIELDS) {
      const value = call.input[field];
      if (typeof value === "string" && value !== "") out.push(value);
    }
  }
  return out;
}

/**
 * True when a path IS a serialized contract — an artifact whose whole purpose is
 * to be the published shape.
 *
 * Each is a PATH fact rather than a description, which is what keeps the trigger
 * free of a paraphrase axis. A type declared in `src/` and never serialized
 * matches none of them, which is the discrimination mt#4252 turned on.
 *
 * A ROUTE HANDLER IS DELIBERATELY NOT ONE, and the replay is why. An earlier
 * revision also matched any path with a `routes`, `api` or `handlers` segment;
 * measured over 589 transcripts that put the flag rate at 35.8% of decided
 * cases, and the fires were dominated by internal cockpit route handlers —
 * `entity-threads.ts`, `changesets.ts`, `events.ts`. Editing a route handler is
 * not evidence its RESPONSE SHAPE changed: mt#3398 in that set was a 500→503
 * status fix, which prescribes no `docs/` sweep at all. The path cannot
 * discriminate a shape change from a behavior change, so it is the wrong signal
 * and firing on it would fire hardest at ordinary route work (mem#719).
 *
 * What remains are artifacts that cannot be edited for any reason OTHER than
 * changing a published shape: a golden contract fixture, a generated manifest,
 * and the `-shape.json` convention. Narrow, and every recorded incident sits
 * inside it.
 */
export function isSerializedSurfacePath(path: string): boolean {
  // `.json` ONLY inside those directories. `contract/README.md` is prose ABOUT
  // the contract, not a published shape, and the replay caught it as a false
  // positive on the first narrowed run — editing a directory's README prescribes
  // no consumer sweep.
  const isDataFile = /\.json$/.test(path);
  return (
    (isDataFile && (path.includes("contract/") || path.includes("src/generated/"))) ||
    /-shape\.json$/.test(path)
  );
}

/**
 * Directories the `Config key / schema field` row prescribes.
 *
 * v1 CHECKS ONLY `docs`. The other four are listed because the row prescribes
 * them and a later revision will want them, but they are not asserted: `src` and
 * `tests` are swept by essentially every session (measured: `src` 92.1%), so
 * requiring them would add fires that carry no information, and `services` /
 * `.github` are legitimately irrelevant to many serialized changes. `docs` is the
 * one every recorded incident missed.
 */
export const CONFIG_KEY_ROW_DIRECTORIES: readonly string[] = [
  "src",
  "tests",
  "services",
  ".github",
  "docs",
];

/** The subset v1 actually asserts. */
export const V1_ASSERTED_DIRECTORIES: readonly string[] = ["docs"];

// ---------------------------------------------------------------------------
// Dispatcher entry point (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

export function run(input: ToolHookInput, ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  if (
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes"
  ) {
    return {
      auditLines: [
        `[enumeration-scope-check] OVERRIDE: ack=${overrideVal} session=${
          input.session_id ?? "unknown"
        } ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const base = {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? null,
    toolName: input.tool_name ?? null,
  };

  const lines = ctx.transcriptLines;
  if (!lines || lines.length === 0) {
    // Not adjudicable is `skipped`, never `clean` — a guard whose no-transcript
    // path returned a pass would report an outage as a run of correct behavior.
    return {
      calibration: { ...base, outcome: "skipped", reason: "no transcript lines available" },
    };
  }

  const calls = findToolCallsWithResults(lines);
  const edited = editedPaths(calls);
  const serialized = edited.filter(isSerializedSurfacePath);

  // SC3: a change type this v1 does not decide produces NO finding, recorded as
  // its OWN outcome so the calibration record never conflates "declined to
  // decide" with "decided, no gap".
  if (serialized.length === 0) {
    return {
      calibration: {
        ...base,
        outcome: "declined",
        reason:
          "no serialized surface among the session's edited files; v1 decides only the Config key / schema field row",
      },
    };
  }

  // A docs EDIT is stronger evidence than a docs sweep — it is the consumer
  // actually being reached, which is what gate (h) wants — so either discharges.
  //
  // Swept directories are read from the SAME window as the edits. Asymmetry here
  // would let a sweep belonging to an earlier task in the conversation discharge
  // this PR's claim — the false-negative mirror of the defect the window fixes.
  const swept = sessionSweptDirectories(callsSinceLastPr(calls));
  const editedDocs = edited.some((p) => p.includes("docs/"));
  const missing = V1_ASSERTED_DIRECTORIES.filter(
    (d) => !swept.has(d) && !(d === "docs" && editedDocs)
  );

  if (missing.length === 0) {
    return {
      calibration: {
        ...base,
        outcome: "clean",
        reason: editedDocs ? "docs edited directly" : "the sweep reached docs/",
        serializedSurfaces: [...new Set(serialized)].slice(0, 10),
      },
    };
  }

  // RECORD-ONLY. ADR-042 §Posture: every new row ships calibration-first, and a
  // provenance check joins a claim against tool calls, so a missed call shape is
  // a false positive fired at an author who did the work. That asymmetry is why
  // this does not inject on day one (mem#719).
  return {
    calibration: {
      ...base,
      outcome: "matched",
      missingDirectories: missing,
      serializedSurfaces: [...new Set(serialized)].slice(0, 10),
      swept: [...swept],
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone CLI entry point (fail-open: any error allows the call)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    // Deliberately does NOT call `run()`: the discriminating input is
    // `ctx.transcriptLines`, which only the dispatcher populates (D6), so a
    // standalone invocation could only ever reach the cannot-adjudicate branch.
    await readInput<ToolHookInput>();
    process.stderr.write(
      "[enumeration-scope-check] standalone invocation: this guard reads dispatcher-parsed " +
        "transcript lines and has nothing to check outside it. No-op.\n"
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[enumeration-scope-check] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
