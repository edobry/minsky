#!/usr/bin/env bun
/**
 * Coverage-claim path detector (mt#4426) — calibration-first, log-only.
 *
 * Fires at AUTHORING time: when a write tool is about to put a comment into a
 * file, this checks whether that comment CLAIMS coverage (or a convention, or a
 * precedent) at a path that does not resolve. The matcher and every
 * false-positive discrimination live in `./coverage-claim-path`; this module is
 * the hook plumbing around it.
 *
 * ## Why write-time rather than a repo sweep
 *
 * Both surfaces are legitimate and they answer different questions. A sweep
 * finds the standing stock — and one is shipped as
 * `scripts/measure-coverage-claim-paths.ts`, which is how this detector's
 * false-positive rate was measured. But the RFC governing this family
 * (`383937f0`, Accepted 2026-06-25) requires a coverage receipt to graduate: "a
 * detector hook is not 'done' until its calibration log shows a real fire …
 * each calibration entry carries `source: "live" | "synthetic"`". A sweep run on
 * demand produces synthetic-shaped evidence about a corpus; a write-time hook
 * produces live fires on the claims agents are actually writing, which is the
 * population the done-gate is about.
 *
 * ## WHICH tree it asks, and why that is the whole difficulty (mt#4674)
 *
 * "Does this cited path resolve?" is meaningless without naming a tree, and this
 * hook fires on `session_*` writes as well as `Edit`/`Write`. A session write
 * lands in a Minsky session workspace while the MCP call is made from a
 * conversation standing in the MAIN repo — so `input.cwd` names one tree and the
 * write goes to another. Resolution therefore follows the TOOL INPUT's
 * `sessionId` (see {@link resolveTargetWorkspaceRoot}), never the process cwd.
 *
 * The two consumers of a "root" in this module deliberately use DIFFERENT ones:
 * the cited-path check follows the write into its session workspace, while the
 * calibration log is pinned to the hook's own install root so it cannot be
 * written into a clone that merge-cleanup deletes. Per mem#797, enumerate every
 * consumer before changing either.
 *
 * ## Posture: log-only, and deliberately so
 *
 * Returns `null` on every path — it never denies and never injects. Per ADR-024
 * the ladder's cheapest rung ships first and climbs only on measured
 * insufficiency, and per this task's Scope a flip to live is a separate
 * disposition through `/calibration-review`'s Ask path, not a decision this
 * change makes. The measured precision (21 of 22 fires real, corpus-wide) is
 * the input to that decision, not a licence to skip it.
 *
 * @see mt#4426 — this task
 * @see .minsky/hooks/coverage-claim-path.ts — the matcher and its measured discriminations
 * @see scripts/measure-coverage-claim-paths.ts — the corpus instrument
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 */

import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, isAbsolute, relative } from "node:path";
import { findUnresolvedCoverageClaims } from "./coverage-claim-path";
import { findRepoRoot, deriveHookRepoRoot, readInput } from "./types";
import { deriveSessionWorkspaceRoot } from "./require-session-for-main-workspace-edits";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";

/** This detector's calibration log — declared in `.minsky/hooks/registry.ts`. */
const CALIBRATION_LOG = ".minsky/coverage-claim-path-calibration.jsonl";

/**
 * Record-shape version (mt#3607 convention).
 *
 * Present because `calibration-review` derives `judgedText.recoverability` from
 * `captureSchema` ALONE: a log that omits it is reported `unrecoverable`, 0-of-N
 * captured, and becomes a permanent HOLD that can never be dispositioned —
 * measured on three existing logs by mt#4465. Writing it from the first record
 * means this log is never born into that trap.
 */
const CAPTURE_SCHEMA = 1;

/** Upper bound on a scanned payload — see the skip in `run` for why it exists. */
const MAX_SCANNED_CHARS = 2_000_000;

/** Tool inputs that carry a file path plus the content about to be written. */
interface WriteLikeInput {
  path?: unknown;
  file_path?: unknown;
  content?: unknown;
  new_string?: unknown;
  replace?: unknown;
  instructions?: unknown;
}

/**
 * The workspace this write actually LANDS IN — which is not always the one the
 * hook process is standing in (mt#4674).
 *
 * `findRepoRoot(input.cwd)` answers "which repo is the invoking process standing
 * in", and `types.ts` documents that as "right for a target path the caller
 * supplied". For `Edit`/`Write` it is exactly right. For the `session_*` tools it
 * is exactly WRONG: those take a path relative to a Minsky SESSION workspace,
 * while the MCP call is made from a conversation whose cwd is the MAIN repo. So
 * the write lands in the session clone and the existence check interrogates main.
 *
 * Measured, 2026-08-27 — the two fires that were this detector's entire live
 * record, and both false. A session wrote
 * `packages/domain/src/agent-identity/live-conversation.ts` at 01:37:12Z, then
 * two files citing it at 01:37:54Z and 01:38:34Z. The module was present in the
 * session workspace the whole time; it reached main only at the merge, 02:17:53Z.
 * Both citations were correct and both were recorded as dead pointers.
 *
 * The error runs in BOTH directions, and the silent one is worse: a session that
 * DELETES a file and then cites the old path resolves it against main, where it
 * still exists, and records nothing — the detector goes quiet exactly as a dead
 * pointer is being authored. `coverage-claim-path.ts` already names a false
 * negative as this detector's dangerous direction.
 *
 * Returns `null` when the tool input names a session workspace that does not
 * exist. A log-only detector must not manufacture a finding out of its own
 * inability to locate the tree.
 *
 * `sessionsRoot`/`exists` are injectable so the resolution is testable without a
 * real session workspace on disk.
 */
export function resolveTargetWorkspaceRoot(
  toolInput: unknown,
  cwd: string,
  sessionsRoot: string = deriveSessionWorkspaceRoot(),
  exists: (p: string) => boolean = existsSync
): string | null {
  const sessionId =
    toolInput && typeof toolInput === "object"
      ? (toolInput as { sessionId?: unknown }).sessionId
      : undefined;

  if (typeof sessionId === "string" && sessionId.length > 0) {
    // A sessionId is a single directory NAME, so anything that could make it a
    // path is out (PR #3409 R1). Unvalidated, `../../etc` would turn this
    // function into a cross-tree existence oracle — the same "ask the wrong
    // tree" defect this module exists to fix, pointed at an attacker-chosen
    // root instead of merely the wrong one. Log-only does not help: the
    // findings are written to a file, so the layout still leaks.
    //
    // Checked two ways deliberately. The segment test states the intent
    // ("this is a name, not a path") and is not format-bound: the observed ids
    // are UUIDs, but `sessionId` is documented as accepting a task id too, so
    // pinning a UUID shape would silently drop coverage rather than attacks.
    // The containment test is the one that actually holds if the first is ever
    // loosened.
    if (!isSingleSegment(sessionId)) return null;

    const base = resolve(sessionsRoot);
    const sessionRoot = resolve(base, sessionId);
    if (!isContainedIn(sessionRoot, base)) return null;

    return exists(sessionRoot) ? sessionRoot : null;
  }

  return findRepoRoot(cwd);
}

/** A single path NAME — no separators, no `.`/`..` traversal segments. */
export function isSingleSegment(value: string): boolean {
  return !/[/\\]/.test(value) && value !== "." && value !== "..";
}

/**
 * `child` is `parent` itself, or strictly beneath it.
 *
 * Used at every point where a caller-supplied string becomes part of a path this
 * module then probes — the session root, the write target, and each cited
 * candidate. The third is not hypothetical, and was verified rather than
 * assumed: `PATH_PATTERN` admits `.` and `-`, so a comment citing
 * `src/../../etc/shadow.ts` matches and reaches the existence probe. The
 * extension is what makes it reachable — the matcher trims a cited path at its
 * extension, so an extensionless `.../etc/passwd` matches nothing.
 */
export function isContainedIn(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The existence probe the matcher is handed: resolve a cited candidate against
 * `root`, and answer NO for anything that escapes it (PR #3409 R1).
 *
 * Treating an escaping candidate as non-existent is the right answer on both
 * axes — nothing outside the tree can satisfy a claim about this tree, and the
 * probe never leaves it, so the detector cannot be used as a cross-tree
 * existence oracle.
 *
 * Exported as its own unit rather than inlined in `run()` so a test exercises
 * THIS implementation instead of a hand-mirrored copy of it. The first version
 * of the containment test did mirror it, and passed against an unguarded probe.
 */
export function containedExistenceCheck(
  root: string,
  exists: (p: string) => boolean = existsSync
): (candidate: string) => boolean {
  return (candidate) => {
    const absolute = resolve(root, candidate);
    return isContainedIn(absolute, root) && exists(absolute);
  };
}

/**
 * The target path and the text being written, when the tool input carries both.
 *
 * `root` is the workspace the write lands in ({@link resolveTargetWorkspaceRoot}),
 * not the invoking process's cwd.
 */
export function extractWriteTarget(
  toolInput: unknown,
  root: string
): { repoRelativePath: string; text: string } | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const raw = toolInput as WriteLikeInput;

  const rawPath = typeof raw.path === "string" ? raw.path : raw.file_path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;

  // Only the content-bearing fields — an `instructions` string describes an edit
  // rather than being one, and scanning it would attribute a claim to a file
  // that never received it.
  const text = [raw.content, raw.new_string, raw.replace]
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  if (text.length === 0) return null;

  // A session tool's path is relative to the session workspace; an absolute path
  // is already anchored. Resolving a relative path against `root` rather than
  // `cwd` is what keeps a session write addressed to the tree it lands in.
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);

  // A path outside the workspace has no package root to resolve claims against.
  if (!isContainedIn(absolute, root)) return null;

  return { repoRelativePath: relative(root, absolute), text };
}

function appendCalibrationRecord(record: Record<string, unknown>): void {
  try {
    // The hook's OWN install root, not anything derived from `cwd` (mt#4674).
    //
    // This is the SECOND consumer of a root in this module, and it needs a
    // DIFFERENT one from the existence check above — which is the whole lesson
    // of mt#3393 (mem#797): "when a hook resolves a root from cwd, enumerate
    // every consumer of that root before scoping the fix." The cited-path check
    // must follow the write into its session workspace; this log must stay put.
    //
    // `findRepoRoot(cwd)` (mt#2710) fixed the cwd-is-a-subdirectory case and
    // cannot fix the session-workspace one, because a session workspace IS a
    // repo root — so `findRepoRoot` resolves there happily and the log lands in
    // a clone that merge-cleanup deletes, invisible to the coverage-receipt
    // done-gate. mt#3393 lost 22 calibration records exactly that way.
    // `deriveHookRepoRoot()` walks up from this module's own directory instead,
    // and the executing copy is always the one checked into the main workspace.
    const logPath = resolve(deriveHookRepoRoot(), CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[coverage-claim-path-detector] Failed to write calibration log: ${msg}\n`
    );
  }
}

export async function run(
  input: ClaudeHookInput,
  _ctx: DispatchContext
): Promise<GuardOutcome | null> {
  const cwd = input.cwd ?? process.cwd();
  const toolInput = (input as { tool_input?: unknown }).tool_input;

  // Which TREE this write lands in, before asking that tree any question.
  // `null` means the input named a session workspace we cannot locate — record
  // nothing rather than resolving claims against the wrong tree (mt#4674).
  const root = resolveTargetWorkspaceRoot(toolInput, cwd);
  if (root === null) return null;

  const target = extractWriteTarget(toolInput, root);
  if (!target) return null;

  // Only TypeScript-ish sources carry the comment syntax the matcher scans.
  if (!/\.(ts|tsx|js|jsx)$/.test(target.repoRelativePath)) return null;

  // Bound the worst case rather than trusting the 10s host timeout (PR #3399
  // R1, non-blocking). The scan is a single char-by-char pass plus a couple of
  // `existsSync` calls per finding, so it is fast on anything hand-written —
  // but a machine-generated payload has no natural ceiling, and a log-only
  // detector must never be the reason a write is slow. The largest source file
  // in this repo is comfortably under this; skipping is the right failure for a
  // recorder, since a missed record costs nothing a later sweep cannot recover.
  if (target.text.length > MAX_SCANNED_CHARS) return null;

  const findings = findUnresolvedCoverageClaims(
    target.text,
    target.repoRelativePath,
    containedExistenceCheck(root)
  );

  if (findings.length > 0) {
    appendCalibrationRecord({
      timestamp: new Date().toISOString(),
      session_id: input.session_id ?? null,
      // Required by the RFC's coverage-receipt done-gate: a hook graduates on
      // >= 1 `source: "live"` true positive within 7 days of ship.
      source: "live",
      captureSchema: CAPTURE_SCHEMA,
      citingFile: target.repoRelativePath,
      findingCount: findings.length,
      findings: findings.map((f) => ({
        citedPath: f.citedPath,
        claimPhrase: f.claimPhrase,
        line: f.line,
        context: f.context,
      })),
    });
  }

  // Log-only. See the posture note in this module's header before changing it.
  return null;
}

/**
 * Standalone entry point.
 *
 * Wired in `.claude/settings.json` alongside `check-generated-file-edit` on the
 * same write-tool matcher, rather than through `GUARD_REGISTRY`, because that is
 * where this repo's write-time guards live. It emits NO hook output on any path
 * — a log-only detector must not spend the agent's attention — so the process
 * simply exits 0 after the record is (or is not) written.
 */
export async function main(): Promise<void> {
  try {
    const input = await readInput();
    await run(input as ClaudeHookInput, {} as DispatchContext);
  } catch (err) {
    // Fail open, loudly on stderr only. A detector that cannot read its input
    // has learned nothing; blocking a write over it would be strictly worse
    // than the stale pointer it exists to notice.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[coverage-claim-path-detector] skipped: ${msg}\n`);
  }
}

if (import.meta.main) {
  await main();
}
