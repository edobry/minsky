/**
 * Harness session labeling for cockpit-spawned children (mt#4621).
 *
 * Minsky titles a Claude Code session through a two-hook relay that ships
 * already (mt#843):
 *
 *   `.minsky/hooks/post-session-start.ts` (PostToolUse on `session_start`)
 *     → writes `/tmp/claude-session-label-<sessionId>.json`
 *   `.minsky/hooks/auto-session-title.ts` (UserPromptSubmit guard)
 *     → consumes it and returns `hookSpecificOutput.sessionTitle`
 *     → the harness persists that as a `custom-title` record in the session
 *       JSONL and renders it above the prompt bar.
 *
 * **The relay's existing writer is SELF-labeling and that is why it never
 * reached a cockpit-spawned child.** `post-session-start.ts` keys the file on
 * `input.session_id` — the conversation that CALLED `session_start`, i.e.
 * itself. An entity thread is cross-process: the daemon spawns a child and
 * must label THAT child, whose conversation id it does not know at spawn time.
 * This module is the cross-process writer; nothing about the consuming half
 * changes.
 *
 * **Measured cost of not having it (2026-08-25/26).** Of 644 session JSONL
 * files for this project, 578 are interactive and 13 carry neither a
 * `custom-title` nor the harness's own `ai-title` — they render untitled above
 * the prompt bar. Three of the 13 are cockpit-spawned ask threads.
 *
 * **Timing, and why a miss is a delay rather than a loss.** The caller writes
 * this on the child's `system/init` event (`onHarnessSessionLinked`), which is
 * the first moment the child's conversation id exists. The seed prompt is
 * written to the child's stdin BEFORE that, so the child's first
 * `UserPromptSubmit` may or may not observe the file — a genuine race. It does
 * not matter: the guard consumes the file whenever it next runs and deletes it
 * on consumption, so the worst case is that the title lands on the operator's
 * first message instead of on the seed. There is no path where the write is
 * made and the title never appears.
 *
 * @see .minsky/hooks/auto-session-title.ts — the consuming half; its path
 *   template is asserted against this module's in `harness-session-label.test.ts`
 * @see .minsky/hooks/post-session-start.ts — the self-labeling writer this
 *   complements
 * @see src/cockpit/entity-thread-launch.ts — the caller
 * @see mt#843 — the relay; mt#4621 — this module
 */

import { writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { log } from "@minsky/shared/logger";

/**
 * Path template the consuming guard reads.
 *
 * Kept as a prefix constant rather than inlined so the drift test has a single
 * literal to compare against `auto-session-title.ts`'s own. Two processes agree
 * on this string and nothing at compile time makes them — the hook is a
 * standalone bun script the cockpit deliberately does not import (hook-land is
 * not a cockpit dependency), so the coupling is checked by test instead.
 */
export const HARNESS_SESSION_LABEL_PREFIX = "/tmp/claude-session-label-";

/** Directory every label file must resolve into. The traversal backstop below anchors on it. */
const HARNESS_SESSION_LABEL_DIR = "/tmp";

/**
 * Ids this module will splice into a filename (PR #3379 R2).
 *
 * `harnessSessionId` arrives from the child's stream-json `system/init` frame,
 * and `extractHarnessSessionId` (`driven-session-host.ts:403-406`) accepts ANY
 * non-empty string — it checks `typeof raw === "string" && raw.length > 0` and
 * nothing else. So by the time the id reaches this module it has been parsed
 * off a pipe and never validated, and this module then puts it in a path it
 * writes to. That is the whole finding, and it is correct independently of how
 * likely a hostile child is: a value spliced into a filesystem path should be
 * checked where it is spliced, not assumed clean because of who produced it.
 *
 * The charset covers every id shape actually observed — UUIDs
 * (`3a61b3a8-67a2-4536-8461-741a6c7f1b15`) and subagent ids
 * (`agent-ad863113ed9b30247`) are both hex/alphanumeric plus hyphens. The
 * length bound keeps a pathological id from tripping ENAMETOOLONG.
 *
 * Rejection is SILENT-ish by design: the thread stays untitled, which is this
 * module's documented worst case, rather than the spawn failing.
 */
const SAFE_HARNESS_SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Whether an id is safe to use as a filename component. */
export function isSafeHarnessSessionId(harnessSessionId: string): boolean {
  return SAFE_HARNESS_SESSION_ID.test(harnessSessionId);
}

/**
 * Absolute path of the label file the guard will consume for this conversation.
 *
 * Deliberately still a plain concatenation: it must produce byte-for-byte what
 * `auto-session-title.ts` computes from its own `input.session_id`, and that
 * hook does no normalization. Validation is the CALLER's job — see
 * {@link isSafeHarnessSessionId} and the anchor check in
 * {@link writeHarnessSessionLabel} — so that this function stays a faithful
 * mirror of the consuming half rather than diverging from it.
 */
export function harnessSessionLabelPath(harnessSessionId: string): string {
  return `${HARNESS_SESSION_LABEL_PREFIX}${harnessSessionId}.json`;
}

/**
 * The payload shape `auto-session-title.ts` parses.
 *
 * Its field is named `taskId` because the relay was built for task-bound
 * workspace sessions (mt#843). The guard does nothing with it but interpolate
 * `${taskId} — ${title}`, so an entity thread passes its own short ref
 * (`ask#9257`) in that slot. Renaming the field would be a cross-process
 * contract change for a cosmetic gain; the mismatch is documented instead.
 */
export interface HarnessSessionLabel {
  taskId: string;
  title: string;
}

export interface WriteHarnessSessionLabelInput {
  harnessSessionId: string;
  /** Short human-readable ref — `ask#9257`, `mt#4621`. Becomes the label's prefix. */
  ref: string;
  /** The entity's own title. */
  title: string;
}

/** Injectable IO seam so tests never touch the real filesystem. */
export interface WriteHarnessSessionLabelDeps {
  writeFile?: (path: string, contents: string) => void;
}

/**
 * Compose the rendered label the guard will emit.
 *
 * Exported for the caller's tests and because it is the one piece with a real
 * decision in it: when an entity has no title of its own, the seed adapters
 * already fall back to the short ref, which would otherwise render as
 * `ask#9257 — ask#9257`. Collapse that to the ref alone.
 */
export function buildHarnessSessionLabel(
  input: WriteHarnessSessionLabelInput
): HarnessSessionLabel {
  const ref = input.ref.trim();
  const title = input.title.trim();
  if (!title || title === ref) return { taskId: ref, title: ref };
  return { taskId: ref, title };
}

/**
 * Write the label file for a cockpit-spawned child.
 *
 * Best-effort by contract: this runs inside the host's `system/init` handler,
 * where a throw would surface as an unhandled rejection on a detached promise
 * for every spawn (the same hazard `createDrivenInitObserver` documents at
 * length). A failed write costs an untitled thread and nothing else, so every
 * failure logs and returns false rather than propagating.
 *
 * @returns whether the file was written.
 */
export function writeHarnessSessionLabel(
  input: WriteHarnessSessionLabelInput,
  deps: WriteHarnessSessionLabelDeps = {}
): boolean {
  const harnessSessionId = input.harnessSessionId.trim();
  if (!harnessSessionId) return false;

  // PR #3379 R2 — the id is untrusted stream-json, and it is about to become a
  // filename. Reject rather than sanitize: a rewritten id would key the file to
  // something the consuming guard (which computes the path from its OWN
  // unmodified `session_id`) could never look up, so a "repaired" write is
  // strictly worse than none.
  if (!isSafeHarnessSessionId(harnessSessionId)) {
    log.warn(
      `[harness-session-label] refusing an unsafe conversation id (${harnessSessionId.length} chars) ` +
        `— thread stays untitled`
    );
    return false;
  }

  const path = harnessSessionLabelPath(harnessSessionId);

  // Belt and braces. The charset above already excludes `/`, `\` and `.`, so
  // this cannot fire today — it is here so that widening the charset later
  // cannot silently reintroduce traversal without tripping a second check.
  if (dirname(resolve(path)) !== HARNESS_SESSION_LABEL_DIR) {
    log.error(
      `[harness-session-label] refusing a path that escapes ${HARNESS_SESSION_LABEL_DIR} — thread stays untitled`
    );
    return false;
  }

  try {
    (deps.writeFile ?? defaultWriteFile)(path, JSON.stringify(buildHarnessSessionLabel(input)));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[harness-session-label] could not write ${path}: ${message} — thread stays untitled`);
    return false;
  }
}

function defaultWriteFile(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
}
