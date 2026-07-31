/**
 * Driven-session history replay (mt#3453) — the prior turns of a conversation,
 * read from its on-disk transcript, so a drive view does not open empty.
 *
 * ## Why this exists
 *
 * A driven session's WS channel replays `record.eventLog`, which is in-process
 * memory. Two situations leave it empty while the conversation itself has a
 * long history:
 *
 *   - an ATTACHED conversation (mt#3095) — Minsky never spawned it, so no event
 *     of it was ever observed in this process;
 *   - a RECONNECTING record rehydrated after a daemon restart (mt#3038) — the
 *     log died with the previous process.
 *
 * In both cases the history is not lost; it is on disk, in the same
 * `~/.claude/projects/**` transcript the observe rung already tails. This module
 * reads it.
 *
 * ## This is a third consumer, not a second reader
 *
 * The transcript→block conversion is NOT written here. Two shared primitives
 * already own it and are used by the ingest path (`transcript-watcher.ts`) and
 * the live-tail SSE path (`live-tail-poller.ts`):
 *
 *   - {@link JsonlTailer} — the incremental JSONL reader. A FRESH instance has
 *     no recorded offset for the path, so its first `readNew` returns the whole
 *     file: exactly the "read all history once" this needs, with no separate
 *     whole-file reader to keep in sync.
 *   - `turnLineToBlock` — the canonical line→`SessionContextSnapshotBlock`
 *     converter, whose own docblock states it is exported so the live-tail
 *     renderer can reuse "the exact same conversion as the DB snapshot path".
 *
 * Reusing both is what keeps the drive view's history identical to the observe
 * view's for the same conversation, and it is what mt#3132 Phase 3 means by a
 * single transcript-tail history source — a parallel reader here is precisely
 * what would obstruct that.
 *
 * @see mt#3453 — this module
 * @see mt#3095 — the attach path whose empty pane motivated it
 * @see ./live-tail-poller.ts — the sibling consumer, and the `:live:` id
 *   convention this mirrors
 */
import { JsonlTailer } from "@minsky/domain/transcripts/jsonl-tailer";
import { turnLineToBlock } from "@minsky/domain/transcripts/session-context-snapshot";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { log } from "@minsky/shared/logger";

/**
 * Maximum number of history blocks replayed onto a drive channel.
 *
 * Measured, not chosen (per `decision-defaults §Thresholds`). Across 305 local
 * transcripts under `~/.claude/projects` on 2026-07-31, counting `user` +
 * `assistant` lines per file:
 *
 * | | turns | bytes |
 * | --- | --- | --- |
 * | median | 522 | 2.4 MB |
 * | p90 | 1267 | 5.1 MB |
 * | p95 | 1596 | 7.5 MB |
 * | max | 2537 | 17.8 MB |
 *
 * 1300 sits just above p90, so the cap engages on roughly the top decile and
 * leaves a typical conversation untouched. The first draft of this constant was
 * 400 — the measurement showed that would have truncated the MEDIAN
 * conversation, which is routine truncation dressed as a safety bound, not a
 * bound on outliers.
 *
 * Sizing it generously is safe because the observe rung ALREADY renders whole
 * conversations of this magnitude through the DB-snapshot path, so the SPA is
 * known to handle them; this cap exists to stop a pathological frame, not to
 * optimize a normal one.
 *
 * The cap keeps the TAIL, not the head: an operator opening a conversation
 * needs the turns it just had.
 *
 * Deliberately NOT aligned with `MAX_EVENT_LOG` (2000, driven-session-host.ts):
 * that bounds EVENTS, and a single turn emits many events, so the two numbers
 * are not comparable quantities.
 */
export const MAX_REPLAY_BLOCKS = 1300;

/**
 * The slice of {@link JsonlTailer} this module uses. Named and exported so a
 * test double is checked against the SAME signature production passes — an
 * inline structural literal typechecks in the test file while silently
 * diverging from the real generic method.
 */
export interface ReplayTailerLike {
  readNew<T = unknown>(path: string): Promise<{ lines: T[] }>;
}

export interface BuildDrivenReplayBlocksOptions {
  /** Override the cap (tests use a small one; production takes the default). */
  maxBlocks?: number;
  /** Override the tailer (tests inject a deterministic one; no real fs). */
  tailer?: ReplayTailerLike;
}

/**
 * Read `jsonlPath` and convert it to the conversation's history blocks.
 *
 * Returns `[]` — never throws — when the transcript is missing, unreadable, or
 * contains nothing convertible. An empty pane is the pre-existing behavior, so
 * degrading to it is safe; throwing here would take down the WS attach for a
 * conversation that is otherwise perfectly drivable. The read error IS logged
 * rather than swallowed (mt#3019/mt#3046 silent-failure class): "no history" and
 * "could not read the history" must be distinguishable in the daemon log even
 * though they render the same.
 */
export async function buildDrivenReplayBlocks(
  jsonlPath: string,
  conversationId: string,
  opts: BuildDrivenReplayBlocksOptions = {}
): Promise<SessionContextSnapshotBlock[]> {
  const maxBlocks = opts.maxBlocks ?? MAX_REPLAY_BLOCKS;
  // A fresh tailer per call: its offset map starts empty, so this reads from
  // byte 0. Reusing a long-lived tailer would return only lines appended since
  // the last read — correct for tailing, wrong for replay.
  const tailer = opts.tailer ?? new JsonlTailer();

  let lines: unknown[];
  try {
    const result = await tailer.readNew(jsonlPath);
    lines = result.lines;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      `[driven-session] replay: could not read transcript for ${conversationId} (${jsonlPath}): ${message}`
    );
    return [];
  }

  const blocks: SessionContextSnapshotBlock[] = [];
  for (const [index, line] of lines.entries()) {
    // `turnLineToBlock` returns null for every line that is not a `user` or
    // `assistant` turn — `system`, `attachment`, `queue-operation`, and any
    // malformed entry. Skipping them here matches what the live-tail path
    // renders, so replayed and live history stay consistent rather than the
    // replay showing block types the live stream never produces.
    const block = turnLineToBlock(conversationId, index, line);
    if (block === null) continue;
    blocks.push({
      // A distinct id namespace, mirroring live-tail's `:live:` convention.
      // Replay blocks must not collide with live blocks or DB-snapshot blocks:
      // they are a different read path, and a collision would make the SPA
      // treat a replayed turn and a live turn as the same block.
      ...block,
      id: `${conversationId}:replay:${index}`,
    });
  }

  // Keep the TAIL. `slice(-n)` on an under-cap array returns it unchanged, so
  // the common case is untouched.
  return blocks.slice(-maxBlocks);
}
