/**
 * JsonlTailer — incremental byte-offset reader for append-only JSONL files.
 *
 * Reads only COMPLETE (newline-terminated) lines from each file's last-read
 * byte offset, so a partially-written trailing line — e.g. a transcript whose
 * writer was killed mid-line — is never parsed until its terminating newline
 * lands. Per-path offsets are tracked in memory.
 *
 * This is the shared incremental-read primitive for the cockpit transcript
 * watcher (mt#2320, ingest-on-append) and the Rung-1 live renderer (mt#2232,
 * render-on-append). Build once, consume from both — do not hand-roll a second
 * tailer over the same files.
 *
 * The tailer is intentionally transcript-agnostic: it yields parsed JSON values
 * (or the raw line strings via {@link JsonlTailer.readNewRaw}). Turn/attachment
 * semantics live in the ingest service, not here.
 *
 * Offsets are byte offsets (not line or character counts) so multibyte UTF-8
 * content stays correct; reads work on a Buffer and only decode the
 * complete-line prefix.
 *
 * @see mt#2320 — cockpit-daemon transcript watcher (primary consumer)
 * @see mt#2232 — Rung 1 live render (second consumer of this primitive)
 */

import { open } from "node:fs/promises";

const NEWLINE = 0x0a; // '\n'

export interface JsonlTailRawResult {
  /** Raw text of each complete line read this call (excludes the trailing newline). */
  rawLines: string[];
  /** Byte offset after the last complete line consumed (the new stored offset). */
  offset: number;
  /** Bytes present after `offset` forming an incomplete trailing line (not yet consumed). */
  pendingBytes: number;
  /**
   * True when the file shrank below the stored offset (truncated or replaced —
   * e.g. log rotation); the offset was reset to 0 before this read.
   */
  reset: boolean;
}

export interface JsonlTailResult<T = unknown> {
  /** Parsed JSON value for each complete line (blank and malformed lines excluded). */
  lines: T[];
  /** Count of complete lines that failed `JSON.parse` (excluded from `lines`). */
  malformed: number;
  /** Byte offset after the last complete line consumed (the new stored offset). */
  offset: number;
  /** Bytes present after `offset` forming an incomplete trailing line (not yet consumed). */
  pendingBytes: number;
  /** True when the file was truncated/replaced and the offset was reset to 0 before reading. */
  reset: boolean;
}

export class JsonlTailer {
  private readonly offsets = new Map<string, number>();

  /** Current stored byte offset for `path` (0 if never read). */
  getOffset(path: string): number {
    return this.offsets.get(path) ?? 0;
  }

  /**
   * Seed or override the stored offset for `path`. Used to skip pre-existing
   * content discovered at startup (seed to the file's current size) so the
   * tailer only surfaces appends that happen after the watcher attaches.
   */
  setOffset(path: string, offset: number): void {
    this.offsets.set(path, offset < 0 ? 0 : offset);
  }

  /** Forget `path` (e.g. on file unlink). */
  forget(path: string): void {
    this.offsets.delete(path);
  }

  /** Drop all tracked offsets. */
  clear(): void {
    this.offsets.clear();
  }

  /** Number of files currently being tracked. */
  get size(): number {
    return this.offsets.size;
  }

  /**
   * Read new complete lines from `path` since the last read, parsing each as
   * JSON. Advances the stored offset past consumed (complete) lines only;
   * blank lines are ignored and malformed lines are counted, not thrown.
   */
  async readNew<T = unknown>(path: string): Promise<JsonlTailResult<T>> {
    const raw = await this.readNewRaw(path);
    const lines: T[] = [];
    let malformed = 0;
    for (const text of raw.rawLines) {
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      try {
        lines.push(JSON.parse(trimmed) as T);
      } catch {
        malformed++;
      }
    }
    return {
      lines,
      malformed,
      offset: raw.offset,
      pendingBytes: raw.pendingBytes,
      reset: raw.reset,
    };
  }

  /**
   * Lower-level variant: returns the raw complete-line strings without JSON
   * parsing. Useful when the consumer wants the original text verbatim.
   */
  async readNewRaw(path: string): Promise<JsonlTailRawResult> {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      let start = this.offsets.get(path) ?? 0;
      let reset = false;

      if (size < start) {
        // File truncated or replaced (rotation, session restart) — re-read from 0.
        start = 0;
        reset = true;
      }

      if (size <= start) {
        this.offsets.set(path, start);
        return { rawLines: [], offset: start, pendingBytes: 0, reset };
      }

      const length = size - start;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      const view = buf.subarray(0, bytesRead);

      const lastNewline = view.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        // No complete line yet — leave the offset unmoved; report pending bytes.
        this.offsets.set(path, start);
        return { rawLines: [], offset: start, pendingBytes: bytesRead, reset };
      }

      const completeText = view.subarray(0, lastNewline).toString("utf-8");
      const consumed = lastNewline + 1; // include the terminating newline
      const newOffset = start + consumed;
      this.offsets.set(path, newOffset);

      const rawLines = completeText.length === 0 ? [] : completeText.split("\n");
      return { rawLines, offset: newOffset, pendingBytes: bytesRead - consumed, reset };
    } finally {
      await handle.close();
    }
  }
}
