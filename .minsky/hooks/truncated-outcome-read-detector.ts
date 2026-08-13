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
 *   - a read-only command truncated the same way (`git log | head -20`) — truncating a read is
 *     ordinary and firing on it would produce the unmatchable noise mem#719 records as eroding
 *     trust in a detector's true positives;
 *   - a mutating command with no pipeline at all.
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

export interface TruncatedOutcomeScanResult {
  matched: boolean;
  /** The mutating command's first stage, normalized — the calibration diversity axis. */
  mutatingCommand: string | null;
  /** Which truncator was applied (`tail` / `head`). */
  filter: string | null;
}

const CLEAN: TruncatedOutcomeScanResult = { matched: false, mutatingCommand: null, filter: null };

/** Collapse whitespace so `minsky   session\tcommit` matches the patterns above. */
function normalize(segment: string): string {
  return segment.trim().replace(/\s+/g, " ");
}

export function scanCommand(command: string): TruncatedOutcomeScanResult {
  for (const segment of splitTopLevel(command)) {
    const stages = splitPipeline(segment);
    if (stages.length < 2) continue;

    const head = normalize(stages[0] ?? "");
    if (!MUTATING_COMMAND_PATTERNS.some((re) => re.test(head))) continue;

    for (const stage of stages.slice(1)) {
      const token = leadingTokenOf(stage);
      if (TRUNCATING_FILTERS.has(token)) {
        return { matched: true, mutatingCommand: head, filter: token };
      }
    }
  }
  return CLEAN;
}

function buildWarning(result: TruncatedOutcomeScanResult): string {
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
    // The sweep's diversity axis is the SHAPE (which command, which truncator), not the raw
    // command string — a raw command is near-unique and would satisfy the distinct-phrase gate by
    // construction, rendering the sweep inert (the mt#3781 defect).
    phrase: result.matched ? `${result.mutatingCommand} | ${result.filter}` : null,
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

/** Worst-case rendering for the registry's `attentionCost` probe (mt#4002). */
export function renderWorstCase(): string {
  return buildWarning({
    matched: true,
    mutatingCommand: "minsky session pr create --task mt#0000 --body-path /tmp/x",
    filter: "tail",
  });
}
