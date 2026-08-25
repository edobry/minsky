#!/usr/bin/env bun
// PostToolUse hook on Bash: surface tracked files in the MAIN workspace that
// became modified during the call, so a mutation that should have gone to a
// session workspace is noticed immediately rather than incidentally (mt#2358).
//
// ## Why an OUTCOME check and not a command parser
//
// The obvious mechanism — match destructive verbs in the command string — is
// what mt#2358 originally specified, and it would NOT have fired on the
// recurrence that reopened the task. Those mutations were `sed -i`, `cat >>`
// (an append, not a truncation) and `python3` heredocs calling `open(p, "w")`.
// None is in any plausible verb list, and a heredoc that writes a file is not
// statically distinguishable from one that prints. Reading git STATE catches
// every mutation style, including ones nobody has thought of, because it asks
// what HAPPENED rather than what was typed.
//
// ## Why this channel is uncovered
//
// `require-session-for-main-workspace-edits.ts` (mt#1103) is the same-class
// guard and it denies main-workspace edits — but its `FILE_EDITING_TOOLS` set is
// `{Edit, Write, NotebookEdit}`, so a Bash call returns un-denied immediately.
// Meanwhile the harness's auto mode instructs agents to "make file changes with
// sed, heredocs, or short scripts, rather than using the dedicated Read, Edit,
// or Write tools" — routing mutations to precisely the channel that guard cannot
// see. That is a harness-level instruction we do not own, so covering the
// channel is the available fix rather than a symptom patch.
//
// ## Why the failure has no other signal
//
// Both workspaces are clones with identical trees, so a relative path resolves
// successfully in BOTH and the mistake produces no error. Worse, the follow-up
// verification cannot discriminate: in the originating incident a typecheck and
// the full suite both passed, because the session was internally consistent. Every
// check was equally consistent with the right and the wrong outcome — the
// can't-fail-probe shape (`claim-confidence.mdc`). Detection happened only when an
// appended test block failed to appear in a session test run.
//
// ## The baseline diff is what makes this usable
//
// A bare `git status` reports every file dirty for ANY reason, including the
// modifications already present before the turn started (three in this repo at
// implementation time). Re-flagging those on every Bash call would make the
// observer noise and nothing else. So the fired set is the DIFF against the last
// observation: a file flags at most once — on the call that dirties it.
//
// This also removes the need to detect whether a session is active, which
// mt#2358's own Scope had flagged as possibly not cheap. What the diff does not
// remove is a DELIBERATE main-workspace edit; that is the residual
// false-positive class, and it is why this is advisory with a log rather than a
// block.
//
// ## Untracked files are exempt, deliberately
//
// Legitimate main-workspace scratch and log writes exist and were present during
// the originating incident itself. Flagging them would bury the signal.
//
// @see mt#2358 — this hook
// @see .minsky/hooks/require-session-for-main-workspace-edits.ts — the Edit/Write half

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { readInput, writeOutput, deriveHookRepoRoot } from "./types";
import type { ToolHookInput } from "./types";
import { recordFireLogEntry } from "./fire-log";

/** This guard's fire-log identifier. */
const GUARD_NAME = "warn-main-workspace-mutation";

/** Where the last-observed modified-tracked set is kept, relative to the repo root. */
export const BASELINE_RELATIVE_PATH = ".minsky/main-workspace-mutation-baseline.json";

/**
 * Parse `git status --porcelain=v1` into the set of TRACKED paths that are
 * currently modified, added, renamed or deleted.
 *
 * Untracked entries (`??`) are excluded per the module docblock. Ignored
 * entries (`!!`) never appear without `--ignored` but are excluded defensively.
 *
 * Porcelain v1 lines are `XY <path>`, where a rename is `R  old -> new`; the
 * NEW path is what a reader needs, so the arrow is split on and the right side
 * kept. Paths containing spaces are handled because the split is on the first
 * two status characters plus one space, not on whitespace generally.
 *
 * Pure — the caller supplies the text — so every branch is assertable without a
 * git repository.
 */
export function parseModifiedTracked(porcelain: string): string[] {
  const out: string[] = [];
  for (const rawLine of porcelain.split("\n")) {
    if (rawLine.length < 4) continue;
    const status = rawLine.slice(0, 2);
    if (status === "??" || status === "!!") continue;
    let path = rawLine.slice(3).trim();
    if (path === "") continue;
    // A rename/copy renders as `old -> new`; the new path is the live one.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    // Porcelain quotes paths containing unusual characters; strip the quotes so
    // the reported path matches what a user would type.
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
      path = path.slice(1, -1);
    }
    if (path !== "") out.push(path);
  }
  return out;
}

/** What one observation decided. */
export interface MutationDecision {
  readonly fired: boolean;
  /** Files that became modified during this call — the newly-dirty set. */
  readonly newlyModified: string[];
  /** The set to persist as the next baseline. */
  readonly nextBaseline: string[];
  readonly message?: string;
}

/**
 * Decide what to report, given the previous observation and the current one.
 *
 * The fired set is `current \ previous` — files that were clean (or absent from
 * the last look) and are dirty now. `previous \ current` is not reported: a file
 * going clean is a `git_restore`, which is the repair this advisory asks for.
 *
 * `previousBaseline === null` means no baseline has been written yet — the first
 * observation on a fresh checkout or after the state file is removed. That case
 * reports NOTHING and simply records the baseline, because everything dirty at
 * that moment predates the observer and flagging it would be the exact noise the
 * diff exists to remove.
 *
 * Pure, so the first-run case and the steady-state case are both assertable
 * without touching a repository.
 */
export function decideMutation(
  previousBaseline: readonly string[] | null,
  current: readonly string[]
): MutationDecision {
  const nextBaseline = [...current].sort();

  if (previousBaseline === null) {
    return { fired: false, newlyModified: [], nextBaseline };
  }

  const seen = new Set(previousBaseline);
  const newlyModified = current.filter((p) => !seen.has(p)).sort();
  if (newlyModified.length === 0) {
    return { fired: false, newlyModified: [], nextBaseline };
  }

  return {
    fired: true,
    newlyModified,
    nextBaseline,
    message: buildAdvisory(newlyModified),
  };
}

/**
 * The advisory text.
 *
 * Names the REPAIR, not just the problem: in the originating incident the fix
 * took three calls once noticed, and an advisory that only reports leaves the
 * reader to rediscover them. It also names the legitimate case explicitly,
 * because a deliberate main-workspace edit is the residual false positive and a
 * detector that assumes every fire is a mistake trains its reader to discount it.
 */
export function buildAdvisory(newlyModified: readonly string[]): string {
  const list = newlyModified.map((p) => `  - ${p}`).join("\n");
  const plural = newlyModified.length === 1 ? "file" : "files";
  return (
    `[${GUARD_NAME}] ${newlyModified.length} tracked ${plural} in the MAIN workspace ` +
    `became modified during that Bash call:\n${list}\n\n` +
    `If you are working in a session, this write went to the wrong tree — main and the ` +
    `session workspace are clones with identical layouts, so a relative path resolves in ` +
    `both and nothing errors. Repair: copy the change into the session (session_write_file / ` +
    `session_search_replace, session id + a RELATIVE path), then restore main with ` +
    `git_restore. Verifying in the session will not catch this on its own — the session is ` +
    `internally consistent either way.\n\n` +
    `If you are deliberately editing main (a rule, a doc, a scratch script), this is expected ` +
    `— carry on.`
  );
}

/** Read the persisted baseline, or null when there is none / it is unreadable. */
function readBaseline(repoRoot: string): string[] | null {
  try {
    const raw = readFileSync(join(repoRoot, BASELINE_RELATIVE_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // Absent or corrupt reads as "no baseline": the next write replaces it, and
    // decideMutation's null branch reports nothing rather than flagging the
    // whole dirty tree. intentional-swallow: an unreadable baseline must not
    // fail the tool call this rides on.
    return null;
  }
}

function writeBaseline(repoRoot: string, baseline: readonly string[]): void {
  try {
    writeFileSync(join(repoRoot, BASELINE_RELATIVE_PATH), JSON.stringify(baseline, null, 0));
  } catch {
    // intentional-swallow: failing to persist costs a repeated advisory next
    // call, which is strictly better than failing the tool call.
  }
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const input = await readInput<ToolHookInput>();

  // "decided" covers both a fire and a clean look — the guard reached a verdict
  // either way, which is what this field distinguishes from "crashed". A silent
  // git failure must NOT read as a clean tree (mem#704): it is recorded as
  // crashed so a persistently unreadable workspace has a denominator.
  let outcome: "decided" | "crashed" = "decided";

  try {
    // `deriveHookRepoRoot()` with no argument resolves the repo containing THIS
    // HOOK FILE — the main workspace, which is exactly the tree in question.
    // `input.cwd` is the caller's shell directory and can be a session
    // workspace or anywhere else; resolving from it would silently observe the
    // wrong tree, and a clean status there reads identically to a clean main.
    const repoRoot = deriveHookRepoRoot();

    const proc = Bun.spawnSync({
      cmd: ["git", "status", "--porcelain=v1"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (proc.exitCode !== 0) {
      // Fail open and SILENT. A git read that cannot complete tells us nothing
      // about whether a mutation happened, and a false flag is worse than a
      // miss for an advisory whose whole value is that its fires mean something.
      outcome = "crashed";
    } else {
      const current = parseModifiedTracked(proc.stdout.toString());
      const decision = decideMutation(readBaseline(repoRoot), current);
      writeBaseline(repoRoot, decision.nextBaseline);

      if (decision.fired && decision.message) {
        writeOutput({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: decision.message,
          },
        });
      }
    }
  } catch (err) {
    process.stderr.write(
      `[${GUARD_NAME}] observation threw: ${err instanceof Error ? err.message : String(err)}\n`
    );
    outcome = "crashed";
  }

  recordFireLogEntry({
    guardName: GUARD_NAME,
    event: "PostToolUse",
    decision: "allow",
    guardOutcome: outcome,
    durationMs: Date.now() - startMs,
    toolName: input.tool_name,
    sessionId: input.session_id,
  });
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
