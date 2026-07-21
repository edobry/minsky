// Per-session dedup store for the turn-end retrospective scan (mt#2357).
//
// Records which (turnKey, family, phrase) triples the Stop-event guard
// (`turn-end-retro-scan.ts`) has already flagged, so that:
//   (a) a Stop-hook continuation never re-flags the same admission — every
//       Stop-hook output (block OR additionalContext) continues the
//       conversation one beat and counts toward the harness's hard cap of 8
//       consecutive continuations, so an un-deduped advisory would ping-pong
//       a false positive toward that cap instead of costing one beat;
//   (b) the prompt-time `retrospective-trigger-scanner.ts` does not re-flag
//       a phrase the agent already saw (and disposed of) at turn end — the
//       prompt-time scan of "the last assistant turn" covers the SAME text
//       the Stop-time scan of "the final turn" covered, one prompt later.
//
// Turn identity: the turn's OPENING real-prompt line (`uuid`, falling back
// to `timestamp`). At Stop time that line is the transcript's LAST real
// prompt; at the next prompt-time scan it is the SECOND-TO-LAST — the same
// physical line, so the key is stable across both scans of the same turn.
//
// Layout: one small JSON file per session under
// `~/.local/state/minsky/turn-end-scan/<session_id>.json` — mirrors the
// skill-staleness-detector's per-session-file pattern, which sidesteps the
// read-modify-write race a shared file would have between concurrent
// sessions. All reads fail open (unreadable store = nothing flagged); a
// failed write logs to stderr and the advisory still fires — the 8-beat cap
// bounds the worst case.
//
// @see .minsky/hooks/turn-end-retro-scan.ts — the Stop-event writer
// @see .minsky/hooks/retrospective-trigger-scanner.ts — the prompt-time reader
// @see mt#2357 — originating task (ask#9 option B)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptLine } from "./transcript";

const DEFAULT_STORE_DIR = join(homedir(), ".local", "state", "minsky", "turn-end-scan");

/** Stable identity for a logical turn: its opening real-prompt line. */
export function turnKeyFor(openingPrompt: TranscriptLine | undefined): string {
  if (!openingPrompt) return "session-start";
  return openingPrompt.uuid ?? openingPrompt.timestamp ?? "session-start";
}

/** Composite dedup key for one flagged match within one turn. */
export function flagKey(turnKey: string, family: string, phrase: string): string {
  return `${turnKey}|${family}|${phrase}`;
}

function storePath(sessionId: string, dir: string): string {
  // session_id is a UUID in practice; sanitize defensively for path safety.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(dir, `${safe}.json`);
}

/** Read the flagged-key set for a session. Fails open to an empty set. */
export function readFlagged(sessionId: string, dir: string = DEFAULT_STORE_DIR): Set<string> {
  try {
    const raw = readFileSync(storePath(sessionId, dir), "utf8");
    const parsed = JSON.parse(raw) as { flagged?: unknown };
    if (Array.isArray(parsed.flagged)) {
      return new Set(parsed.flagged.filter((k): k is string => typeof k === "string"));
    }
  } catch {
    // fail-open: unreadable/absent store = nothing flagged yet
  }
  return new Set();
}

/** Persist the flagged-key set. A failed write logs and is non-fatal. */
export function writeFlagged(
  sessionId: string,
  flagged: Set<string>,
  dir: string = DEFAULT_STORE_DIR
): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(storePath(sessionId, dir), JSON.stringify({ flagged: [...flagged] }), "utf8");
  } catch (err) {
    process.stderr.write(
      `[turn-end-scan-store] write failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/** Remove a session's store file (canary/test hygiene). Never throws. */
export function clearFlagged(sessionId: string, dir: string = DEFAULT_STORE_DIR): void {
  try {
    rmSync(storePath(sessionId, dir), { force: true });
  } catch {
    // best-effort cleanup only
  }
}
