/**
 * Rebuild a reaped conversation's on-disk `.jsonl` from `transcript_lines`, so
 * `claude --resume` can continue it again (mt#4573).
 *
 * Claude Code deletes a transcript after `cleanupPeriodDays` of inactivity
 * (vendor default 30; see Anthropic's data-usage doc). The CONTENT is not lost —
 * mt#3438 measured 24 reaped conversations still holding 4,899 turns in our
 * substrate — but the ability to CONTINUE them is, because the harness resumes
 * from the file and nothing else.
 *
 * This module closes that gap in the direction ADR-025's still-current
 * `## Context` already points: *"The on-disk JSONL is not a durable system of
 * record"*, and a consumer "must never depend on" it. Rehydration is that stance
 * carried one step further — from reading our own copy to handing it back.
 *
 * ## What "faithful" means here
 *
 * Faithful modulo three transforms applied at capture, all deliberate and all
 * documented on `transcript-lines-schema.ts`: credential scrubbing (mt#2763),
 * U+0000 sanitization (mt#3278), and the skipping of any line that failed to
 * parse. A fidelity check must account for these rather than expecting byte
 * equality; `reconstructJsonl` is honest about reproducing the PARSED stream.
 *
 * @see mt#4573
 */

import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { transcriptLinesTable } from "../storage/schemas/transcript-lines-schema";

/**
 * Encode a working directory the way Claude Code names its per-project
 * transcript directory under `~/.claude/projects/`.
 *
 * **Both `/` and `.` become `-`** — the dot is the part that is easy to miss,
 * and getting it wrong silently writes the file where the harness will never
 * look. Recorded in mt#3434's capture notes, which hit it during the
 * 2026-07-31 archive work: `~/Projects/dobry.me` → `-Users-edobry-Projects-dobry-me`.
 *
 * This is a vendor rule we do not own, so its test verifies against a real
 * directory name on disk rather than against this function's own logic.
 */
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Absolute path Claude Code would read this conversation's transcript from. */
export function transcriptPathFor(cwd: string, agentSessionId: string, home = homedir()): string {
  return join(home, ".claude", "projects", encodeProjectDirName(cwd), `${agentSessionId}.jsonl`);
}

/**
 * Serialize a session's captured lines back into JSONL text, in file order.
 *
 * Returns `null` when the session has no captured lines — distinct from `""`,
 * which would be a session captured as genuinely empty. The caller must not
 * write a file for `null`: an empty transcript is worse than an absent one,
 * because the harness would accept it and resume into nothing.
 */
export async function reconstructJsonl(
  db: PostgresJsDatabase,
  agentSessionId: string
): Promise<string | null> {
  const rows = await db
    .select({ line: transcriptLinesTable.line })
    .from(transcriptLinesTable)
    .where(eq(transcriptLinesTable.agentSessionId, agentSessionId))
    .orderBy(asc(transcriptLinesTable.lineOrdinal));

  if (rows.length === 0) return null;
  // Trailing newline: the harness appends to this file, and a resumed session's
  // first write would otherwise land on the same line as our last one.
  return `${rows.map((r) => JSON.stringify(r.line)).join("\n")}\n`;
}

export type RehydrateOutcome =
  | { status: "rehydrated"; path: string; lineCount: number }
  | { status: "already-present"; path: string }
  | { status: "nothing-captured" };

/**
 * The filesystem operations {@link rehydrateTranscript} needs, injected rather
 * than imported.
 *
 * Not ceremony: this function's whole contract is "never clobber a live
 * transcript", and a test that cannot make the file EXIST cannot check the
 * branch that matters. Injecting is also what keeps the test off the real
 * filesystem, which `custom/no-real-fs-in-tests` requires.
 */
export interface RehydrationFs {
  /** Does a file exist at this path? */
  exists(path: string): Promise<boolean>;
  /** Create the containing directory, recursively; a no-op if it exists. */
  ensureDir(path: string): Promise<void>;
  /** Write, FAILING if the path already exists (`wx`), never truncating. */
  writeNew(path: string, contents: string): Promise<void>;
}

export const realRehydrationFs: RehydrationFs = {
  async exists(path) {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  async ensureDir(path) {
    await mkdir(join(path, ".."), { recursive: true });
  },
  async writeNew(path, contents) {
    await writeFile(path, contents, { flag: "wx" });
  },
};

/**
 * Write a reaped conversation's transcript back to disk.
 *
 * **Never overwrites.** An existing file is the LIVE transcript of a
 * conversation the harness may be appending to right now, and replacing it with
 * our reconstruction would discard whatever it holds beyond our last capture —
 * silently, since both files are valid JSONL. `already-present` is therefore a
 * success-shaped outcome, not an error: the conversation is resumable, which is
 * what the caller wanted to know.
 */
export async function rehydrateTranscript(
  db: PostgresJsDatabase,
  agentSessionId: string,
  cwd: string,
  opts: { home?: string; fs?: RehydrationFs } = {}
): Promise<RehydrateOutcome> {
  const fs = opts.fs ?? realRehydrationFs;
  const path = transcriptPathFor(cwd, agentSessionId, opts.home ?? homedir());

  if (await fs.exists(path)) return { status: "already-present", path };

  const contents = await reconstructJsonl(db, agentSessionId);
  if (contents === null) return { status: "nothing-captured" };

  await fs.ensureDir(path);
  // `writeNew` fails rather than truncates if the file appeared between the
  // check above and this write — the guard has to hold against a live harness,
  // not just against a slow caller.
  await fs.writeNew(path, contents);

  return { status: "rehydrated", path, lineCount: contents.split("\n").length - 1 };
}
