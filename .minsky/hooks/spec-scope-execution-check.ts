#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// spec-scope-execution-check (mt#4544) — did the PR execute the enumeration the
// spec already wrote?
//
// `/plan-task` gate (h) makes an author enumerate the consumers of a contract
// before changing it, and the enumeration lands in the spec's `## Scope` →
// in-scope list. NOTHING COMPARED THAT LIST AGAINST WHAT THE PR ACTUALLY
// CHANGED. So an enumeration could be complete, correct, recorded — and
// partially executed, with no signal.
//
// Originating instance (mt#4531 / PR #3310): the spec named
// `docs/architecture/guard-calibration-stream-inventory.md` explicitly — "row
// 119 documents the calibration record's field set; update if SC3's measurement
// adds fields to it." The implementation added three fields to that record and
// never touched the doc. Every local gate passed, because none of them reads the
// spec. `minsky-reviewer[bot]` caught it as BLOCKING on R2 — one full round
// late, and by RE-DERIVING the doc impact rather than by reading the
// enumeration the author had already written. The author's own list is the
// cheapest available oracle and it was write-only.
//
// WHY THIS IS A SIBLING OF `enumeration-scope-check` AND NOT PART OF IT. That
// guard asks whether the SWEEP THE AUTHOR RAN covered the directories gate (h)
// prescribes — a transcript join over sweep-call arguments, which is the row
// ADR-042's table assigns to gate (h). This one asks whether the FILE LIST THE
// SPEC NAMED was touched. Same family, same seam, different join: ADR-042's
// table has no row for `in-scope paths ∩ changed files`, and the ADR is amended
// by this task to record it.
//
// SEAM: `session_pr_create`, decided from ADR-042 rather than re-derived. Its
// §Sibling reconciliation records mt#4171's re-scope from `ready` to `pr`
// (mt#4293) with measured per-seam rates, and notes that joining the existing
// `registry-pr-create-guards.ts` family costs zero additional wiring. Both of
// mt#4544's original candidates (pr-create, merge gate) are post-diff, so that
// analysis does not decide between them — but the family, the registry and the
// wiring cost all point here, and the merge gate's only advantage (a complete
// file list rather than this session's edits) is left to be measured against
// that cost rather than assumed.
//
// POSTURE: recorder only, `advisory`, per ADR-042 §Posture — every new row ships
// calibration-first under ADR-024's ladder. The reason is specific rather than
// ritual, and it is this check's DOMINANT false-positive source: an enumeration
// line is frequently CONDITIONAL ("update **if** SC3 adds fields"), and whether
// the condition fired is a judgment a path comparison cannot make.
// ---------------------------------------------------------------------------

import { findToolCallsWithResults } from "./transcript";
import type { DispatchContext, GuardOutcome } from "./registry";
import type { ToolHookInput } from "./types";
import { editedPaths } from "./enumeration-scope-check";
import { extractInScopeFiles, fetchTaskSpec } from "./parallel-work-guard";

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_SPEC_SCOPE_EXECUTION";

/**
 * Injected seams, so the guard is hermetically testable without the CLI
 * (`custom/no-real-fs-in-tests`; `/implement-task` §6 testable-design
 * checkpoint — these are handed in, not reached for).
 */
export interface SpecScopeDeps {
  /** Defaults to the real `minsky tasks spec get` shell-out. */
  fetchSpec?: (taskId: string) => string | null;
}

/**
 * The bound task id, read off the `session_pr_create` call.
 *
 * `session_pr_create` accepts `task` or `sessionId`; only the first names a task
 * directly. When the call carries only a session id the guard records `skipped`
 * rather than guessing — resolving session→task would need a DB round trip this
 * seam deliberately avoids, and a wrong task id would compare a real diff
 * against someone else's enumeration.
 */
export function boundTaskId(toolInput: Record<string, unknown>): string | null {
  const task = toolInput["task"];
  return typeof task === "string" && task.trim() !== "" ? task.trim() : null;
}

/**
 * Normalize a path for comparison: strip surrounding whitespace, a leading
 * `./`, and any trailing slashes. That is ALL it does.
 *
 * **It does NOT strip an absolute workspace prefix (PR #3340 R1).** An earlier
 * revision of this comment said it did, which was false — the absolute-vs-
 * relative reconciliation lives in {@link pathIsCovered}'s suffix rule, not
 * here. Recording the correction rather than quietly rewording it, because a
 * comment describing a normalization the function does not perform is exactly
 * the kind of claim a caller would rely on without re-reading the body.
 *
 * The suffix rule over in `pathIsCovered` is deliberate rather than lazy. Edit
 * tool calls record whatever path the caller passed — repo-relative for the
 * session-scoped tools, absolute for the harness-native ones — and the spec
 * always writes repo-relative. Comparing on the repo-relative TAIL is the only
 * rule that matches across both without knowing the workspace root.
 */
export function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * A path segment carrying a glob metacharacter.
 *
 * `*` and `?` ONLY — `[` and `]` are deliberately EXCLUDED (PR #3351 R1). They
 * are legal literal filename characters, and a Next.js-style `[id].tsx` route
 * is the ordinary case; treating them as glob syntax would route a path like
 * `docs/Guide [Draft]/index.md` down the glob branch. No spec in the measured
 * corpus uses a character-class glob, so excluding them costs nothing and
 * removes the misclassification rather than heuristically working around it.
 * `globToRegExp` escapes them as literals.
 */
const GLOB_CHARS = /[*?]/;

/**
 * Strip a trailing line reference from an ENUMERATED path (mt#4591).
 *
 * Specs cite a file at a location constantly — `types.ts:83`,
 * `start-session-operations.ts:229-230`, `asks.ts:2426-2432`,
 * `session-approve-legacy-operations.ts:66,326` — while a changed-file list,
 * from the forge or from a transcript edit call, never carries one. Comparing
 * the two literally reports the file as untouched no matter what the PR did.
 *
 * Measured over the 100 most recently merged PRs: 12 of 32 flagged entries
 * carried a line reference or a glob. Four were checked against the forge's own
 * file list and every one of those files HAD been changed — PR #3342
 * (`types.ts:83` and 8 siblings), #3272 (`asks.ts:2426-2432`), #3265
 * (`start-command.ts:617-636`), #3267 (a `src/cockpit` glob, 39 files beneath).
 *
 * Applied to the ENUMERATED side ONLY, deliberately. A changed-file path is
 * ground truth and is compared verbatim; stripping it too would let a spec
 * naming `a.ts` be satisfied by an edit to a file genuinely named `a.ts:83`.
 * The asymmetry is asserted by a test rather than left to this comment.
 *
 * NOT reused from `duplicate-signature-tokens.ts`, which has a same-named
 * helper: measured this session, that module's only call site feeds it
 * `PATH_RE` matches, and `PATH_RE` terminates at the file extension — so its
 * copy is a no-op on every input it can receive. Joining a primitive that runs
 * on nothing is not reuse.
 */
function stripLineSuffix(path: string): string {
  // Optional whitespace around the separators (PR #3351 R1): specs are
  // hand-written, so `a.ts:66, 326` and `a.ts:2426 - 2432` occur alongside the
  // compact forms.
  //
  // POSIX / repo-relative paths are assumed. The pattern is anchored at `$` and
  // requires DIGITS after the colon, so a Windows drive letter (`C:\repo\a.ts`)
  // cannot be mis-stripped — asserted by a test rather than left to this note.
  // A POSIX filename ending literally in `:<digits>` would be mis-stripped; no
  // such file exists in this repo and none is expected.
  return path.replace(/:\d+(?:\s*[-,:]\s*\d+)*$/, "");
}

/**
 * Compile a glob entry into an anchored matcher, or `null` when `target`
 * carries no glob metacharacter.
 *
 * Supported syntax, which is what in-scope lists actually use:
 *   - `**\/` — zero or more directories
 *   - a trailing `**` — anything beneath
 *   - `*` — within a single segment
 *   - `?` — exactly one character
 * Everything else is escaped and matched LITERALLY.
 *
 * Anchored with `(?:^|/)` … `$`, mirroring the non-glob branch's suffix rule,
 * so a repo-relative glob still matches an ABSOLUTE edit path.
 *
 * **PR #3351 R1 (BLOCKING) replaced a literal-prefix implementation here.**
 * That version reduced every glob to its literal directory prefix and treated
 * any change beneath it as coverage — so `src/**\/x.ts` was satisfied by ANY
 * edit under `src/`, and `src/*-gen/*.ts` by any edit under `src/`. That is a
 * silent FALSE PASS: it hides exactly the unkept promise this check exists to
 * surface, which makes it strictly worse than the false FLAG the task set out
 * to remove. Prefix matching is only ever correct for the `dir/**` shape; it is
 * wrong for every narrower one, and nothing in the type or the tests
 * distinguished the two.
 */
function globToRegExp(target: string): RegExp | null {
  if (!GLOB_CHARS.test(target)) return null;
  let out = "";
  for (let i = 0; i < target.length; i++) {
    const ch = target[i] ?? "";
    if (ch === "*") {
      if (target[i + 1] === "*") {
        if (target[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  return new RegExp(`(?:^|/)${out}$`);
}

/**
 * True when `edited` covers `enumerated`.
 *
 * Covers five shapes an enumeration uses in practice:
 *   - an exact file path
 *   - a DIRECTORY (`.minsky/hooks/`), satisfied by any edit beneath it
 *   - a repo-relative path against an ABSOLUTE edit path (suffix match)
 *   - a path carrying a LINE REFERENCE (`types.ts:83`, `asks.ts:2426-2432`)
 *   - a GLOB with a literal directory prefix
 *
 * The suffix match is anchored at a path separator so `hooks/registry.ts` is
 * not satisfied by an edit to `other-hooks/registry.ts`.
 */
export function pathIsCovered(enumerated: string, edited: readonly string[]): boolean {
  const target = stripLineSuffix(normalizePath(enumerated));
  if (target === "") return false;

  const globMatcher = globToRegExp(target);
  if (globMatcher !== null) {
    for (const raw of edited) {
      if (globMatcher.test(normalizePath(raw))) return true;
    }
    return false;
  }

  for (const raw of edited) {
    const candidate = normalizePath(raw);
    if (candidate === target) return true;
    if (candidate.endsWith(`/${target}`)) return true;
    // Directory enumeration: any edit beneath it counts.
    if (candidate.startsWith(`${target}/`)) return true;
    if (candidate.includes(`/${target}/`)) return true;
  }
  return false;
}

/**
 * The IN-SCOPE line that named `path`, for quoting back at the author.
 *
 * SC3 asks for the author's OWN words rather than a generic nag, and the line
 * is where the CONDITION lives ("update **if** SC3 adds fields") — which is
 * precisely the information a reader needs to dismiss a conditional-enumeration
 * false positive in one glance instead of re-reading the spec.
 *
 * **Searches the in-scope BLOCK, not the whole spec (PR #3340 R1, BLOCKING).**
 * An earlier revision scanned the entire document and returned the FIRST line
 * containing the path. For any path the spec ALSO cites — in `## Context` as
 * prior art, or under `Out of scope` — that first line is the wrong one, and
 * quoting an out-of-scope line as though it were an in-scope promise inverts
 * the finding's meaning. It is not a cosmetic slip: the qualifier tune this
 * check's own follow-up (mt#4582) will run reads exactly this line, so a wrong
 * line would silently mis-suppress.
 *
 * Falls back to `null` rather than to a whole-document scan when no block is
 * available — a missing quote is a smaller failure than a misattributed one.
 */
/**
 * Is `line` a CONTINUATION of the bullet above it?
 *
 * A continuation is INDENTED and opens nothing of its own. Every clause below is
 * a stop, and the indentation requirement is the load-bearing one (PR #3360 R1):
 * without it the joiner absorbed any non-empty, non-`-`/`*` line, so an
 * unindented paragraph, an ordered-list item or a heading following the block's
 * last bullet was swallowed into that entry. Two consequences, and the second is
 * the serious one: the calibration record quotes text the author never wrote
 * about this path, and a qualifier-like phrase in that absorbed text can
 * SUPPRESS A REAL FINDING.
 */
function isBulletContinuation(line: string): boolean {
  if (line.trim() === "") return false;
  // Must be indented — an unindented line starts something new, whatever it is.
  if (!/^\s+\S/.test(line)) return false;
  if (/^\s*[-*+]\s/.test(line)) return false; // a nested or sibling bullet
  if (/^\s*\d+[.)]\s/.test(line)) return false; // an ordered-list item
  if (/^\s*#{1,6}\s/.test(line)) return false; // a heading
  if (/^\s*(?:[-=*_]\s*){3,}$/.test(line)) return false; // a thematic break
  return true;
}

export function enumerationLineFor(inScopeBlock: string | undefined, path: string): string | null {
  if (!inScopeBlock) return null;
  const target = normalizePath(path);
  const lines = inScopeBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes(target)) continue;
    // Join the bullet's CONTINUATION lines (mt#4582 SC7). A continuation is
    // indented, non-empty, and does not open a new `-`/`*` bullet.
    const parts = [line.trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (!isBulletContinuation(next)) break;
      parts.push(next.trim());
    }
    return parts.join(" ");
  }
  return null;
}

/**
 * Phrases by which an author marks an in-scope entry as UNCONDITIONALLY exempt.
 *
 * Derived from measurement, not invented: over the 100 most recently merged PRs
 * (post-mt#4591, 20 untouched entries) these four forms account for all 5
 * qualifier instances — `READ-ONLY` x2, `only insofar as` x2,
 * `only to the extent of` x1. Two independent 100-PR windows yielded the same
 * closed set, which is why the sample was not widened further (SC2).
 *
 * **A CONDITIONAL is deliberately NOT here (SC5).** `update if the signature
 * changes` reads like a qualifier and is not one: whether the condition FIRED is
 * exactly what a path comparison cannot evaluate, so the honest answer is to
 * keep flagging it. This is not a conservative default — it is load-bearing.
 * Both surviving flagged entries on PR #3310 / mt#4531, the check's founding
 * incident, are conditionals, so an `if` rule would silence the one case the
 * check exists for and turn AT3 into a guaranteed failure.
 *
 * Rung 1 per ADR-024: fixed phrases over text the check already holds, no
 * paraphrase axis, no learned stage.
 */
export const QUALIFIER_PATTERNS: readonly RegExp[] = [
  // HYPHENATED only (PR #3360 R1). A bare `read only` appears in ordinary prose
  // — "a read only reference for the fields" — and matching it would suppress a
  // real finding on an incidental mention. Both measured instances in the
  // corpus are hyphenated (`READ-ONLY:` and `READ-ONLY.`), so requiring the
  // hyphen costs no coverage and removes the whole ambiguity.
  /\bREAD-ONLY\b/i,
  /\bonly insofar as\b/i,
  /\bonly to the extent of\b/i,
  /\bno behaviou?r change\b/i,
];

/**
 * True when the author's own enumeration entry marks the path unconditionally
 * exempt.
 *
 * A `null` entry is NEVER qualified (SC6): `inScopeBlock` is absent on
 * `extractInScopeFiles`'s `## Scope Constraints` early return, and a missing
 * quote is "no evidence", not "no qualifier". Suppressing on absent evidence is
 * the one direction that hides a real unkept promise.
 */
export function isQualifiedEntry(entry: string | null): boolean {
  if (entry === null) return false;
  return QUALIFIER_PATTERNS.some((pattern) => pattern.test(entry));
}

export interface UntouchedPath {
  path: string;
  line: string | null;
}

export interface UntouchedResult {
  /** Entries the PR did not touch AND the spec did not exempt. */
  untouched: UntouchedPath[];
  /** How many untouched entries were suppressed as qualified — recorded, never silent (SC1). */
  qualified: number;
}

/**
 * The comparison, as a pure function over its two inputs.
 *
 * Extracted rather than left inline so the whole decision is observable from a
 * return value — no collaborator to patch to see what it decided.
 */
export function untouchedEnumeratedPaths(
  inScopeBlock: string | undefined,
  enumerated: readonly string[],
  edited: readonly string[]
): UntouchedResult {
  const untouched: UntouchedPath[] = [];
  let qualified = 0;
  for (const path of enumerated) {
    if (pathIsCovered(path, edited)) continue;
    const line = enumerationLineFor(inScopeBlock, path);
    // The author already said this one might not be touched (mt#4582).
    if (isQualifiedEntry(line)) {
      qualified++;
      continue;
    }
    untouched.push({ path, line });
  }
  return { untouched, qualified };
}

export function run(
  input: ToolHookInput,
  ctx: DispatchContext,
  deps: SpecScopeDeps = {}
): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  if (
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes"
  ) {
    return {
      auditLines: [
        `[spec-scope-execution-check] OVERRIDE: ack=${overrideVal} session=${
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

  const taskId = boundTaskId(input.tool_input ?? {});
  if (!taskId) {
    return {
      calibration: {
        ...base,
        outcome: "skipped",
        reason: "session_pr_create carried no `task` parameter — no spec to compare against",
      },
    };
  }

  const fetchSpec = deps.fetchSpec ?? fetchTaskSpec;
  const specContent = fetchSpec(taskId);
  if (!specContent) {
    return {
      calibration: {
        ...base,
        outcome: "skipped",
        reason: `could not fetch spec for ${taskId}`,
        taskId,
      },
    };
  }

  // STRICT: no fallback chain. See `ExtractInScopeFilesOptions` — a whole-spec
  // backtick scan collects paths the spec merely MENTIONS, and every one would
  // be reported here as an unkept promise.
  const { files: enumerated, inScopeBlock } = extractInScopeFiles(specContent, { strict: true });

  if (enumerated.length === 0) {
    // SC5: "nothing to compare" is NOT a clean pass. A zero from an unparseable
    // section and a zero from a fully-executed enumeration are different
    // findings, and collapsing them is how a check reports coverage it does not
    // have.
    return {
      calibration: {
        ...base,
        outcome: "skipped",
        reason:
          "spec has no parseable in-scope path list (no '**In scope:**' block or " +
          "'### In scope' heading carrying paths) — nothing to compare",
        taskId,
      },
    };
  }

  const calls = findToolCallsWithResults(lines);
  const edited = editedPaths(calls);
  if (edited.length === 0) {
    return {
      calibration: {
        ...base,
        outcome: "skipped",
        reason: "no edit calls recorded since the last session_pr_create",
        taskId,
        enumeratedCount: enumerated.length,
      },
    };
  }

  const { untouched, qualified } = untouchedEnumeratedPaths(inScopeBlock, enumerated, edited);

  if (untouched.length === 0) {
    return {
      calibration: {
        ...base,
        outcome: "clean",
        taskId,
        enumeratedCount: enumerated.length,
        editedCount: edited.length,
        // Carried on the CLEAN record too (mt#4582 SC1). A spec whose every
        // untouched entry was suppressed as qualified would otherwise be
        // byte-identical to one the PR fully executed — which is exactly the
        // "dropped without a trace" case the criterion forbids.
        qualified,
      },
    };
  }

  return {
    calibration: {
      ...base,
      outcome: "flagged",
      taskId,
      enumeratedCount: enumerated.length,
      editedCount: edited.length,
      // How many untouched entries the author's own wording exempted (mt#4582).
      qualified,
      // SC3's content lives HERE rather than in injected text: the path plus
      // the spec's own ENTRY that named it — the bullet including its
      // continuation lines, not just the first physical line (mt#4582 SC7),
      // because this repo wraps at 100 chars and half of all flagged bullets
      // wrap. A calibration reader sees the author's words and — critically —
      // whether the entry was CONDITIONAL, which is what distinguishes a real
      // finding from this check's dominant remaining false positive.
      untouched: untouched.map((u) => ({ path: u.path, line: u.line })),
    },
    // RECORD-ONLY for v1, matching the sibling `enumeration-scope-check`
    // exactly ("no injected text today, so the frame is the calibration record
    // rather than a rendered message"). ADR-042 §Posture puts every new
    // claim-provenance row at calibration-first, and injecting before the
    // false-positive rate is measured is what trains a reader to skip the
    // output (mem#719). SC6's measurement is the gate on adding injection.
  };
}
