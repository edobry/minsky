/**
 * Truncated-outcome-read detector (mt#4096).
 *
 * `CLAUDE.md §Sequence Dependent Tool Calls` requires reading a push's confirmation fields —
 * `pushed`, `pushUnconfirmed`, `pushConfirmedVia` — before reporting it done. Those fields are
 * returned (`src/adapters/shared/commands/session/workflow-commands.ts:427-428`). This detector
 * exists because a shell habit can discard them before anyone reads them.
 *
 * ## Why the existing prose control did not cover it
 *
 * `terminal-command-best-practices.mdc` bans SUPPRESSING a result you must read (`>/dev/null`).
 * The originating incident (2026-08-13) did not suppress anything — it ran
 * `minsky session commit … 2>&1 | tail -6` and reported "pushed" off the tail. The push had not
 * landed. Cost: ~20 minutes of a PR sitting unchanged, then three false diagnoses downstream of it
 * (a `build` failure read off the PR's aggregate checks, which belonged to a different commit; and
 * an apparent reviewer silence), all artifacts of the one unpushed commit.
 *
 * The asymmetry is the whole point: **suppression is conspicuous, truncation is not.** `>/dev/null`
 * leaves an empty screen you notice. A plausible six-line tail looks exactly like output you read,
 * and the field you needed is simply not among the lines — no error, nothing to notice. Same shape
 * as `claim-confidence.mdc §Absence in a derived view`, applied to your own terminal.
 *
 * ## The generalizable trigger: a mode switch that never switched back
 *
 * In the originating incident the PREVIOUS commit used `--json` and its `"pushed": true` WAS read.
 * That commit was rejected by the pre-commit lint gate, so the author switched to non-JSON plus
 * `tail` to see the failure — correct for diagnosing. After fixing the warning the re-run stayed in
 * the diagnostic mode. One command serves two sub-operations that want opposite filters —
 * DIAGNOSING (truncate toward the error) and CONFIRMING (read specific fields) — and the mode
 * carries no marker for which one you are doing. That is why this is not "remember to check": the
 * tell is in the command string.
 *
 * ## Deliberately narrow
 *
 * Fires only when a STATE-MUTATING command's own output is positionally truncated. It does NOT
 * fire on:
 *
 *   - `| grep <pattern>` or `| jq …` — a TARGETED field read is the remedy this detector wants,
 *     not the defect. `session commit --json | jq -r '.pushed'` is exactly right;
 *   - a read-only command SAMPLED the same way (`git log | head -20`) — truncating a sample is
 *     ordinary and firing on it would produce the unmatchable noise mem#719 records as eroding
 *     trust in a detector's true positives;
 *   - a mutating command with no pipeline at all.
 *
 * ## The second arm: truncating an ENUMERATION (mt#4176)
 *
 * The read-only exclusion above was originally written as "truncating a read is not the defect",
 * and that is true of a SAMPLE and false of an ENUMERATION. The line is not read-vs-mutate:
 *
 *   - `git log | head -20` is a sample. You want the recent few; the lines you did not see are
 *     not part of the question, so nothing about them can be concluded and nothing is.
 *   - `minsky mcp --help | head -15` is an enumeration. The listing exists to answer "what is the
 *     complete set?", so the lines you did not see ARE the question — truncating it manufactures
 *     an absence, and the absence is what the next claim rests on.
 *
 * Incident (2026-08-16): that exact command cut the `mcp` subcommand list mid-entry — descriptions
 * wrap, so a dozen lines hold far fewer than a dozen commands — and `proxy` and `shim` were below
 * the cut. The conclusion drawn was that both were unregistered, and it was on its way into a task
 * spec as evidence that a config migration rewrites entries to a nonexistent command. One
 * untruncated run falsified it.
 *
 * Only `--help` triggers this arm. A bare `-h` is deliberately NOT included: it is widely a value
 * flag rather than a help flag (`ls -h`, `du -h`, `sort -h` all mean human-readable), so `ls -lh |
 * head -20` is a sample and would be exactly the false positive the exclusion above exists to
 * prevent.
 *
 * Only `tail`/`head` trigger it, because positional truncation cannot be field-targeted: there is
 * no argument to `tail` that means "the push status". `grep` was in mt#4096's original spec and was
 * dropped here — see that task's `## Amendment (implementation)`.
 *
 * A heredoc body that merely CONTAINS this shape does not fire, and needs no special handling: the
 * check is on the leading command of the pipeline's FIRST stage, which for
 * `cat > f <<'EOF' … EOF` is `cat`. This is the mt#4088 hazard (heredoc bodies are matchable text)
 * avoided structurally rather than by a bespoke guard.
 *
 * ## Not governed by ADR-024
 *
 * ADR-024's ladder scopes itself to `UserPromptSubmit` guidance hooks matching behavioral trigger
 * phrases in the agent's own prose; neither axis applies to a command string. mt#4096's planning
 * audit initially concluded the opposite — that Rung 1's markdown-elision prescription answered the
 * heredoc hazard — and that was wrong: `elideMarkdownNonProse` elides markdown code spans, and a
 * shell heredoc is not markdown. Corrected at implementation; recorded in mt#4096
 * `## Amendment (implementation)`. Calibration-first shipping follows the repo-wide observer
 * convention in `hook-observers.mdc`, as its sibling `chained-verification-commands-detector`
 * already records for the same matcher class.
 */

import { CANARY_MODE_ENV } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { leadingTokenOf, splitPipeline, splitTopLevel } from "./command-shape";

const OVERRIDE_ENV = "MINSKY_SKIP_TRUNCATED_OUTCOME_READ";

/**
 * Commands whose result carries an outcome field a later claim will rest on. Matched against the
 * pipeline's first stage with whitespace collapsed, so `minsky session commit` matches regardless
 * of the flags that follow.
 *
 * Deliberately NOT every mutating command — only those whose confirmation is both (a) load-bearing
 * for a claim the agent then makes to the principal, and (b) known to be reportable as ambiguous
 * (`pushed: false, pushUnconfirmed: true`), which is what makes reading the field non-optional.
 */
const MUTATING_COMMAND_PATTERNS: readonly RegExp[] = [
  /^minsky\s+(session|sess)\s+commit\b/,
  /^minsky\s+(session|sess)\s+update\b/,
  /^minsky\s+(session|sess)\s+pr\s+(create|merge)\b/,
  /^minsky\s+git\s+push\b/,
  /^git\s+push\b/,
];

/** Positional truncators. `grep`/`jq` are deliberately absent — they are field reads. */
const TRUNCATING_FILTERS = new Set(["tail", "head"]);

/**
 * An enumeration request: the stage's purpose is to render a COMPLETE set, so the lines a
 * truncator drops are the question rather than surplus. `--help` only — see the docblock for why
 * a bare `-h` is excluded.
 */
const ENUMERATION_FLAG = /(?:^|\s)--help(?:\s|$)/;

/** Which arm fired — they warn about different things. */
export type TruncationKind = "outcome" | "enumeration";

export interface TruncatedOutcomeScanResult {
  matched: boolean;
  /**
   * The truncated command's first stage, normalized — part of the calibration diversity axis.
   *
   * The name predates the enumeration arm and no longer describes every value it holds (an
   * enumeration match stores a non-mutating command). Kept anyway: it is a RECORD-SHAPE key, not
   * just a local field — `calibration-sweep.ts` reads `detectorFields["mutatingCommand"]` by name
   * and guards on it, with a dedicated shape test, and fire-log records already on disk use it.
   * Renaming would drop every historical record out of the sweep's diversity axis for a naming
   * win. Flagged NON-BLOCKING on PR #3024 R1; declined with this reasoning rather than silently.
   */
  mutatingCommand: string | null;
  /** Which truncator was applied (`tail` / `head`). */
  filter: string | null;
  /** Which arm matched; null when clean. */
  kind: TruncationKind | null;
}

const CLEAN: TruncatedOutcomeScanResult = {
  matched: false,
  mutatingCommand: null,
  filter: null,
  kind: null,
};

/** Collapse whitespace so `minsky   session\tcommit` matches the patterns above. */
function normalize(segment: string): string {
  return segment.trim().replace(/\s+/g, " ");
}

export function scanCommand(command: string): TruncatedOutcomeScanResult {
  for (const segment of splitTopLevel(command)) {
    const stages = splitPipeline(segment);
    if (stages.length < 2) continue;

    const head = normalize(stages[0] ?? "");
    // Outcome takes precedence: a mutating command carrying `--help` is not a real invocation,
    // but if one ever matched both, the discarded confirmation fields are the costlier warning.
    const kind: TruncationKind | null = MUTATING_COMMAND_PATTERNS.some((re) => re.test(head))
      ? "outcome"
      : ENUMERATION_FLAG.test(head)
        ? "enumeration"
        : null;
    if (!kind) continue;

    for (const stage of stages.slice(1)) {
      const token = leadingTokenOf(stage);
      if (TRUNCATING_FILTERS.has(token)) {
        return { matched: true, mutatingCommand: head, filter: token, kind };
      }
    }
  }
  return CLEAN;
}

function buildWarning(result: TruncatedOutcomeScanResult): string {
  if (result.kind === "enumeration") {
    return (
      `This pipes \`${result.mutatingCommand}\` through \`${result.filter}\`. A \`--help\` listing ` +
      `answers "what is the complete set?", so the lines dropped by position are the question — ` +
      `truncating it manufactures an absence, and a short listing looks exactly like a complete ` +
      `one. Read it untruncated, or target the entry (\`| grep <name>\`). (mt#4176)`
    );
  }
  return (
    `This pipes \`${result.mutatingCommand}\` through \`${result.filter}\`, which discards the ` +
    `outcome fields by position. \`pushed\`, \`pushUnconfirmed\` and \`pushConfirmedVia\` are what ` +
    `CLAUDE.md §Sequence Dependent Tool Calls requires you to read before reporting the result — ` +
    `and a truncated run looks exactly like one you read, so their absence produces no error to ` +
    `notice. Re-run with \`--json\` and read the field (\`| jq -r '.pushed, .pushUnconfirmed'\`), ` +
    `or read the untruncated output. (mt#4096)`
  );
}

function isOverridden(): boolean {
  return process.env[OVERRIDE_ENV] === "1";
}

export async function run(
  input: ToolHookInput,
  _ctx: DispatchContext
): Promise<GuardOutcome | null> {
  if (isOverridden()) return null;

  const toolInput = input.tool_input ?? {};
  const command = typeof toolInput["command"] === "string" ? (toolInput["command"] as string) : "";
  if (!command) return null;

  const result = scanCommand(command);

  const base = {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? null,
    toolName: input.tool_name ?? null,
    mutatingCommand: result.mutatingCommand,
    filter: result.filter,
    kind: result.kind,
    // The sweep's diversity axis is the SHAPE (which command, which truncator), not the raw
    // command string — a raw command is near-unique and would satisfy the distinct-phrase gate by
    // construction, rendering the sweep inert (the mt#3781 defect).
    //
    // `phrase` is NOT what the sweep reads for this detector. `calibration-sweep.ts` has a
    // dedicated branch that rebuilds the axis from `detectorFields` (`kind|mutatingCommand|filter`)
    // because the record is matches-shaped and carries no `matches`. So the arm separation lives
    // in `kind` above, reaching the sweep through the mt#3289 passthrough — this field is a
    // human-readable echo for anyone reading the raw log.
    phrase: result.matched ? `${result.kind}: ${result.mutatingCommand} | ${result.filter}` : null,
  };

  // The scan is pure over its input, so canary mode runs it identically. Recorded so a future
  // reader does not add a DB dependency and silently change that.
  if (process.env[CANARY_MODE_ENV] === "1" && !result.matched) {
    return { calibration: { ...base, outcome: "clean" } };
  }

  if (!result.matched) {
    return { calibration: { ...base, outcome: "clean" } };
  }

  return {
    additionalContext: buildWarning(result),
    calibration: { ...base, outcome: "matched" },
  };
}

/**
 * Worst-case rendering for the registry's `attentionCost` probe (mt#4002).
 *
 * Posed on the `outcome` arm deliberately: with the same command interpolated, its body is the
 * longer of the two — measured 508 vs 352 chars on 2026-08-16 — so adding the enumeration arm
 * does not move this guard's ceiling. The command string is the only unbounded axis, which is why
 * `guard-feedback-shape.test.ts` classifies this probe a saturated SAMPLE rather than a proved
 * ceiling; that was already true before the second arm.
 */
export function renderWorstCase(): string {
  return buildWarning({
    matched: true,
    mutatingCommand: "minsky session pr create --task mt#0000 --body-path /tmp/x",
    filter: "tail",
    kind: "outcome",
  });
}
