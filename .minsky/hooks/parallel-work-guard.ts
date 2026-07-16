#!/usr/bin/env bun
// PreToolUse hook: block mcp__minsky__session_start — or mcp__minsky__tasks_dispatch in
// existing-task mode (a `taskId` param present, mt#2657 R3 fix) — when parallel work is
// detected.
//
// Rationale: Starting a new session while another UNMERGED open PR touches the same
// files produces silent merge conflicts and duplicated effort. This hook enforces the
// parallel-work check that mt#1305 added to the /plan-task and /implement-task skills —
// but structurally, at the tool call boundary, so it fires regardless of which skill
// (or no skill) led to session_start.
//
// mt#2657 note: `tasks_dispatch` in existing-task mode calls `SessionService.start()`
// IN-PROCESS — the same session-bind action `session_start` performs as a top-level tool
// call. Guarding `tasks_dispatch` directly (scoped to existing-task mode via
// `resolveSessionStartLikeTaskId`) is how the one-call dispatch path composes this open-PR
// sweep rather than silently bypassing it, mirroring `check-task-spec-read.ts`'s
// DISPATCH_TOOL approach for the bind/advance spec-read guard. New-task mode (`title`, no
// `taskId`) is not covered by this sweep — nothing pre-existing to collide with — but it
// IS covered by the duplicate-child matcher (mt#2683): new-task mode creates the subtask
// in-process, so no top-level `tasks_create` call ever fires, and the matcher must run on
// the dispatch call itself when `parentTaskId` is present.
//
// Two checks are run:
//   A. Open-PR sweep (BLOCKING): any open PR whose changed files overlap the task's
//      in-scope paths. This is the genuine merge-conflict signal.
//   B. Recently-merged sweep (ADVISORY — mt#2337): any commit on the default branch in
//      the last 24h touching in-scope paths. `session_start` clones the remote fresh
//      every time, so the new branch ALWAYS includes these commits — they CANNOT
//      conflict. Surfaced as a warning ("review recent changes to avoid duplicate
//      work"), not a block. (Stale-base hazards are caught separately by
//      check-branch-fresh.ts at commit/PR time.)
//
// On open-PR hit: BLOCK with structured message listing the colliding PR.
// On recently-merged hit: WARN (non-blocking advisory).
// On miss: permit.
// Override: MINSKY_FORCE_PARALLEL=1 env var bypasses with audit log.
//
// @see mt#1362 — Tier-3 structural ceiling for the parallel-work guard ladder
// @see mt#1305 — Tier-2 skill-step enforcement (floor)
// @see feedback_check_parallel_work_before_decomposing — four-incident history

import { readInput, writeOutput, execWithPath } from "./types";
import type { ToolHookInput } from "./types";
import { checkOverride } from "./dispatcher";
import type { OverrideResult } from "./dispatcher";
import { GUARD_REGISTRY } from "./registry";

// NOTE: execWithPath is centralized in types.ts and imported above.
// This avoids duplicating the PATH-augmentation logic across hooks.
// See NON-BLOCKING #5 from PR #909 round 1 review.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParallelWorkCollision {
  type: "open-pr" | "recently-merged";
  prNumber?: number;
  prTitle?: string;
  commitSha?: string;
  commitMessage?: string;
  overlappingFiles: string[];
}

export interface ParallelWorkCheckInput {
  taskId: string;
  inScopeFiles: string[];
  repo: string;
  lookbackHours: number;
}

export interface ParallelWorkCheckResult {
  blocked: boolean;
  collisions: ParallelWorkCollision[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `## Scope Constraints` section that `session_generate_prompt`'s
 * `renderScopeSection` (packages/domain/src/session/prompt-generation.ts)
 * renders into a subagent prompt: a bare bullet list of (typically absolute)
 * file paths under "Only modify the following files:" — NO bold "In scope:"
 * marker, unlike the task-spec format below. mt#2811 added this parser and
 * binds it to that render function via a contract test
 * (parallel-work-guard.test.ts) so future drift in either side fails loudly
 * in CI instead of silently at guard-fire time.
 *
 * Returns `[]` (not an error) when the heading isn't present — this lets
 * `extractInScopeFiles` try this format first, unconditionally, since a
 * task-spec's own "## Scope" section never collides with this heading text.
 */
export function extractScopeConstraintsFiles(content: string): string[] {
  const headingMatch = content.match(/^##\s+Scope Constraints\s*$/m);
  if (!headingMatch || headingMatch.index === undefined) return [];

  const start = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(start);
  const nextHeadingMatch = rest.match(/^##\s+/m);
  const end =
    nextHeadingMatch !== null && nextHeadingMatch.index !== undefined
      ? nextHeadingMatch.index
      : rest.length;
  const section = rest.slice(0, end);

  const files: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch && bulletMatch[1]) {
      const path = bulletMatch[1].trim();
      if (path.length > 0) files.push(path);
    }
  }
  return files;
}

/**
 * Extract backtick-wrapped path-like tokens (containing `/` or starting with
 * `.`) from anywhere in `content`. mt#2811 fallback-extraction primitive: the
 * CURRENT `/create-task` spec convention (`.claude/skills/create-task/SKILL.md`,
 * compiled from `.minsky/skills/create-task/SKILL.md`) writes `**In scope:**`
 * as a PROSE sentence describing scope AREAS — e.g. "extractor + enumeration
 * fixes, parser<->prompt-format contract test" — never a bullet list of
 * literal file paths. Every real task spec inspected during mt#2811's
 * root-cause investigation (this task's own spec, mt#2766's spec, and the
 * `/create-task` skill's own worked example) confirms this. Concrete file
 * references, when present, are backtick-wrapped and conventionally live in
 * the `## Context` section (the skill's own guidance: "Context: ... Link to
 * ... code paths"). Requiring `/` or a leading `.` filters out non-path
 * backtick content (code identifiers, command names) the same way the
 * original bullet-list extractor already did.
 */
function extractBacktickPaths(content: string): string[] {
  const files: string[] = [];
  const backtickRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickRe.exec(content)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw.length === 0) continue;
    // mt#2811 R1 (PR #1953 review, NON-BLOCKING #4): exclude URLs
    // (`https://...`) and CLI-flag-shaped tokens (`--foo/bar`) — both
    // contain `/` but are not file-path references. A URL's `://` never
    // appears in a real repo-relative path; a leading `-` never starts one
    // either (paths in this repo are relative or absolute, never flag-shaped).
    if (raw.includes("://") || raw.startsWith("-")) continue;
    if (raw.includes("/") || raw.startsWith(".")) {
      const cleaned = raw.replace(/[),.;:]+$/, "");
      if (cleaned.length > 0 && !files.includes(cleaned)) {
        files.push(cleaned);
      }
    }
  }
  return files;
}

/**
 * Slice out the content of a `## <headingName>` section (up to the next `##`
 * heading or end of document). Returns `null` when the heading isn't found.
 */
/**
 * Escape RegExp metacharacters in `s` so it can be safely interpolated into
 * a `new RegExp(...)` template as a LITERAL substring match. Only the
 * current call site passes a fixed literal ("Context"), but escaping makes
 * `extractNamedSection` safe for any future heading name (PR #1953 review
 * 4708851338 R2 nit).
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNamedSection(specContent: string, headingName: string): string | null {
  const headingRe = new RegExp(`^##\\s+${escapeRegex(headingName)}:?\\s*$`, "m");
  const match = specContent.match(headingRe);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const rest = specContent.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const end =
    nextHeading !== null && nextHeading.index !== undefined ? nextHeading.index : rest.length;
  return rest.slice(0, end);
}

/**
 * mt#2811 fallback chain, invoked when the strict `**In scope:**` bullet-list
 * extraction (the original mt#1362 format) finds nothing. Tries, in order:
 *   1. Backtick-wrapped paths in the spec's `## Context` section — the
 *      current `/create-task` convention's home for concrete file references.
 *   2. Backtick-wrapped paths anywhere in the whole spec (last resort, for
 *      specs that mention files inline without a dedicated Context section).
 * When NEITHER strategy finds anything, appends a LOUD, SPECIFIC terminal
 * warning naming every strategy that was tried (mt#2811 success criterion
 * #3) — the caller (the hook entrypoint) writes this to stderr so it reads
 * as a guard degradation, not routine info.
 */
function extractWithFallback(
  specContent: string,
  priorWarnings: string[]
): { files: string[]; warnings: string[] } {
  const contextSection = extractNamedSection(specContent, "Context");
  if (contextSection) {
    const contextFiles = extractBacktickPaths(contextSection);
    if (contextFiles.length > 0) {
      return {
        files: contextFiles,
        warnings: [
          ...priorWarnings,
          `Fell back to '## Context' backtick-path scan (the current /create-task convention ` +
            `writes '**In scope:**' as prose, not a file-path bullet list) — found ${contextFiles.length} path(s)`,
        ],
      };
    }
  }

  const wholeDocFiles = extractBacktickPaths(specContent);
  if (wholeDocFiles.length > 0) {
    return {
      files: wholeDocFiles,
      warnings: [
        ...priorWarnings,
        `'## Context' had no backtick paths — fell back to a whole-spec backtick-path scan, ` +
          `found ${wholeDocFiles.length} path(s)`,
      ],
    };
  }

  return {
    files: [],
    warnings: [
      ...priorWarnings,
      `No extractable file references found anywhere in the spec (checked '**In scope:**' ` +
        `bullet list, '## Context' section, and a whole-document backtick scan) — the ` +
        `parallel-work file-overlap check is SKIPPED for this dispatch; open-PR and ` +
        `recently-merged collisions on this task's files will NOT be detected`,
    ],
  };
}

export interface ExtractInScopeFilesResult {
  files: string[];
  warnings: string[];
  /**
   * mt#2811 R1 (PR #1953 review 4708851338, BLOCKING #3): true iff the
   * extractor located a parseable `**In scope:**` bullet-list block but
   * extracted ZERO file paths from it — a genuine extraction FAILURE (the
   * original mt#2811 incident class: "Could not extract file paths from
   * '**In scope:**' block"), AND the fallback chain (Context section /
   * whole-doc backtick scan) ALSO found nothing.
   *
   * `false`/`undefined` for the ROUTINE "no scope structure present at all"
   * cases — no `## Scope` section, or a `## Scope` section with no
   * `**In scope:**` sub-block — since those are not parser failures, just
   * specs with nothing to check (the guard has always tolerated this
   * gracefully; it is NOT the mt#2811 regression class).
   *
   * Consumed by the hook entrypoint (`resolveInScopeFiles` /
   * `import.meta.main`) to route ONLY genuine failures to stderr
   * ("GUARD DEGRADED"); routine no-scope-anywhere cases stay on stdout,
   * matching pre-mt#2811 behavior.
   */
  genuineExtractionFailure?: boolean;
}

/**
 * Extract the `## Scope` → `**In scope:**` file paths from a task spec.
 * Returns the list of paths found and any parse warnings.
 *
 * Strategy: find the "In scope:" bullet list between "## Scope" and the next
 * heading or end of content. Extract lines that look like file paths
 * (contain `/` or start with `.`).
 */
export function extractInScopeFiles(specContent: string): ExtractInScopeFilesResult {
  // Format A (mt#2811): the exact shape session_generate_prompt's
  // renderScopeSection emits for a subagent prompt ("## Scope Constraints" +
  // bare bullet list). Tried first, unconditionally — a task spec's own
  // "## Scope" section never collides with this heading text, so this is
  // side-effect-free for ordinary specs and lets this SAME function serve as
  // the contract-tested parser for both artifact types.
  const scopeConstraintsFiles = extractScopeConstraintsFiles(specContent);
  if (scopeConstraintsFiles.length > 0) {
    return { files: scopeConstraintsFiles, warnings: [] };
  }

  const warnings: string[] = [];

  // Format B (mt#1362, original): "## Scope" -> "**In scope:**" -> bullet
  // list of backtick-wrapped or bare file paths. Loosened from strict
  // `^##\s+Scope\s*$` to allow an optional trailing colon (`## Scope:`)
  // since some specs in this repo use that variant. Still anchors at
  // start-of-line and requires `## ` prefix.
  const scopeMatch = specContent.match(/^##\s+Scope:?\s*$/m);
  if (!scopeMatch) {
    warnings.push("No '## Scope' section found in spec — parallel-work check skipped");
    // Routine: no scope structure present at all — not a parser failure.
    return extractWithFallback(specContent, warnings);
  }

  const scopeStart = (scopeMatch.index ?? 0) + scopeMatch[0].length;
  // Find next ## heading or end of string
  const nextHeadingMatch = specContent.slice(scopeStart).match(/^##\s+/m);
  const scopeEnd =
    nextHeadingMatch !== null && nextHeadingMatch.index !== undefined
      ? scopeStart + nextHeadingMatch.index
      : specContent.length;

  const scopeContent = specContent.slice(scopeStart, scopeEnd);

  // Find "**In scope:**" or "**In scope (parenthetical):**" block.
  // Some specs use a parenthetical suffix like `**In scope (this task):**`
  // (e.g., mt#1305-style). The `[^*]*?` allows any non-asterisk chars between
  // "In scope" and ":**", capturing both forms.
  const inScopeMatch = scopeContent.match(/\*\*In scope[^*]*?:\*\*/i);
  if (!inScopeMatch) {
    warnings.push(
      "No '**In scope:**' block found in ## Scope section — parallel-work check skipped"
    );
    // Routine: has a '## Scope' section but no '**In scope:**' sub-block —
    // still not a parser failure (nothing to extract from).
    return extractWithFallback(specContent, warnings);
  }

  const inScopeStart = (inScopeMatch.index ?? 0) + inScopeMatch[0].length;
  // Find next bold section or end of scope content
  const nextBoldMatch = scopeContent.slice(inScopeStart).match(/\*\*\w/);
  const inScopeEnd =
    nextBoldMatch !== null && nextBoldMatch.index !== undefined
      ? inScopeStart + nextBoldMatch.index
      : scopeContent.length;

  const inScopeContent = scopeContent.slice(inScopeStart, inScopeEnd);

  // Extract lines that look like file paths
  const files: string[] = [];
  for (const line of inScopeContent.split("\n")) {
    const trimmed = line.trim();
    // Match: bullet list item containing a file path (has / or starts with .)
    // Common patterns:
    //   "- `src/foo/bar.ts`"         (backtick-wrapped, starts with letter)
    //   "- `src/foo/bar.ts` (new)"   (backtick-wrapped with annotation)
    //   "- `.claude/hooks/x.ts`"     (backtick-wrapped, starts with .)
    //   "- src/foo/bar.ts (new)"     (unquoted)
    //
    // Strategy: extract the backtick-wrapped token if present, else match
    // a bare path token that contains a /
    const backtickMatch = trimmed.match(/^[-*]\s+`([^`]+)`/);
    if (backtickMatch) {
      const rawPath = (backtickMatch[1] ?? "").trim();
      // Only include if it looks like a file or directory path (contains / or starts with .)
      if ((rawPath.includes("/") || rawPath.startsWith(".")) && rawPath.length > 0) {
        files.push(rawPath);
      }
      continue;
    }
    // Fallback: bare path token (must contain /). Lead character class accepts
    // letters, digits, underscore, dot, and @ so that scoped-package paths
    // like @types/foo/index.d.ts are matched in addition to ordinary paths.
    const bareMatch = trimmed.match(/^[-*]\s+([@\w.][^\s(,]+\/[^\s(,]*)/);
    if (bareMatch) {
      const rawPath = (bareMatch[1] ?? "").replace(/\/$/, "").trim();
      if (rawPath.length > 0) {
        files.push(rawPath);
      }
    }
  }

  if (files.length === 0) {
    warnings.push(
      "Could not extract file paths from '**In scope:**' block — parallel-work check skipped"
    );
    // GENUINE failure: a '**In scope:**' block WAS located but extraction
    // found nothing in it — the original mt#2811 incident class. Try the
    // fallback chain; only report as a genuine failure if the fallback ALSO
    // recovers nothing (if it recovers files, the check runs — no
    // degradation to report).
    const fallback = extractWithFallback(specContent, warnings);
    return { ...fallback, genuineExtractionFailure: fallback.files.length === 0 };
  }

  return { files, warnings };
}

// ---------------------------------------------------------------------------
// Append-only structured-config exemption
// ---------------------------------------------------------------------------

/**
 * Files where overlap is structurally non-conflicting when both PRs only
 * append entries to existing JSON arrays. These are config files that
 * register independent items (hooks, plugins, rules) — adding a new entry
 * doesn't conflict with another PR adding a different entry.
 *
 * The mechanism: `isAppendOnlyToJsonArrays` performs a structural check
 * comparing BEFORE and AFTER JSON. When the change is purely "added new
 * elements to existing arrays" (no modifications to existing values, no
 * new object keys), the change is exempt from the parallel-work guard.
 *
 * @see mt#1587 — origin task; see also `feedback_check_parallel_work_before_decomposing`
 */
export const STRUCTURED_CONFIG_ALLOWLIST: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
] as const;

/**
 * True iff `after` differs from `before` only by appending new elements to
 * existing JSON arrays at any depth. Specifically:
 *   - At every object path, AFTER must have the SAME set of keys as BEFORE
 *     (no added keys, no removed keys).
 *   - At every array path, AFTER must equal BEFORE in the first
 *     `before.length` positions (i.e., BEFORE is a prefix of AFTER).
 *     New elements may appear after BEFORE's last index.
 *   - At every primitive path, AFTER must equal BEFORE exactly.
 *
 * Returns false on any deviation (modified value, deleted key, added key
 * outside an array, array shrunk, array element modified at an existing
 * index). The caller treats false as "real conflict, keep collision."
 *
 * Pure function — no I/O.
 */
export function isAppendOnlyToJsonArrays(before: unknown, after: unknown): boolean {
  // Arrays: AFTER must extend BEFORE at the tail; existing indices must match.
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return false;
    if (after.length < before.length) return false;
    for (let i = 0; i < before.length; i++) {
      if (!deepJsonEqual(before[i], after[i])) return false;
    }
    return true;
  }

  // Objects: same key set, recursively compatible values.
  if (before !== null && typeof before === "object") {
    if (after === null || typeof after !== "object" || Array.isArray(after)) {
      return false;
    }
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const beforeKeys = Object.keys(beforeRecord);
    const afterKeys = Object.keys(afterRecord);
    if (afterKeys.length !== beforeKeys.length) {
      // AFTER added or removed object keys — not append-only-to-arrays.
      return false;
    }
    for (const key of beforeKeys) {
      if (!Object.prototype.hasOwnProperty.call(afterRecord, key)) return false;
      if (!isAppendOnlyToJsonArrays(beforeRecord[key], afterRecord[key])) {
        return false;
      }
    }
    return true;
  }

  // Primitives (and null): strict equality.
  return deepJsonEqual(before, after);
}

/**
 * Order-insensitive structural deep-equality (PR #952 R3#2 fix).
 *
 * For objects, compares the same key SET regardless of insertion order; for
 * arrays, compares element-by-element at the same index (order matters);
 * for primitives, strict equality. This avoids the false-non-exemption that
 * a JSON.stringify-based check produced when two semantically-equal objects
 * had different key insertion orders across refs (e.g., one prettified, one
 * hand-edited).
 *
 * Sufficient for our use case (settings.json contents — no functions, no
 * Dates, no cycles).
 */
function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepJsonEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a !== null && typeof a === "object") {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false;
      if (!deepJsonEqual(aRecord[key], bRecord[key])) return false;
    }
    return true;
  }

  // Primitives + null: strict equality already handled by top `a === b`.
  // Treat NaN-vs-NaN as equal for numeric primitives (PR #952 R8#2):
  // JSON.parse never produces NaN, but the helper is exported and may be
  // reused by callers with non-JSON numeric sources; treating NaN as equal
  // to NaN aligns with intuitive equality semantics.
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  return false;
}

/**
 * Fetch file content at a specific git ref via the GitHub Contents API.
 * Returns the decoded UTF-8 content, or null on failure.
 *
 * Adds a warning to the provided array on failure so the caller can surface
 * partial-coverage notes without aborting the whole sweep.
 */
export function fetchFileContentAtRef(
  repo: string,
  ref: string,
  filePath: string,
  warnings: string[]
): string | null {
  // Hard guard: the GitHub Contents API rejects rev-spec expressions like
  // <sha>^, <sha>~1, HEAD^, etc. — only branch names, tags, refs/pull/N/head,
  // and 40-char SHAs are accepted. Callers must resolve rev-specs to
  // concrete SHAs BEFORE calling this function (see fetchRecentMerges'
  // git rev-parse). Defense-in-depth against future regressions
  // reintroducing the bug — PR #952 R4#2.
  if (/[\^~]/.test(ref)) {
    warnings.push(
      `Refusing to fetch ${filePath}@${ref}: ref contains rev-spec syntax (^/~) which the GitHub Contents API rejects. Resolve to a concrete SHA before calling fetchFileContentAtRef.`
    );
    return null;
  }

  // Encode each path SEGMENT separately and rejoin with '/'. encodeURIComponent
  // on the full path encodes '/' as '%2F', which the GitHub Contents API
  // rejects with 404 — disabling the exemption entirely (PR #952 R1 BLOCKING).
  // The ref query parameter is still fully encoded.
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const result = execWithPath(
    [
      "gh",
      "api",
      `repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      "--jq",
      ".content",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    warnings.push(
      `Could not fetch ${filePath}@${ref}: gh exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
    return null;
  }

  const base64 = result.stdout.trim().replace(/\n/g, "");
  if (!base64) {
    warnings.push(`Empty content for ${filePath}@${ref}`);
    return null;
  }

  try {
    return Buffer.from(base64, "base64").toString("utf8");
  } catch (err) {
    warnings.push(
      `Could not decode ${filePath}@${ref}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Check whether the change to `filePath` between `fromRef` and `toRef` is
 * append-only into JSON arrays.
 *
 * Fetches the file content at both refs via `gh api`, parses both as JSON,
 * and runs `isAppendOnlyToJsonArrays`. Returns false on any fetch, parse,
 * or structural-check failure (fail-closed: preserve the collision if we
 * can't prove it's safe).
 *
 * Used to filter STRUCTURED_CONFIG_ALLOWLIST hits out of the open-PR and
 * recently-merged collision lists. Both refs MUST be concrete refs the
 * GitHub Contents API can resolve — branch names, tags, full SHAs, or
 * `refs/pull/<num>/head`. Rev-spec syntax (`^`, `~`) is rejected by
 * `fetchFileContentAtRef`; callers must resolve parent SHAs ahead of
 * time (see `fetchRecentMerges` for the canonical pattern using
 * `git rev-parse <sha>^`).
 *
 * Typical refs:
 *   - For open PRs: fromRef = base branch name (e.g., the PR's
 *     `baseRefName`, or "main" as fallback), toRef = `refs/pull/<num>/head`.
 *     `refs/pull/<num>/merge` is also valid and is used as a fallback by
 *     `checkOpenPrs` for forked PRs whose `/head` ref may not be
 *     addressable from the base repo's Contents API (PR #952 R8#1).
 *   - For recently-merged commits: fromRef = parent SHA resolved via
 *     `git rev-parse <sha>^`, toRef = the merge commit SHA.
 */
export function isFileChangeAppendOnly(
  repo: string,
  fromRef: string,
  toRef: string,
  filePath: string,
  warnings: string[],
  /**
   * Optional per-call-site content cache (PR #952 R9#6). Keyed by
   * `${ref}::${filePath}`. When provided, avoids re-fetching the same
   * (ref, file) pair on subsequent calls — e.g., when `/head` fails and
   * the caller retries with `/merge`, the fromRef side is fetched once.
   * Caches null values too so failed fetches are not retried within the
   * same scope.
   */
  contentCache?: Map<string, string | null>,
  /**
   * Optional out-param status object (PR #952 R10#1). When provided, the
   * function sets `status.fetchFailed = true` if either the fromRef or
   * toRef content fetch returned null (or parsing failed). Lets callers
   * distinguish "fetch failed, try fallback ref" from "definitive non-
   * append-only result, don't retry." Default behavior unchanged when
   * the param is omitted (still returns boolean).
   */
  status?: { fetchFailed: boolean }
): boolean {
  const cacheKey = (ref: string, p: string): string => `${ref}::${p}`;
  const fetchCached = (ref: string): string | null => {
    if (contentCache) {
      const key = cacheKey(ref, filePath);
      if (contentCache.has(key)) return contentCache.get(key) ?? null;
      const content = fetchFileContentAtRef(repo, ref, filePath, warnings);
      contentCache.set(key, content);
      return content;
    }
    return fetchFileContentAtRef(repo, ref, filePath, warnings);
  };
  const beforeContent = fetchCached(fromRef);
  const afterContent = fetchCached(toRef);
  if (beforeContent === null || afterContent === null) {
    if (status) status.fetchFailed = true;
    return false;
  }

  let beforeJson: unknown;
  let afterJson: unknown;
  try {
    beforeJson = JSON.parse(beforeContent);
    afterJson = JSON.parse(afterContent);
  } catch (err) {
    warnings.push(
      `Could not parse JSON for ${filePath} on ref pair ${fromRef}…${toRef}: ${err instanceof Error ? err.message : String(err)}`
    );
    // Treat parse failure as fetch failure for fallback purposes — the
    // ref returned non-JSON content, which is likely a corrupted or
    // unexpected response from the API and a different ref might work.
    if (status) status.fetchFailed = true;
    return false;
  }

  return isAppendOnlyToJsonArrays(beforeJson, afterJson);
}

// ---------------------------------------------------------------------------
// Check A: Open-PR sweep
// ---------------------------------------------------------------------------

interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
  /**
   * The PR's actual base branch name. Used as `fromRef` in the structural
   * exemption check so the comparison reflects the PR's real diff, not a
   * comparison against the repo's default branch (PR #952 R7#4). Optional
   * because legacy test deps may not provide it; production fetchOpenPrs
   * always populates it.
   */
  baseRefName?: string;
}

/**
 * Server-side cap for the open-PR fetch. Aligned with `MAX_PRS_TO_SCAN` in
 * `checkOpenPrs` — if you raise one, raise the other.
 */
const FETCH_OPEN_PRS_LIMIT = 200;

/**
 * Per-subprocess timeout in milliseconds for gh/git calls. The PreToolUse
 * hook has a 30s overall budget; per-call caps prevent a single slow
 * subprocess from consuming it. Treat timeouts as warnings (fail-open).
 *
 * Lowered from 10s to 5s so that even degraded per-PR lookups can't
 * cumulatively blow the 30s budget across 200 sequential calls.
 */
const GH_GIT_TIMEOUT_MS = 5_000;

/**
 * Overall wall-clock budget (in ms) for `checkOpenPrs` to scan its slice
 * of the PR list. Headroom under the 30s PreToolUse hook timeout. When
 * the elapsed time approaches this, the sweep stops early with a warning
 * rather than risking a SIGTERM mid-call.
 */
const OPEN_PR_SWEEP_BUDGET_MS = 25_000;

/**
 * Fetch open PRs from the repository.
 *
 * Uses `gh pr list --state=open --limit N` so the cap is enforced
 * **at the server**: we never walk past N PRs over the network, even when
 * the repo has thousands. This bounds the work for the per-PR sweep and
 * keeps the hook within its 30s budget.
 *
 * Throws on non-zero exit so the caller (runParallelWorkChecks) can surface
 * the failure as a warning rather than silently returning [].
 */
export function fetchOpenPrs(repo: string): PrInfo[] {
  const result = execWithPath(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(FETCH_OPEN_PRS_LIMIT),
      "--json",
      "number,title,headRefName,baseRefName",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    throw new Error(`gh pr list exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  if (!result.stdout.trim()) {
    return [];
  }

  try {
    return JSON.parse(result.stdout) as PrInfo[];
  } catch (err) {
    throw new Error(
      `gh pr list returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Fetch the list of changed files for a PR number.
 *
 * Unlike fetchOpenPrs, this function does NOT throw on non-zero exit — a
 * single PR lookup failure should not abort the whole sweep. Instead it
 * pushes to the provided warnings array and returns [].
 */
export function fetchPrFiles(repo: string, prNumber: number, warnings: string[] = []): string[] {
  const result = execWithPath(
    [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "files",
      "--jq",
      ".files[].path",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    warnings.push(
      `Could not fetch files for PR #${prNumber}: gh exited ${result.exitCode}: ${result.stderr || result.stdout}`
    );
    return [];
  }

  if (!result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/**
 * Check if any of the `inScopeFiles` patterns overlap with `prFiles`.
 *
 * Match semantics: exact file equality OR directory-prefix bounded by a
 * path separator (`/`). The boundary is critical — a boundary-less prefix
 * check would false-match `src/app` against `src/application/config.ts`,
 * blocking valid sessions.
 *
 * Both directions are checked: a scope entry may be either a file
 * (matched as equality) or a directory (matched via `${normalizedScope}/`
 * prefix on prFile, or vice versa if the PR's file list happens to
 * include directory entries).
 *
 * Trailing slashes are normalized away on both sides so `src/foo/` and
 * `src/foo` behave identically.
 */
export function findOverlappingFiles(inScopeFiles: string[], prFiles: string[]): string[] {
  const overlapping: string[] = [];
  const normalize = (p: string): string => p.replace(/^\.\//, "").replace(/\/$/, "");
  for (const scopeFile of inScopeFiles) {
    const normalizedScope = normalize(scopeFile);
    for (const rawPrFile of prFiles) {
      const normalizedPrFile = normalize(rawPrFile);
      const matches =
        normalizedPrFile === normalizedScope ||
        normalizedPrFile.startsWith(`${normalizedScope}/`) ||
        normalizedScope.startsWith(`${normalizedPrFile}/`);
      if (matches) {
        if (!overlapping.includes(rawPrFile)) {
          overlapping.push(rawPrFile);
        }
        break;
      }
    }
  }
  return overlapping;
}

/**
 * Decide whether a PR's branch should be treated as the task's own branch
 * (and therefore skipped to avoid self-collision).
 *
 * Only one mode: exact equality with `currentBranch` (the actual HEAD of the
 * session repo). If `currentBranch` is null or undefined, no skip occurs —
 * the branch is treated as a peer. This prevents a teammate's PR using the
 * same task ID (different author, different scope variant) from being silently
 * skipped by a token-based heuristic, which was the root failure mode this
 * guard exists to catch.
 *
 * Round-10 BLOCKING fix: prior token-based heuristic was removed because it
 * matched any branch whose name contained the task token as a delimited
 * segment (e.g. "feature/mt-1362"), hiding legitimate peer PRs that share
 * the same task ID.
 */
export function isOwnBranch(
  branchName: string,
  _taskId: string,
  currentBranch?: string | null
): boolean {
  if (currentBranch && branchName === currentBranch) {
    return true;
  }
  return false;
}

/**
 * Run the open-PR sweep. Skips PRs whose branch exactly matches the session's
 * current branch (per `isOwnBranch`) to avoid false self-collision.
 *
 * `fetchPrs` and `fetchFiles` are injectable so tests can exercise the
 * collision/no-collision paths without live `gh` calls.
 *
 * The `warnings` array is threaded through to fetchFiles so that individual
 * per-PR lookup failures are surfaced without aborting the sweep.
 */
export function checkOpenPrs(
  input: ParallelWorkCheckInput,
  currentBranch?: string | null,
  fetchPrs: (repo: string) => PrInfo[] = fetchOpenPrs,
  fetchFiles: (repo: string, prNumber: number, warnings: string[]) => string[] = fetchPrFiles,
  warnings: string[] = [],
  isAppendOnly: (
    repo: string,
    fromRef: string,
    toRef: string,
    filePath: string,
    warnings: string[],
    contentCache?: Map<string, string | null>,
    status?: { fetchFailed: boolean }
  ) => boolean = isFileChangeAppendOnly
): ParallelWorkCollision[] {
  // Start the sweep budget timer BEFORE the fetchOpenPrs call so that the
  // time spent fetching the PR list counts against the 25s budget. Without
  // this, a slow fetchOpenPrs (up to GH_GIT_TIMEOUT_MS=5s) plus N×5s per-PR
  // lookups could exceed the 30s PreToolUse cap.
  const sweepStart = Date.now();
  const prs = fetchPrs(input.repo);
  const collisions: ParallelWorkCollision[] = [];

  // Bound the per-PR sweep two ways:
  //   1. Hard cap at MAX_PRS_TO_SCAN (200) — matches the server-side cap
  //      in fetchOpenPrs. Because gh pr list --limit truncates at the
  //      server, in production prs.length will never exceed 200; this
  //      slice is a defense-in-depth check for tests that bypass that
  //      cap via injected deps.
  //   2. Wall-clock budget — stop early if cumulative scan time approaches
  //      the 30s hook timeout, so we always emit a structured allow/deny
  //      rather than getting SIGTERM'd mid-call.
  const MAX_PRS_TO_SCAN = 200;
  const prsToScan = prs.slice(0, MAX_PRS_TO_SCAN);
  // Emit warning when:
  //   (a) injected deps returned > 200 PRs (test-only path), OR
  //   (b) production fetch hit the server-side cap exactly (likely
  //       truncated — total open PR count is unknown but ≥200).
  if (prs.length > MAX_PRS_TO_SCAN) {
    warnings.push(
      `Open-PR sweep capped at ${MAX_PRS_TO_SCAN} of ${prs.length} open PRs (preserves 30s hook budget)`
    );
  } else if (prs.length === MAX_PRS_TO_SCAN) {
    warnings.push(
      `Open-PR sweep at server cap of ${MAX_PRS_TO_SCAN} PRs — total count unknown, additional PRs may exist beyond this set`
    );
  }

  let scannedCount = 0;
  let abortedForBudget = false;

  for (const pr of prsToScan) {
    // Time-budget check — fire BEFORE the next subprocess so we never
    // start a call we can't afford to finish.
    if (Date.now() - sweepStart >= OPEN_PR_SWEEP_BUDGET_MS) {
      abortedForBudget = true;
      break;
    }

    // Skip the task's own PR branch (exact currentBranch match only)
    if (isOwnBranch(pr.headRefName, input.taskId, currentBranch)) {
      continue;
    }

    const prFiles = fetchFiles(input.repo, pr.number, warnings);
    scannedCount += 1;
    const overlapping = findOverlappingFiles(input.inScopeFiles, prFiles);

    if (overlapping.length === 0) {
      continue;
    }

    // Filter out STRUCTURED_CONFIG_ALLOWLIST files whose change in this PR
    // is purely append-only into JSON arrays — those don't conflict with
    // a peer PR also adding entries (mt#1587). Each filtered file emits a
    // warning so operators can audit the exemption. Allowlisted files that
    // FAIL the structural check also emit a triage hint (PR #952 R1 inline
    // nit) so operators understand why a collision was kept.
    // Use `refs/pull/<num>/head` — the canonical PR-head ref that GitHub
    // always provides in the base repo's namespace, regardless of whether
    // the PR is from a fork. PR #952 R4#1 fix replacing the R3#1 attempt
    // (which used pr.headRefOid — a fork-only SHA for forked PRs, not
    // addressable via the base repo's Contents API).
    // Try `refs/pull/<num>/head` first, then `refs/pull/<num>/merge` as a
    // fallback. The `/head` ref is the PR's actual head commit; `/merge` is
    // the GitHub-materialized merge-commit-with-base. For private/deleted
    // forks where `/head` may not be addressable from the base repo's
    // Contents API, `/merge` provides a fallback addressable from base.
    // PR #952 R8#1.
    const toRefCandidates = [`refs/pull/${pr.number}/head`, `refs/pull/${pr.number}/merge`];
    // Per-PR content cache (PR #952 R9#6): avoids re-fetching the same
    // (ref, file) pair when /head fails and /merge is retried — the
    // fromRef-side fetch is identical across both attempts.
    const prContentCache = new Map<string, string | null>();
    // Use the PR's actual base branch as `fromRef` (PR #952 R7#4). When
    // baseRefName is missing (legacy test deps / very old fetchOpenPrs
    // implementations), fail-closed: skip the structured exemption for
    // this PR rather than miscompare against the repo default branch
    // (PR #952 R10#2). The structural check runs only with a definitive
    // baseRefName.
    const fromRef = pr.baseRefName;
    let baseFallbackWarned = false;
    const realOverlapping = overlapping.filter((file) => {
      if (!STRUCTURED_CONFIG_ALLOWLIST.includes(file)) return true;
      if (!fromRef) {
        if (!baseFallbackWarned) {
          warnings.push(
            `PR #${pr.number}: baseRefName unavailable — structural-config exemption skipped (fail-closed, PR #952 R10#2)`
          );
          baseFallbackWarned = true;
        }
        return true; // keep collision (fail-closed)
      }
      // Mid-iteration budget recheck (PR #952 R5#4): each isAppendOnly call
      // can issue up to two `gh api` calls (BEFORE + AFTER content fetch).
      // If the budget is nearly exhausted, fail-closed rather than risking
      // SIGTERM mid-fetch.
      if (Date.now() - sweepStart >= OPEN_PR_SWEEP_BUDGET_MS) {
        warnings.push(
          `PR #${pr.number}: ${file} structural-config exemption skipped (budget exhausted) — keeping collision`
        );
        return true;
      }
      // Try each candidate ref. False from isAppendOnly may be either a
      // "definitive non-append-only" result OR a fetch/parse failure.
      // Use the `status` out-param (PR #952 R10#1) to distinguish: only
      // fall back to `/merge` when the prior attempt's fetch FAILED.
      // A definitive false from `/head` short-circuits — the PR's diff is
      // genuinely non-append-only and trying `/merge` could silently
      // exempt a real collision.
      let isExempt = false;
      let usedRef = "";
      for (const candidateToRef of toRefCandidates) {
        if (Date.now() - sweepStart >= OPEN_PR_SWEEP_BUDGET_MS) break;
        const status = { fetchFailed: false };
        const ok = isAppendOnly(
          input.repo,
          fromRef,
          candidateToRef,
          file,
          warnings,
          prContentCache,
          status
        );
        if (ok) {
          isExempt = true;
          usedRef = candidateToRef;
          break;
        }
        if (!status.fetchFailed) {
          // Definitive non-append-only result — don't retry next candidate.
          break;
        }
      }
      if (isExempt && usedRef.endsWith("/merge")) {
        warnings.push(
          `PR #${pr.number}: ${file} exemption resolved via ${usedRef} fallback (head ref not addressable)`
        );
      }
      if (isExempt) {
        warnings.push(
          `PR #${pr.number}: ${file} change is append-only into JSON arrays — exempted from collision`
        );
      } else {
        warnings.push(
          `PR #${pr.number}: ${file} is allowlisted but its change is NOT append-only — keeping collision`
        );
      }
      return !isExempt;
    });

    if (realOverlapping.length > 0) {
      collisions.push({
        type: "open-pr",
        prNumber: pr.number,
        prTitle: pr.title,
        overlappingFiles: realOverlapping,
      });
    }
  }

  if (abortedForBudget) {
    warnings.push(
      `Open-PR sweep aborted at ${scannedCount} of ${prsToScan.length} PRs after ${Math.round(
        (Date.now() - sweepStart) / 1000
      )}s (partial scan; 30s hook budget approaching)`
    );
  }

  return collisions;
}

// ---------------------------------------------------------------------------
// Check B: Recently-merged sweep
// ---------------------------------------------------------------------------

interface GitLogEntry {
  sha: string;
  message: string;
  files: string[];
}

/**
 * Detect the default remote branch ref (e.g. "origin/main"). Tries multiple
 * sources in order so repos with master, custom defaults, or unset symbolic
 * refs are all handled correctly. Only warns and falls back when ALL probes
 * fail — addresses the round-5 BLOCKING finding that the previous single-shot
 * fallback to "origin/main" silently disabled the recently-merged sweep on
 * any repo whose default isn't main.
 *
 * Probe order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — fastest, exact answer
 *   2. `git remote show origin` — parses "HEAD branch: <name>" line
 *   3. `git rev-parse --verify origin/main` — probe explicit
 *   4. `git rev-parse --verify origin/master` — probe explicit
 *
 * Returns `{ref: null, warning}` if all probes fail; the caller should treat
 * that as "skip recently-merged sweep" rather than fall back to a wrong ref.
 */
export function detectDefaultBranch(repoDir: string): { ref: string | null; warning?: string } {
  // Probe 1: symbolic ref
  const symbolic = execWithPath(
    ["git", "-C", repoDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
    { timeout: GH_GIT_TIMEOUT_MS }
  );
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
    return { ref: symbolic.stdout.trim().replace(/^refs\/remotes\//, "") };
  }

  // Probe 2: `git remote show origin` — parses "HEAD branch: <name>"
  const remoteShow = execWithPath(["git", "-C", repoDir, "remote", "show", "origin"], {
    timeout: GH_GIT_TIMEOUT_MS,
  });
  if (remoteShow.exitCode === 0) {
    const headMatch = remoteShow.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    if (headMatch && headMatch[1] !== "(unknown)") {
      return { ref: `origin/${headMatch[1]}` };
    }
  }

  // Probes 3 and 4: try common defaults explicitly
  for (const candidate of ["main", "master"]) {
    const probe = execWithPath(
      ["git", "-C", repoDir, "rev-parse", "--verify", `origin/${candidate}`],
      { timeout: GH_GIT_TIMEOUT_MS }
    );
    if (probe.exitCode === 0) {
      return { ref: `origin/${candidate}` };
    }
  }

  return {
    ref: null,
    warning:
      "Could not detect default remote branch via symbolic-ref, `remote show origin`, or `origin/main`/`origin/master` probes; recently-merged sweep skipped",
  };
}

/**
 * Fetch commits on the default branch in the last `hours` hours that touch
 * any of the in-scope paths. Uses `git log --name-only` for file list.
 *
 * Strategy: follow the default branch's first-parent lineage (so we don't
 * recurse into merged branches' individual commits) AND include merge commits
 * with `-m --diff-merges=first-parent` so the merge commit reports the file
 * set brought in by the merged PR. The repo's policy is to use merge-method
 * merges (see docs/pr-workflow.md §Merge method policy), so excluding
 * merges (`--no-merges`) was missing exactly the just-landed PR commits
 * this sweep is meant to catch.
 *
 * Throws on non-zero exit so the caller (runParallelWorkChecks) can surface
 * the failure as a warning rather than silently returning [].
 */
export function fetchRecentMerges(
  repoDir: string,
  inScopeFiles: string[],
  hours: number,
  defaultBranchRef?: string,
  repo?: string,
  warnings: string[] = [],
  isAppendOnly: (
    repo: string,
    fromRef: string,
    toRef: string,
    filePath: string,
    warnings: string[],
    contentCache?: Map<string, string | null>,
    status?: { fetchFailed: boolean }
  ) => boolean = isFileChangeAppendOnly
): ParallelWorkCollision[] {
  // Wall-clock budget for the merge sweep (PR #952 R5#5). Mirror of
  // OPEN_PR_SWEEP_BUDGET_MS — a per-commit `git rev-parse` plus up to two
  // `gh api` calls per allowlisted file can blow the 30s PreToolUse cap on
  // busy repos with many recent merges.
  const sweepStart = Date.now();
  const MERGE_SWEEP_BUDGET_MS = 25_000;

  // ISO timestamp for `hours` ago
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const branchRef = defaultBranchRef ?? "origin/main";

  // Get log with file names in the last N hours on the default branch
  const result = execWithPath(
    [
      "git",
      "-C",
      repoDir,
      "log",
      branchRef,
      `--since=${since}`,
      "--first-parent",
      "-m",
      "--diff-merges=first-parent",
      "--name-only",
      "--format=COMMIT:%H %s",
    ],
    { timeout: GH_GIT_TIMEOUT_MS }
  );

  if (result.exitCode !== 0) {
    throw new Error(`git log exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  if (!result.stdout.trim()) {
    return [];
  }

  // Parse output: each commit is delimited by a COMMIT: line, followed by file names
  const entries: GitLogEntry[] = [];
  let current: GitLogEntry | null = null;

  for (const line of result.stdout.split("\n")) {
    const commitMatch = line.match(/^COMMIT:([0-9a-f]+)\s+(.*)/);
    if (commitMatch) {
      if (current) entries.push(current);
      current = { sha: commitMatch[1] ?? "", message: commitMatch[2] ?? "", files: [] };
    } else if (current && line.trim().length > 0) {
      current.files.push(line.trim());
    }
  }
  if (current) entries.push(current);

  // Find overlapping commits
  const collisions: ParallelWorkCollision[] = [];
  let mergeBudgetAborted = false;
  for (const entry of entries) {
    // Per-commit wall-clock budget check (PR #952 R5#5). Stop early if
    // the cumulative scan time approaches the 30s hook timeout.
    if (Date.now() - sweepStart >= MERGE_SWEEP_BUDGET_MS) {
      mergeBudgetAborted = true;
      break;
    }

    const overlapping = findOverlappingFiles(inScopeFiles, entry.files);
    if (overlapping.length === 0) {
      continue;
    }

    // Filter out STRUCTURED_CONFIG_ALLOWLIST files whose change in this
    // commit was append-only into JSON arrays. Skip the filter when `repo`
    // wasn't supplied (legacy callers / tests) — preserve original behavior.
    let realOverlapping = overlapping;
    if (repo) {
      // Resolve <sha>^ to a real 40-char SHA before passing to the GitHub
      // Contents API. The Contents API rejects rev-spec expressions like
      // "<sha>^" or "<sha>~1" — only branch names, tags, and full SHAs work.
      // PR #952 R3#3 fix.
      const parentResult = execWithPath(["git", "-C", repoDir, "rev-parse", `${entry.sha}^`], {
        timeout: GH_GIT_TIMEOUT_MS,
      });
      const parentSha = parentResult.exitCode === 0 ? parentResult.stdout.trim() : null;
      if (!parentSha) {
        warnings.push(
          `Commit ${entry.sha.slice(0, 7)}: could not resolve parent SHA via git rev-parse — keeping all overlapping files as collisions`
        );
      }
      realOverlapping = overlapping.filter((file) => {
        if (!STRUCTURED_CONFIG_ALLOWLIST.includes(file)) return true;
        if (!parentSha) return true; // fail-closed: keep collision
        // Mid-iteration budget recheck (PR #952 R5#5): each isAppendOnly
        // call adds two `gh api` calls. Fail-closed if budget exhausted.
        if (Date.now() - sweepStart >= MERGE_SWEEP_BUDGET_MS) {
          warnings.push(
            `Commit ${entry.sha.slice(0, 7)}: ${file} structural-config exemption skipped (budget exhausted) — keeping collision`
          );
          return true;
        }
        const isExempt = isAppendOnly(repo, parentSha, entry.sha, file, warnings);
        if (isExempt) {
          warnings.push(
            `Commit ${entry.sha.slice(0, 7)}: ${file} change is append-only into JSON arrays — exempted from collision`
          );
        } else {
          warnings.push(
            `Commit ${entry.sha.slice(0, 7)}: ${file} is allowlisted but its change is NOT append-only — keeping collision`
          );
        }
        return !isExempt;
      });
    } else {
      // Surface the skipped-exemption case explicitly so operators can see
      // when an allowlisted file was kept as a collision because no `repo`
      // slug was available (PR #952 R1 NON-BLOCKING #4).
      const skippedAllowlisted = overlapping.filter((f) => STRUCTURED_CONFIG_ALLOWLIST.includes(f));
      if (skippedAllowlisted.length > 0) {
        warnings.push(
          `Commit ${entry.sha.slice(0, 7)}: structural-config exemption skipped for ${skippedAllowlisted.join(", ")} — no GitHub repo slug supplied`
        );
      }
    }

    if (realOverlapping.length > 0) {
      collisions.push({
        type: "recently-merged",
        commitSha: entry.sha.slice(0, 7),
        commitMessage: entry.message,
        overlappingFiles: realOverlapping,
      });
    }
  }

  if (mergeBudgetAborted) {
    warnings.push(
      `Recently-merged sweep aborted after ${Math.round((Date.now() - sweepStart) / 1000)}s (partial scan; 30s hook budget approaching)`
    );
  }

  return collisions;
}

// ---------------------------------------------------------------------------
// Main check logic
// ---------------------------------------------------------------------------

/**
 * Injectable dependency surface for `runParallelWorkChecks`. The default
 * impls call live `gh` and `git` subprocesses; tests pass mocks to exercise
 * the collision/no-collision paths hermetically.
 *
 * fetchPrFiles accepts a warnings array so per-PR lookup failures are
 * surfaced without aborting the sweep.
 *
 * **Signature change in mt#1587 (PR #952 R9#5)**: `fetchRecentMerges`
 * gained optional trailing parameters (`repo`, `warnings`, `isAppendOnly`)
 * to support the structural-config exemption. `isFileChangeAppendOnly` is
 * also a new dep. External callers that pass a custom `deps` object built
 * before this change will receive extra arguments at call time —
 * TypeScript tolerates extra args, but consumers should update their
 * `fetchRecentMerges` signature to accept the new params if they care
 * about the structural exemption applying to recently-merged commits.
 */
export interface ParallelWorkCheckDeps {
  fetchOpenPrs: (repo: string) => PrInfo[];
  fetchPrFiles: (repo: string, prNumber: number, warnings: string[]) => string[];
  fetchRecentMerges: (
    repoDir: string,
    inScopeFiles: string[],
    hours: number,
    defaultBranchRef?: string,
    repo?: string,
    warnings?: string[],
    isAppendOnly?: (
      repo: string,
      fromRef: string,
      toRef: string,
      filePath: string,
      warnings: string[]
    ) => boolean
  ) => ParallelWorkCollision[];
  detectDefaultBranch: (repoDir: string) => { ref: string | null; warning?: string };
  /**
   * Optional in mt#1587 (PR #952 R11#3): pre-mt#1587 callers that built a
   * `deps` object without this field still type-check. When omitted, the
   * structural-config exemption is disabled (every allowlisted file change
   * is treated as a real collision — fail-closed). External callers that
   * want the exemption must pass `isFileChangeAppendOnly`.
   */
  isFileChangeAppendOnly?: (
    repo: string,
    fromRef: string,
    toRef: string,
    filePath: string,
    warnings: string[],
    contentCache?: Map<string, string | null>,
    status?: { fetchFailed: boolean }
  ) => boolean;
}

const DEFAULT_DEPS: ParallelWorkCheckDeps = {
  fetchOpenPrs,
  fetchPrFiles,
  fetchRecentMerges,
  detectDefaultBranch,
  isFileChangeAppendOnly,
};

/**
 * Run both parallel-work checks (open-PR + recently-merged).
 * Returns a structured result with all collisions found.
 *
 * The `repoDir` param is used for the git log check and default-branch
 * detection. `deps` is injectable so tests can mock the `gh` / `git`
 * subprocesses and exercise the green and colliding paths end-to-end.
 */
export function runParallelWorkChecks(
  input: ParallelWorkCheckInput,
  repoDir: string,
  currentBranch?: string | null,
  deps: ParallelWorkCheckDeps = DEFAULT_DEPS
): ParallelWorkCheckResult {
  const collisions: ParallelWorkCollision[] = [];
  const warnings: string[] = [];

  // Short-circuit: nothing to check if there are no in-scope files
  if (input.inScopeFiles.length === 0) {
    warnings.push("No in-scope files to check — parallel-work check skipped");
    return { blocked: false, collisions, warnings };
  }

  // Detect default branch up-front so both sweeps can use the bare branch
  // name (e.g., "main") for `gh api` content lookups in the structural
  // append-only check (mt#1587).
  let defaultBranchRef: string | null = null;
  try {
    const detected = deps.detectDefaultBranch(repoDir);
    if (detected.warning) warnings.push(detected.warning);
    defaultBranchRef = detected.ref;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Default-branch detection failed (non-blocking): ${msg}`);
  }
  // Check A: open PRs. Open-PR structural exemption uses each PR's own
  // baseRefName (fail-closed when missing, PR #952 R10#2) so it does NOT
  // depend on the repo-level default-branch detection above. Only the
  // recently-merged sweep below needs `defaultBranchRef`.
  try {
    const prCollisions = checkOpenPrs(
      input,
      currentBranch,
      deps.fetchOpenPrs,
      deps.fetchPrFiles,
      warnings,
      deps.isFileChangeAppendOnly ?? (() => false)
    );
    collisions.push(...prCollisions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Open-PR sweep failed (non-blocking): ${msg}`);
  }

  // Check B: recently merged — uses the default branch detected above.
  //
  // ADVISORY ONLY (mt#2337): `session_start` performs a fresh `git clone` of
  // the remote (packages/domain/src/session/start-session-operations.ts →
  // git/clone-operations.ts), so the new session branch ALWAYS includes the
  // latest commits on the default branch. A commit already on the default
  // branch therefore cannot produce a merge conflict for the new session — the
  // merge-conflict rationale only holds for UNMERGED open PRs (Check A). These
  // overlaps are surfaced as warnings, NOT pushed into `collisions`, so they
  // never set `blocked`. (This removed the sequential-follow-up false positive:
  // editing a file you just merged no longer denies session_start.)
  try {
    if (defaultBranchRef === null) {
      // All probes failed; skip the sweep rather than running against a wrong ref
    } else {
      const mergeCollisions = deps.fetchRecentMerges(
        repoDir,
        input.inScopeFiles,
        input.lookbackHours,
        defaultBranchRef,
        input.repo,
        warnings,
        deps.isFileChangeAppendOnly
      );
      for (const mergeCollision of mergeCollisions) {
        warnings.push(formatRecentlyMergedAdvisory(mergeCollision));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Recently-merged sweep failed (non-blocking): ${msg}`);
  }

  return {
    // Only OPEN-PR collisions block (genuine unmerged concurrent work). The
    // `collisions` array intentionally never contains recently-merged entries
    // (those are advisory warnings — mt#2337).
    blocked: collisions.length > 0,
    collisions,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Denial message formatting
// ---------------------------------------------------------------------------

export function formatBlockMessage(
  taskId: string,
  collisions: ParallelWorkCollision[],
  /**
   * Names the action being blocked (mt#2657 R3 fix). Defaults to "session_start"
   * for the original Tier-3 ceiling; `tasks_dispatch`'s existing-task mode passes
   * "one-call-dispatching" (mirroring `check-task-spec-read.ts`'s `buildDenialReason`
   * action-naming convention) so the denial message names what actually happened.
   */
  actionLabel: string = "session_start"
): string {
  const lines: string[] = [
    `Parallel-work guard: ${actionLabel} for ${taskId} blocked — in-scope files overlap with active work.`,
    "",
  ];

  for (const col of collisions) {
    // Only open-PR collisions are blocking and reach this message. Recently-merged
    // overlaps are advisory warnings (mt#2337) and are never placed in `collisions`,
    // so a non-open-pr entry here would be a contract violation — skip defensively.
    if (col.type !== "open-pr") continue;
    lines.push(
      `  OPEN PR #${col.prNumber}: "${col.prTitle}"`,
      `    Overlapping files: ${col.overlappingFiles.join(", ")}`,
      ""
    );
  }

  lines.push("Recommended actions:");
  lines.push("  1. WAIT — let the parallel PR merge first, then start your session.");
  lines.push("  2. COORDINATE — rebase on that PR's branch and open a single combined PR.");
  lines.push("  3. REFRAME — adjust the task scope to avoid the conflicting files.");
  lines.push("  4. OVERRIDE — if parallel work is intentional and acknowledged:");
  lines.push("       Set MINSKY_FORCE_PARALLEL=1 in your environment and retry.");
  lines.push("       The override is audit-logged.");

  return lines.join("\n");
}

/**
 * Format a recently-merged overlap as a non-blocking advisory warning (mt#2337).
 *
 * Recently-merged commits are already present in the freshly-cloned session
 * branch, so they cannot cause a merge conflict — the value is purely "review
 * this recent change to the same files to avoid duplicating it." Returned as a
 * warning string rather than a blocking collision.
 */
export function formatRecentlyMergedAdvisory(collision: ParallelWorkCollision): string {
  const sha = collision.commitSha ?? "unknown";
  const message = collision.commitMessage ?? "";
  const files = collision.overlappingFiles.join(", ");
  return (
    `Recently-merged ${sha} ("${message}") touched in-scope files: ${files}. ` +
    `Your new session clones the latest default branch and already includes it ` +
    `(no merge conflict) — review the change to avoid duplicate work.`
  );
}

// ---------------------------------------------------------------------------
// Spec fetching (uses minsky CLI)
// ---------------------------------------------------------------------------

/**
 * Fetch task spec content via the minsky CLI. Returns null on failure.
 *
 * Routed through execWithPath with the same per-call timeout as gh/git
 * subprocesses so a slow minsky CLI can't consume the 30s PreToolUse
 * budget. Per round-9 reviewer feedback.
 */
export function fetchTaskSpec(taskId: string): string | null {
  const result = execWithPath(["minsky", "tasks", "spec", "get", taskId], {
    timeout: GH_GIT_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    return null;
  }

  return result.stdout;
}

/** Where `resolveInScopeFiles` sourced its file list from. */
export type InScopeFilesSource = "dispatch-scope-param" | "spec-parse" | "spec-fetch-failed";

export interface ResolvedInScopeFiles {
  files: string[];
  warnings: string[];
  source: InScopeFilesSource;
  /**
   * mt#2811 R1: propagated from `extractInScopeFiles` when `source ===
   * "spec-parse"` — true iff the spec HAD a parseable '**In scope:**' block
   * but extraction genuinely found nothing in it (not "no scope structure
   * present at all"). Always `undefined` for `dispatch-scope-param` (no
   * parsing happened) and irrelevant for `spec-fetch-failed` (that source is
   * ALWAYS treated as a genuine failure — see `shouldReportAsGuardDegraded`).
   */
  genuineExtractionFailure?: boolean;
}

/**
 * mt#2811 R1 (PR #1953 review, BLOCKING #3): the single decision point for
 * whether a zero-files resolution should be reported LOUD (stderr, "GUARD
 * DEGRADED") or QUIET (stdout, routine). Exported and pure so it is
 * unit-testable directly — the entrypoint (`import.meta.main`) calls this
 * rather than re-deriving the logic inline, so a test asserting `false` here
 * is a direct, literal proxy for "this call would not write to stderr."
 *
 * LOUD (true) for exactly two genuine-failure classes:
 *   1. `source === "spec-fetch-failed"` — the `minsky tasks spec get` CLI
 *      call itself errored (infrastructure failure, same class as
 *      child-enumeration CLI failures).
 *   2. `source === "spec-parse" && genuineExtractionFailure === true` — a
 *      `**In scope:**` block WAS found but extraction found nothing in it
 *      (the original mt#2811 incident class).
 *
 * QUIET (false) for everything else, including the routine "no scope
 * structure present anywhere in the spec" case (no '## Scope' section, or a
 * '## Scope' section with no '**In scope:**' sub-block) — this is NOT a
 * parser failure, just a spec with nothing to check, and has always been
 * tolerated gracefully (pre-mt#2811 behavior). Also quiet for
 * `dispatch-scope-param` resolutions (an explicit, empty/absent `scope` is
 * simply "not supplied," never a failure).
 */
export function shouldReportAsGuardDegraded(resolved: ResolvedInScopeFiles): boolean {
  if (resolved.source === "spec-fetch-failed") return true;
  if (resolved.source === "spec-parse" && resolved.genuineExtractionFailure === true) return true;
  return false;
}

/**
 * Resolve the in-scope file list for the open-PR sweep (session_start /
 * tasks_dispatch existing-task mode). mt#2811: PREFERS the `tasks_dispatch`
 * call's own `scope` parameter — a comma-separated file-path string,
 * available directly in `tool_input` at PreToolUse time, and the SAME
 * structured input `session_generate_prompt`'s `renderScopeSection` renders
 * into the subagent's "## Scope Constraints" section (see
 * packages/domain/src/session/prompt-generation.ts) — over parsing the
 * task's persisted spec. Reading the parameter directly cannot drift from
 * whatever prose/markdown convention the spec happens to use, and it
 * guarantees the guard checks EXACTLY the files the subagent will be told to
 * constrain to. Falls back to fetching + parsing the task's spec
 * (`extractInScopeFiles`) when `scope` is absent — the only path available
 * for `session_start` (no `scope` param exists on that tool) and for
 * `tasks_dispatch` calls that omit `scope`.
 *
 * Pure given the injected `fetchSpec` — hermetically testable without
 * invoking the CLI.
 */
export function resolveInScopeFiles(
  toolName: string,
  toolInput: Record<string, unknown>,
  fetchSpec: (taskId: string) => string | null,
  taskId: string
): ResolvedInScopeFiles {
  if (toolName === DISPATCH_TOOL_NAME && typeof toolInput["scope"] === "string") {
    const raw = toolInput["scope"] as string;
    const files = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (files.length > 0) {
      return { files, warnings: [], source: "dispatch-scope-param" };
    }
  }

  const specContent = fetchSpec(taskId);
  if (!specContent) {
    return {
      files: [],
      warnings: [`Could not fetch spec for ${taskId}`],
      source: "spec-fetch-failed",
    };
  }

  const { files, warnings, genuineExtractionFailure } = extractInScopeFiles(specContent);
  return { files, warnings, source: "spec-parse", genuineExtractionFailure };
}

// ---------------------------------------------------------------------------
// Repo derivation
// ---------------------------------------------------------------------------

/**
 * Parse an `owner/repo` slug out of a GitHub remote URL. Returns null if the
 * URL doesn't look like a GitHub remote.
 *
 * Supports these forms:
 *   - SCP-style SSH:         `git@github.com:owner/repo[.git]`
 *   - URL-style SSH:         `ssh://[git@]github.com/owner/repo[.git]`
 *   - SSH with port:         `ssh://git@github.com:22/owner/repo[.git]`
 *   - git+ssh prefix:        `git+ssh://git@github.com/owner/repo.git`
 *   - HTTPS plain:           `https://github.com/owner/repo[.git][/]`
 *   - HTTPS with creds:      `https://token@github.com/owner/repo[.git]`
 *
 * Pure function — no I/O.
 */
export function parseGitHubRemoteUrl(url: string): string | null {
  const trimmed = url.trim();

  // SCP-style SSH: git@github.com:owner/repo[.git]
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1] ?? null;
  }

  // URL-style SSH (with optional port): ssh://[git@]github.com[:port]/owner/repo[.git][/]
  // Also handles git+ssh:// prefix
  const sshUrlMatch = trimmed.match(
    /^(?:git\+)?ssh:\/\/(?:[^@]+@)?github\.com(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (sshUrlMatch) {
    return sshUrlMatch[1] ?? null;
  }

  // HTTPS form (with optional embedded credentials): https://[token@]github.com/owner/repo[.git][/]
  const httpsMatch = trimmed.match(
    /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/
  );
  if (httpsMatch) {
    return httpsMatch[1] ?? null;
  }

  return null;
}

/**
 * Derive the GitHub `owner/repo` slug from the `origin` remote of the given
 * git working directory. Returns null if the remote can't be read or doesn't
 * look like a GitHub URL.
 */
export function deriveRepoFromGit(repoDir: string): string | null {
  const result = execWithPath(["git", "-C", repoDir, "remote", "get-url", "origin"], {
    timeout: GH_GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }
  return parseGitHubRemoteUrl(result.stdout);
}

// ---------------------------------------------------------------------------
// Duplicate-child detection (mt#1435)
//
// Fires on `mcp__minsky__tasks_create` when `parent` is set. The /plan-task
// gate (g) and the session_start sweep both run at the *planning* boundary;
// when an umbrella is decomposed, minutes-to-hours can pass between the gate
// read and the actual `tasks_create` calls, during which a concurrent agent's
// children can land (R6, 2026-06-10: mt#2403-2406 duplicated mt#2397/2398/2399
// under mt#2370). This guard fires at the *mutating action*, so it catches
// concurrent children regardless of that time gap. Also fires on
// `mcp__minsky__tasks_dispatch` in new-task mode (`title` + `parentTaskId`,
// no `taskId`) — the one-call dispatch path creates the subtask in-process,
// bypassing `tasks_create` entirely (mt#2683, mt#2657-round-3 coverage gap).
//
// Enumerates ALL existing children, but treats them by status (mt#2683):
// ACTIVE children (a concurrent decomposition's children are typically still
// TODO/IN-PROGRESS at file-time) can BLOCK; TERMINAL children (DONE/CLOSED/
// COMPLETED — cannot be a concurrent decomposition in flight) only WARN,
// pointing at the re-filing-shipped-work hazard that /plan-task gate (g)(3)
// owns at planning time. Tokens that appear in the PARENT's own title are
// discounted from the overlap count — an epic's children legitimately share
// the epic's vocabulary (mt#2581 FP: "transcript/storage"; mt#2686 FP:
// "conversation"), so parent-title tokens carry no sibling-duplicate signal.
// ---------------------------------------------------------------------------

/** One existing child of the parent being filed under. */
export interface ChildTask {
  id: string;
  title: string;
  status: string;
}

/** A title-overlap hit between the new task and an existing child. */
export interface DuplicateMatch {
  child: ChildTask;
  /** Shared substantive tokens that COUNT toward the threshold. */
  tokens: string[];
  /**
   * Shared tokens discounted as parent-title vocabulary (mt#2683) — reported
   * for transparency in the block message, but not counted.
   */
  discounted?: string[];
}

/** Minimum shared substantive tokens to flag a duplicate. */
export const DUPLICATE_TOKEN_THRESHOLD = 2;

/**
 * Statuses that cannot represent a concurrent decomposition in flight
 * (mt#2683). A terminal sibling match warns instead of blocking.
 */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["DONE", "CLOSED", "COMPLETED"]);

// Latency bounds for the N+1 `tasks get` fetch. The PreToolUse host cap for this
// hook is 30s (.claude/settings.json); blowing it gets the hook SIGTERM'd
// mid-run with inconsistent allow/deny (PR #1660 R1 BLOCKING). These constants
// keep the worst case well under that cap: an overall wall-clock budget hard-
// breaks the loop, a tight per-call timeout bounds any single stuck call, and
// the cap is a secondary ceiling. Worst case ≈ list(2s) + budget(20s) + one
// in-flight call(2s) ≈ 24s < 30s.

/** Hard cap on children fetched per check (secondary to the wall-clock budget). */
export const TASKS_CHILDREN_FETCH_CAP = 25;

/**
 * Per-CLI-call timeout for the dup-guard path. Must clear the `minsky` CLI
 * cold-start (~2s) with headroom, or even the initial `tasks children` call
 * spuriously times out and the guard no-ops. The overall budget below — not
 * this per-call ceiling — is what bounds total wall-clock under the host cap.
 */
export const DUP_GUARD_CLI_TIMEOUT_MS = 4_000;

/** Overall wall-clock budget for the whole dup-guard fetch; the loop hard-breaks past it. */
export const DUP_GUARD_OVERALL_BUDGET_MS = 20_000;

/**
 * 4+-char common English words that carry no disambiguating signal. The
 * 4-char minimum already excludes most stopwords ("the"/"and"/"for"); this set
 * covers the longer ones. Domain nouns (cockpit, shell, session, reviewer, ...)
 * are deliberately NOT stopworded — they ARE the duplicate signal.
 */
export const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  // Common 4-6 char English function words (PR #1660 R1 NON-BLOCKING — a low
  // threshold of 2 means two shared weak words could deny a valid create).
  "with",
  "into",
  "onto",
  "when",
  "where",
  "what",
  "which",
  "while",
  "would",
  "could",
  "should",
  "there",
  "their",
  "these",
  "those",
  "about",
  "before",
  "after",
  "that",
  "this",
  "from",
  "your",
  "have",
  "will",
  "been",
  "being",
  "were",
  "more",
  "most",
  "than",
  "then",
  "them",
  "they",
  "also",
  "such",
  "each",
  "only",
  "over",
  "some",
  "both",
  "very",
  "much",
  "make",
  "made",
  "does",
  "done",
  "here",
  "upon",
  "between",
  "within",
  "without",
  "using",
  "able",
  // Domain-generic words that carry no disambiguating signal for Minsky tasks.
  "task",
  "tasks",
  "minsky",
]);

/** Tokenize a title into lowercase 4+-char non-stopword tokens. */
export function tokenizeTitle(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !TITLE_STOPWORDS.has(raw)) {
      tokens.add(raw);
    }
  }
  return tokens;
}

/** Substantive tokens shared by two titles (set intersection). */
export function titleOverlapTokens(a: string, b: string): string[] {
  const ta = tokenizeTitle(a);
  const tb = tokenizeTitle(b);
  const shared: string[] = [];
  for (const t of ta) {
    if (tb.has(t)) shared.push(t);
  }
  return shared;
}

/**
 * Return the strongest duplicate match (most counted shared tokens) among
 * `children`, or null if none shares ≥ DUPLICATE_TOKEN_THRESHOLD substantive
 * tokens with `newTitle`. Tokens appearing in `opts.parentTitle` are
 * discounted from the count (mt#2683) — epic children legitimately share the
 * epic's vocabulary. Pure — children are passed in.
 */
export function detectDuplicateChild(
  newTitle: string,
  children: ChildTask[],
  opts: { parentTitle?: string } = {}
): DuplicateMatch | null {
  const parentTokens = tokenizeTitle(opts.parentTitle ?? "");
  let best: DuplicateMatch | null = null;
  for (const child of children) {
    const shared = titleOverlapTokens(newTitle, child.title);
    const tokens = shared.filter((t) => !parentTokens.has(t));
    if (tokens.length >= DUPLICATE_TOKEN_THRESHOLD) {
      if (best === null || tokens.length > best.tokens.length) {
        const discounted = shared.filter((t) => parentTokens.has(t));
        best = discounted.length > 0 ? { child, tokens, discounted } : { child, tokens };
      }
    }
  }
  return best;
}

/**
 * Parse child task IDs out of `minsky tasks children <parent>` text output.
 * The format is a header line (`mt#X: N subtask(s)` or `mt#X: no subtasks`)
 * followed by indented `  mt#Y` / `  md#Y` lines. Pure.
 *
 * Tolerant of CLI format drift (PR #1660 R1 NON-BLOCKING): an optional bullet
 * (`-` / `*` / `•`) and any trailing text after the id (e.g. ` — DONE`,
 * ` (IN-PROGRESS)`) are accepted, so a cosmetic CLI change doesn't silently
 * disable the guard by returning an empty list. LEADING WHITESPACE is still
 * required — that's the discriminator that excludes the non-indented header
 * line (`mt#2370: 3 subtask(s)`), which must NOT be parsed as a child.
 */
export function parseChildIdsFromChildrenOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s+(?:[-*•]\s+)?((?:mt|md)#\d+)\b/);
    if (m && m[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * Parse `minsky tasks list --json` into an `id → {title,status}` map. Pure.
 * Tolerant of either a bare array or a `{ tasks: [...] }` envelope; malformed
 * input yields an empty map (callers fall back to per-child gets).
 */
export function parseTaskListJson(stdout: string): Map<string, { title: string; status: string }> {
  const map = new Map<string, { title: string; status: string }>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return map;
  }
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { tasks?: unknown }).tasks)
      ? (parsed as { tasks: unknown[] }).tasks
      : [];
  for (const t of arr) {
    if (t !== null && typeof t === "object") {
      const o = t as { id?: unknown; title?: unknown; status?: unknown };
      if (typeof o.id === "string" && typeof o.title === "string") {
        map.set(o.id, {
          title: o.title,
          status: typeof o.status === "string" ? o.status : "UNKNOWN",
        });
      }
    }
  }
  return map;
}

/**
 * CLI argv for `minsky tasks children --task <parent>`. Exported (mt#2811)
 * so the exact flag shape is unit-testable without invoking the CLI.
 *
 * mt#2811 root-caused a 100%-failure-rate bug on the prior positional-
 * argument form (`minsky tasks children <parent>`): live probe —
 *
 *     $ minsky tasks children mt#2806
 *     error: too many arguments for 'children'. Expected 0 arguments but got 1.
 *     $ echo $?
 *     1
 *
 * `tasks.children`'s parameter map (`tasksChildrenParams` in
 * `src/adapters/shared/commands/tasks/deps-commands.ts`) declares both
 * `taskId` and its legacy alias `task` as OPTIONAL, and — unlike every
 * sibling `tasks.*` command — `tasks-customizations.ts` had no CLI
 * customization registering either as a positional argument (the bridge's
 * auto-promotion only promotes the first REQUIRED param). So Commander
 * rejected the bare positional outright, and `fetchTaskChildren` always
 * returned `null`, which is exactly the observed "could not enumerate
 * children of mt#2766" failure (4/9 `tasks_create` fires, 2026-07-13..15).
 * The `--task` flag form has always worked (confirmed live). This task
 * ALSO fixes the CLI's own positional-arg registration
 * (`src/adapters/cli/customizations/tasks-customizations.ts`) so direct
 * human/CLI use is fixed at the root, not just this guard's callsite — this
 * argv helper additionally hardens the guard against depending on that
 * registration existing/staying correct.
 *
 * DIVERGENCE RISK (mt#2811 R1, PR #1953 review, NON-BLOCKING #5): this argv
 * shape is NOT mechanically bound to `tasksChildrenParams` / the CLI
 * customization — it is a hand-maintained mirror of what was verified live
 * to work. If `--task` is ever renamed or the flag contract changes on the
 * `tasks.children` command, this function will silently start failing again
 * with no compile-time or test-time signal (a hook test binding it to the
 * CLI definition would re-introduce the .minsky/hooks <-> src package-
 * boundary import risk this same review flagged for the prompt-generation
 * contract test — see BLOCKING #2 / `extractScopeConstraintsFiles`'s
 * fixture-based binding above). Mitigation until a lighter-weight binding
 * exists: `buildTasksChildrenArgv`'s unit test
 * (parallel-work-guard.test.ts) locks the exact argv array so an
 * ACCIDENTAL edit to this function is caught immediately, even though an
 * upstream CLI contract change would not be. If this class of drift
 * recurs, the fix is a checked-in CLI-help-output fixture (mirroring the
 * prompt-fixture pattern above), not a live cross-package import.
 */
export function buildTasksChildrenArgv(parent: string): string[] {
  return ["minsky", "tasks", "children", "--task", parent];
}

/**
 * Fetch children of `parent` (id + title + status). Hybrid strategy that avoids
 * the per-child N+1 the reviewer flagged (PR #1660 R1 BLOCKING — ~2s of CLI
 * startup PER `tasks get`):
 *
 *   1. `minsky tasks children --task <parent>` → child IDs (one call).
 *   2. `minsky tasks list --json` → one bulk call resolving every ACTIVE child
 *      (TODO/PLANNING/READY/IN-PROGRESS/IN-REVIEW/BLOCKED) by title+status.
 *   3. Only TERMINAL-state children (DONE/CLOSED/COMPLETED — excluded from the
 *      default list) fall back to a per-child `minsky tasks get <id> --json`,
 *      which is budget-bounded.
 *
 * So the common case is 2 calls regardless of child count; the per-child path
 * runs only for the (usually few) terminal-state children. The whole fetch is
 * bounded by TASKS_CHILDREN_FETCH_CAP and DUP_GUARD_OVERALL_BUDGET_MS so it
 * cannot blow the 30s PreToolUse host cap.
 *
 * Returns null when the children LIST itself can't be read (warn-and-permit
 * upstream). On that failure, the exact CLI exit code + stderr/stdout is
 * written to stderr immediately (mt#2811 loud-degradation requirement) — the
 * caller's "could not enumerate children" skip message names WHAT failed;
 * this is WHY. Unreadable/malformed children are skipped. If the wall-clock
 * budget is hit during the terminal-child fallback, the loop breaks early and
 * a visible `[parallel-work-guard]` warning is written (fail-open-on-budget).
 * The optional `now` injection keeps the budget path deterministically testable.
 */
export function fetchTaskChildren(
  parent: string,
  now: () => number = Date.now
): ChildTask[] | null {
  const startedAt = now();
  const childrenArgv = buildTasksChildrenArgv(parent);
  const listed = execWithPath(childrenArgv, {
    timeout: DUP_GUARD_CLI_TIMEOUT_MS,
  });
  if (listed.exitCode !== 0) {
    process.stderr.write(
      `[parallel-work-guard] GUARD DEGRADED: could not enumerate children of ${parent} — ` +
        `\`${childrenArgv.join(" ")}\` exited ${listed.exitCode}: ` +
        `${(listed.stderr || listed.stdout || "(no output)").trim()}\n`
    );
    return null;
  }

  const ids = parseChildIdsFromChildrenOutput(listed.stdout).slice(0, TASKS_CHILDREN_FETCH_CAP);
  if (ids.length === 0) return [];

  // One bulk call resolves all active children. On failure → empty map, every
  // child falls through to the per-child get path below.
  const listResult = execWithPath(["minsky", "tasks", "list", "--json"], {
    timeout: DUP_GUARD_CLI_TIMEOUT_MS,
  });
  const activeById =
    listResult.exitCode === 0
      ? parseTaskListJson(listResult.stdout)
      : new Map<string, { title: string; status: string }>();

  const children: ChildTask[] = [];
  for (const id of ids) {
    const fromList = activeById.get(id);
    if (fromList) {
      children.push({ id, title: fromList.title, status: fromList.status });
      continue;
    }
    // Terminal-state (or list-missed) child → per-child fallback, budget-bounded.
    if (now() - startedAt >= DUP_GUARD_OVERALL_BUDGET_MS) {
      process.stdout.write(
        `[parallel-work-guard] dup-guard budget (${DUP_GUARD_OVERALL_BUDGET_MS}ms) exhausted after ${children.length}/${ids.length} children of ${parent} — checking the partial set (fail-open-on-budget)\n`
      );
      break;
    }
    const got = execWithPath(["minsky", "tasks", "get", id, "--json"], {
      timeout: DUP_GUARD_CLI_TIMEOUT_MS,
    });
    if (got.exitCode !== 0) continue;
    try {
      const parsed = JSON.parse(got.stdout) as {
        task?: { id?: string; title?: string; status?: string };
      };
      const t = parsed.task;
      if (t && typeof t.title === "string") {
        children.push({
          id: typeof t.id === "string" ? t.id : id,
          title: t.title,
          status: typeof t.status === "string" ? t.status : "UNKNOWN",
        });
      }
    } catch {
      // Malformed JSON for this child — skip it, don't fail the whole check.
    }
  }
  return children;
}

/**
 * Fetch a task's title for the parent-vocabulary discount (mt#2683). One
 * budget-bounded CLI call; null on any failure — no discount, i.e. the
 * conservative pre-mt#2683 matching behavior.
 */
export function fetchTaskTitle(taskId: string): string | null {
  const got = execWithPath(["minsky", "tasks", "get", taskId, "--json"], {
    timeout: DUP_GUARD_CLI_TIMEOUT_MS,
  });
  if (got.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(got.stdout) as { task?: { title?: unknown } };
    return typeof parsed.task?.title === "string" ? parsed.task.title : null;
  } catch {
    return null;
  }
}

/** Structured block message naming the colliding child + overlapping tokens. */
export function formatDuplicateBlockMessage(
  parent: string,
  newTitle: string,
  match: DuplicateMatch
): string {
  const lines: string[] = [];
  lines.push(
    `Parallel-work guard: this new child of ${parent} looks like a DUPLICATE of an existing sibling.`
  );
  lines.push("");
  lines.push(`  New title:      "${newTitle}"`);
  lines.push(
    `  Existing child: ${match.child.id} [${match.child.status}] — "${match.child.title}"`
  );
  lines.push(`  Shared tokens:  ${match.tokens.join(", ")}`);
  if (match.discounted && match.discounted.length > 0) {
    lines.push(
      `  Discounted (parent-title vocabulary, not counted): ${match.discounted.join(", ")}`
    );
  }
  lines.push("");
  lines.push("A concurrent agent may have already decomposed this parent. Before filing, run");
  lines.push(`  minsky tasks children ${parent}`);
  lines.push(
    "and confirm this work isn't already covered. If it is, extend/reference the existing"
  );
  lines.push("child instead of creating a second one.");
  lines.push("");
  lines.push("If this is genuinely a distinct task, override via ONE of:");
  lines.push("  1. Set MINSKY_FORCE_DUPLICATE_OK=1 (only reachable BEFORE the harness launches —");
  lines.push("     an env var set mid-session via Bash never reaches this hook's subprocess).");
  lines.push("  2. Issue a mid-session, reason-mandatory grant (mt#2658 — reachable from inside");
  lines.push("     the current session, unlike option 1):");
  lines.push(
    `     bun scripts/grant-guard-override.ts --guard ${DUPLICATE_CHILD_GUARD_NAME} --scope ${parent} --reason "<why this is distinct>"`
  );
  return lines.join("\n");
}

/**
 * Non-blocking advisory for a token-overlap hit against a TERMINAL sibling
 * (mt#2683). A DONE/CLOSED/COMPLETED sibling cannot be a concurrent agent
 * mid-decomposition — the failure mode this guard blocks on — but the overlap
 * may still mean the new task re-files already-shipped work, which /plan-task
 * gate (g)(3) owns at planning time.
 */
export function formatTerminalSiblingWarning(
  parent: string,
  newTitle: string,
  match: DuplicateMatch
): string {
  return (
    `[parallel-work-guard] NOTE: new child of ${parent} ("${newTitle}") shares tokens ` +
    `[${match.tokens.join(", ")}] with TERMINAL sibling ${match.child.id} ` +
    `[${match.child.status}] — "${match.child.title}". A terminal sibling cannot be a ` +
    `concurrent decomposition, so this does NOT block — but confirm the new task is not ` +
    `re-filing already-shipped work (see /plan-task gate (g)(3)).`
  );
}

/** The decision a tasks_create call resolves to (pure; I/O injected). */
export type DuplicateGuardDecision =
  | {
      action: "skip";
      reason: string;
      /**
       * mt#2811: true iff this skip represents a genuine check FAILURE (the
       * child-enumeration CLI call errored) rather than a normal, expected
       * no-op (no parent — top-level create; no title). The entrypoint uses
       * this to route the message to stderr ("GUARD DEGRADED") only for the
       * genuine-failure case — a top-level create is not a degradation and
       * would be noise on stderr.
       */
      degraded?: boolean;
    }
  | { action: "permit" }
  | { action: "warn"; message: string }
  | { action: "override"; auditMatch: string }
  | { action: "block"; message: string };

/**
 * Parent id for the duplicate-child sweep: `parent` (tasks_create) or
 * `parentTaskId` (tasks_dispatch new-task mode, mt#2683). The two params never
 * co-occur: tasks_create has no `parentTaskId`, and tasks_dispatch rejects
 * `parentTaskId` outside new-task mode. Returns "" when neither is present.
 */
export function resolveDuplicateGuardParent(toolInput: Record<string, unknown>): string {
  if (typeof toolInput["parent"] === "string" && toolInput["parent"]) {
    return toolInput["parent"] as string;
  }
  if (typeof toolInput["parentTaskId"] === "string" && toolInput["parentTaskId"]) {
    return toolInput["parentTaskId"] as string;
  }
  return "";
}

/**
 * tasks_dispatch new-task mode: `title` present, no `taskId` (mt#2683).
 * Existing-task mode (`taskId`) is the open-PR sweep's concern instead.
 */
export function isNewTaskModeDispatch(toolInput: Record<string, unknown>): boolean {
  return typeof toolInput["title"] === "string" && typeof toolInput["taskId"] !== "string";
}

/**
 * Pure decision for the tasks_create duplicate-child guard. `deps.fetchChildren`
 * is injected so this is hermetically testable without invoking the CLI.
 * `deps.fetchParentTitle` (optional) backs the parent-vocabulary discount
 * (mt#2683); it is called LAZILY — only when an undiscounted candidate match
 * exists — so the common permit path pays no extra CLI call.
 */
export function decideTasksCreateGuard(
  toolInput: Record<string, unknown>,
  deps: {
    fetchChildren: (parent: string) => ChildTask[] | null;
    overrideActive: boolean;
    fetchParentTitle?: (parent: string) => string | null;
  }
): DuplicateGuardDecision {
  const parent = resolveDuplicateGuardParent(toolInput);
  if (!parent) {
    return { action: "skip", reason: "no parent — top-level create, nothing to dedup" };
  }
  const title = typeof toolInput["title"] === "string" ? (toolInput["title"] as string) : "";
  if (!title) {
    return { action: "skip", reason: `tasks_create under ${parent} has no title` };
  }

  // Lazy, memoized parent-title lookup: only paid on the rare would-match path.
  let parentTitleFetched = false;
  let parentTitle: string | undefined;
  const getParentTitle = (): string | undefined => {
    if (!parentTitleFetched) {
      parentTitleFetched = true;
      parentTitle = deps.fetchParentTitle
        ? (deps.fetchParentTitle(parent) ?? undefined)
        : undefined;
    }
    return parentTitle;
  };
  const detect = (pool: ChildTask[]): DuplicateMatch | null => {
    if (detectDuplicateChild(title, pool) === null) return null;
    return detectDuplicateChild(title, pool, { parentTitle: getParentTitle() });
  };

  if (deps.overrideActive) {
    // Audit-only path (PR #1859 R1 BLOCKING): no parent-title fetch, no
    // discount — a single undiscounted detection keeps the override
    // side-effect-free (no extra CLI call) and the audited match id
    // deterministic regardless of parent-title availability.
    const children = deps.fetchChildren(parent) ?? [];
    const match = detectDuplicateChild(title, children);
    return { action: "override", auditMatch: match ? match.child.id : "none" };
  }

  const children = deps.fetchChildren(parent);
  if (children === null) {
    return {
      action: "skip",
      reason:
        `could not enumerate children of ${parent} — the duplicate-child overlap check is ` +
        `SKIPPED for this create (see stderr for the CLI failure detail)`,
      degraded: true,
    };
  }

  const activeMatch = detect(children.filter((c) => !TERMINAL_TASK_STATUSES.has(c.status)));
  if (activeMatch) {
    return { action: "block", message: formatDuplicateBlockMessage(parent, title, activeMatch) };
  }

  const terminalMatch = detect(children.filter((c) => TERMINAL_TASK_STATUSES.has(c.status)));
  if (terminalMatch) {
    return { action: "warn", message: formatTerminalSiblingWarning(parent, title, terminalMatch) };
  }

  return { action: "permit" };
}

// ---------------------------------------------------------------------------
// Override resolution — env var + grant-file channel (Phase-7 adjunct, mt#2658)
// ---------------------------------------------------------------------------

/**
 * This guard's name in the grant-file channel (`.minsky/hooks/guard-grant-
 * store.ts`) — mt#2658's tracking task and originating incident. NOT
 * dispatcher-migrated (this hook remains a standalone `PreToolUse`
 * registration, matched directly in `.claude/settings.json`), so it is not
 * part of `GUARD_REGISTRY` — but `checkOverride()` (imported from
 * `./dispatcher`) is a plain exported function usable outside the
 * dispatcher's own `runDispatcher()` loop, and this guard uses it directly
 * for BOTH the unified `MINSKY_HOOK_OVERRIDE` env var (a bonus — this guard
 * previously only recognized its own bespoke `MINSKY_FORCE_DUPLICATE_OK`)
 * and the new grant-file channel.
 */
export const DUPLICATE_CHILD_GUARD_NAME = "duplicate-child-matcher";

/**
 * The `checkOverride()`-known-guard-names universe for this guard's calls:
 * the live `GUARD_REGISTRY` names, plus this guard's own name (which isn't
 * itself a dispatcher registration). Without this, an operator correctly
 * setting `MINSKY_HOOK_OVERRIDE=duplicate-child-matcher` would still be
 * honored (the match check doesn't consult `knownGuardNames`), but would
 * ALSO get a spurious "does not match any registered guard name" stderr
 * warning — this constant prevents that false-typo signal.
 */
const KNOWN_GUARD_NAMES_WITH_SELF: readonly string[] = [
  ...GUARD_REGISTRY.map((r) => r.name),
  DUPLICATE_CHILD_GUARD_NAME,
];

/** Resolution of whether the duplicate-child guard's override is active, and why. */
export type DuplicateGuardOverrideResolution =
  | { active: false }
  | { active: true; source: "env"; reason?: undefined }
  | { active: true; source: "grant"; reason: string | undefined };

/**
 * Pure decision (given an injected `checkOverrideFn`) for whether the
 * duplicate-child guard's override is active, and — when it is — whether
 * that came from an env var (the legacy `MINSKY_FORCE_DUPLICATE_OK=1`, OR
 * the unified `MINSKY_HOOK_OVERRIDE=duplicate-child-matcher` that
 * `checkOverrideFn` also recognizes) or a grant-file match (mt#2658).
 * `parent` is the scope qualifier for the grant-file lookup; when absent
 * (no parent on the `tasks_create` call), the grant-file channel cannot be
 * consulted (there is nothing to scope the grant to) — only the env-var
 * channels are checked.
 *
 * `checkOverrideFn`'s `OverrideResult` conflates two provenances behind one
 * `overridden: true` — `grantReason` is present ONLY for a grant-file match
 * (`.minsky/hooks/guard-grant-store.ts` grants always carry a mandatory
 * `reason`); an env-var-sourced override (either channel) never sets it. So
 * `result.grantReason !== undefined` is the correct discriminator for
 * `source` below — NOT "did `checkOverrideFn` return `overridden: true`,"
 * which would mislabel a `MINSKY_HOOK_OVERRIDE`-sourced hit as `"grant"`.
 *
 * `checkOverrideFn` is injected so this stays hermetically testable without
 * touching the filesystem (mirrors `decideTasksCreateGuard`'s
 * `fetchChildren` injection pattern).
 */
export function resolveDuplicateGuardOverride(
  parent: string | undefined,
  env: NodeJS.ProcessEnv,
  checkOverrideFn: (
    guardName: string,
    env: NodeJS.ProcessEnv,
    options?: { knownGuardNames?: readonly string[]; scope?: string }
  ) => OverrideResult = checkOverride
): DuplicateGuardOverrideResolution {
  if (env["MINSKY_FORCE_DUPLICATE_OK"] === "1") {
    return { active: true, source: "env" };
  }

  const result = checkOverrideFn(DUPLICATE_CHILD_GUARD_NAME, env, {
    knownGuardNames: KNOWN_GUARD_NAMES_WITH_SELF,
    scope: parent,
  });
  if (result.overridden && result.grantReason !== undefined) {
    return { active: true, source: "grant", reason: result.grantReason };
  }
  if (result.overridden) {
    return { active: true, source: "env" };
  }
  return { active: false };
}

/** Entrypoint wrapper: resolve the decision and map it to hook output. */
function runTasksCreateGuard(input: ToolHookInput): void {
  // Observability (PR #1660 R1 BLOCKING): any unexpected throw is surfaced on
  // stderr and then fails OPEN (permit). A silent crash on the deny path would
  // otherwise create block/allow ambiguity. The latency-bound budget above
  // means the host should not SIGTERM us mid-run; this catch covers logic
  // exceptions, not the host timeout.
  try {
    runTasksCreateGuardInner(input);
  } catch (err) {
    process.stderr.write(
      `[parallel-work-guard] tasks_create dup-guard errored — failing open (permit): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

function runTasksCreateGuardInner(input: ToolHookInput): void {
  const parentForScope = resolveDuplicateGuardParent(input.tool_input) || undefined;
  const overrideResolution = resolveDuplicateGuardOverride(parentForScope, process.env);
  const decision = decideTasksCreateGuard(input.tool_input, {
    fetchChildren: (parent) => fetchTaskChildren(parent),
    overrideActive: overrideResolution.active,
    fetchParentTitle: (parent) => fetchTaskTitle(parent),
  });

  switch (decision.action) {
    case "skip":
      if (decision.degraded) {
        // mt#2811 loud degradation: a real check failure (child-enumeration
        // CLI call errored), not a routine no-op — stderr, not stdout.
        process.stderr.write(
          `[parallel-work-guard] GUARD DEGRADED (tasks_create dedup skipped): ${decision.reason}\n`
        );
      } else {
        process.stdout.write(
          `[parallel-work-guard] tasks_create dedup skipped — ${decision.reason}\n`
        );
      }
      return;
    case "warn":
      // stdout for log-grep compatibility; additionalContext so host UIs
      // that only surface hookSpecificOutput content still see the advisory
      // (mirrors the open-PR sweep's permit-with-warnings path, PR #1859 R1).
      process.stdout.write(`${decision.message}\n`);
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: decision.message,
        },
      });
      return;
    case "override": {
      const parent = parentForScope ?? "";
      const title = typeof input.tool_input["title"] === "string" ? input.tool_input["title"] : "";
      const ts = new Date().toISOString();
      const source = overrideResolution.active ? overrideResolution.source : "env";
      const reasonPart =
        overrideResolution.active &&
        overrideResolution.source === "grant" &&
        overrideResolution.reason
          ? ` reason="${overrideResolution.reason}"`
          : "";
      process.stdout.write(
        `[parallel-work-guard] override fired: parent=${parent}, title="${title}", duplicate_match=${decision.auditMatch} source=${source}${reasonPart} ts=${ts}\n`
      );
      return;
    }
    case "block":
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.message,
        },
      });
      return;
    case "permit":
      return;
  }
}

// ---------------------------------------------------------------------------
// session_start / tasks_dispatch (existing-task mode) open-PR-sweep routing
// (mt#2657 R3 fix, PR #1837 review 4651664356)
//
// `tasks_dispatch` in existing-task mode (a `taskId` param present) walks the
// task's status to READY and calls `SessionService.start()` IN-PROCESS — the
// same session-binding action `session_start` performs as a top-level tool
// call. Before this fix, the open-PR sweep's PreToolUse matcher covered only
// `mcp__minsky__session_start`, so a one-call dispatch of an existing task
// could bind a session without ever running the open-PR file-overlap check —
// silently weakening this guard for the collapsed dispatch path, in
// violation of mt#2657's spec ("honoring ALL existing guards in-band").
//
// Fix mirrors `check-task-spec-read.ts`'s DISPATCH_TOOL approach: the guard
// now also matches `mcp__minsky__tasks_dispatch`, but ONLY in existing-task
// mode. New-task mode (`title`, no `taskId`) creates a fresh task in-call —
// there is nothing PRE-EXISTING for this sweep to compare against, so it
// resolves to "" and is skipped (same pass-through semantics as the
// spec-read guard's new-task-mode carve-out).
// ---------------------------------------------------------------------------

export const DISPATCH_TOOL_NAME = "mcp__minsky__tasks_dispatch";

/**
 * Resolve the target taskId for the open-PR sweep from a `session_start` or
 * existing-task-mode `tasks_dispatch` tool call. Returns "" for any other
 * tool, or for `tasks_dispatch` new-task mode (no `taskId`) — both cases the
 * caller treats as "skip, nothing to check."
 */
export function resolveSessionStartLikeTaskId(input: ToolHookInput): string {
  if (input.tool_name === "mcp__minsky__session_start") {
    // The MCP `session_start` tool exposes its task identifier as `task`. We
    // also accept `taskId` for forward compatibility in case the surface is
    // renamed; whichever is present wins.
    return (
      (input.tool_input.task as string | undefined) ??
      (input.tool_input.taskId as string | undefined) ??
      ""
    );
  }
  if (input.tool_name === DISPATCH_TOOL_NAME) {
    return (input.tool_input.taskId as string | undefined) ?? "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // tasks_create with a parent → duplicate-child guard (mt#1435). Fires at the
  // mutating action, upstream of where session_start would catch it.
  if (input.tool_name === "mcp__minsky__tasks_create") {
    runTasksCreateGuard(input);
    process.exit(0);
  }

  // tasks_dispatch NEW-TASK mode (`title`, no `taskId`) creates the subtask
  // IN-PROCESS — no top-level tasks_create call ever fires, so the duplicate-
  // child matcher must run on the dispatch call itself (mt#2683, closing the
  // mt#2657-round-3 coverage gap). `resolveDuplicateGuardParent` reads
  // `parentTaskId`; without it the guard skips (root create, nothing to dedup).
  // Existing-task mode falls through to the open-PR sweep below.
  if (input.tool_name === DISPATCH_TOOL_NAME && isNewTaskModeDispatch(input.tool_input)) {
    runTasksCreateGuard(input);
    process.exit(0);
  }

  // session_start (the original Tier-3 ceiling) OR tasks_dispatch existing-task
  // mode (mt#2657 R3 fix) — both bind a session from a taskId and must run the
  // SAME open-PR sweep. Any other tool exits here.
  if (input.tool_name !== "mcp__minsky__session_start" && input.tool_name !== DISPATCH_TOOL_NAME) {
    process.exit(0);
  }

  const taskId = resolveSessionStartLikeTaskId(input);
  if (!taskId) {
    // No task identifier (session_start) or new-task-mode tasks_dispatch
    // (nothing pre-existing to check) — can't/needn't run the check; allow.
    process.stdout.write(
      `[parallel-work-guard] No resolvable existing-task id for ${input.tool_name} — check skipped\n`
    );
    process.exit(0);
  }

  // Check for override env var
  const forceParallel = process.env["MINSKY_FORCE_PARALLEL"];
  if (forceParallel === "1") {
    // Audit-log the override
    const ts = new Date().toISOString();
    process.stdout.write(
      `[parallel-work-guard] OVERRIDE active (MINSKY_FORCE_PARALLEL=1) — task=${taskId} ts=${ts}\n`
    );
    process.exit(0);
  }

  // Resolve in-scope files (mt#2811: prefers tasks_dispatch's own `scope`
  // param over spec parsing — see resolveInScopeFiles docstring).
  const resolved = resolveInScopeFiles(input.tool_name, input.tool_input, fetchTaskSpec, taskId);

  if (resolved.files.length === 0) {
    // mt#2811 R1 (PR #1953 review, BLOCKING #3): only report LOUD (stderr,
    // "GUARD DEGRADED") for a GENUINE failure — see shouldReportAsGuardDegraded.
    // A routine "this spec has no scope structure at all" resolution stays
    // quiet on stdout, matching pre-mt#2811 behavior — that was never the
    // regression this task fixes, and making every such dispatch noisy on
    // stderr would be its own new failure mode.
    const degraded = shouldReportAsGuardDegraded(resolved);
    const prefix = degraded ? "GUARD DEGRADED: " : "";
    const stream = degraded ? process.stderr : process.stdout;
    if (resolved.warnings.length > 0) {
      for (const w of resolved.warnings) {
        stream.write(`[parallel-work-guard] ${prefix}${w}\n`);
      }
    } else {
      stream.write(
        `[parallel-work-guard] ${prefix}no in-scope files resolved for ${taskId} ` +
          `(source=${resolved.source}) — parallel-work file-overlap check SKIPPED\n`
      );
    }
    process.exit(0);
  }

  // Extraction succeeded (possibly via a fallback strategy) — surface how on
  // stdout (informational: the check DOES run).
  if (resolved.source === "dispatch-scope-param") {
    process.stdout.write(
      `[parallel-work-guard] Using tasks_dispatch 'scope' parameter directly ` +
        `(${resolved.files.length} file(s)) — spec parse skipped\n`
    );
  }
  for (const w of resolved.warnings) {
    process.stdout.write(`[parallel-work-guard] ${w}\n`);
  }

  const inScopeFiles = resolved.files;

  const repoDir = input.cwd;

  // Derive repo slug from git remote rather than hardcoding. If derivation
  // fails (non-github remote, or no remote), warn and allow — this is the
  // same fail-open posture as the rest of the hook.
  const repo = deriveRepoFromGit(repoDir);
  if (!repo) {
    process.stdout.write(
      `[parallel-work-guard] Could not derive owner/repo from git remote — check skipped\n`
    );
    process.exit(0);
  }

  // Detect the actual current branch — the only own-branch signal used by
  // isOwnBranch (exact equality). If the probe fails, currentBranch is null
  // and all open PRs will be treated as peers (no skipping).
  const branchProbe = execWithPath(["git", "-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeout: GH_GIT_TIMEOUT_MS,
  });
  const currentBranch =
    branchProbe.exitCode === 0 && branchProbe.stdout.trim() ? branchProbe.stdout.trim() : null;

  const checkInput: ParallelWorkCheckInput = {
    taskId,
    inScopeFiles,
    repo,
    lookbackHours: 24,
  };

  const result = runParallelWorkChecks(checkInput, repoDir, currentBranch);

  for (const w of result.warnings) {
    process.stdout.write(`[parallel-work-guard] ${w}\n`);
  }

  if (result.blocked) {
    const actionLabel =
      input.tool_name === DISPATCH_TOOL_NAME ? "one-call-dispatching" : "session_start";
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: formatBlockMessage(taskId, result.collisions, actionLabel),
      },
    });
    process.exit(0);
  }

  // When permitting (not blocking), include any aggregated warnings in
  // hookSpecificOutput.additionalContext so host UIs that only surface
  // hookSpecificOutput content (not stdout) still see them. stdout is kept
  // for log-grep compatibility.
  if (result.warnings.length > 0) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: result.warnings.map((w) => `[parallel-work-guard] ${w}`).join("\n"),
      },
    });
  }

  process.exit(0);
}
