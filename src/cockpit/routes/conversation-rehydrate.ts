/**
 * POST /api/conversations/:id/rehydrate (mt#4573).
 *
 * The conversation-view counterpart to `agent-focus.ts`: the browser cannot
 * write to `~/.claude/projects/`, but the cockpit daemon runs on the same Mac,
 * so the server does it. Given a conversation whose on-disk transcript Claude
 * Code has reaped, this rebuilds the `.jsonl` from our own storage and the
 * conversation becomes resumable again.
 *
 * **Never destructive.** `rehydrateTranscript` refuses to overwrite an existing
 * file and this route surfaces that as `already-present` — a success-shaped
 * outcome, because the caller's question ("can I resume this?") is answered
 * yes. An existing file is a LIVE conversation the harness may be appending to,
 * and both files are valid JSONL, so a clobber would be silent.
 *
 * Same local-only boundary `agent-focus` draws: this writes to the daemon's own
 * filesystem, so it is meaningful only for a cockpit reached from the machine
 * running it. A `cwd` recorded for a directory that does not exist here is
 * reported rather than written into.
 *
 * @see packages/domain/src/transcripts/transcript-rehydration.ts
 * @see mt#4573
 */
import type express from "express";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";

import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import {
  rehydrateTranscript,
  type RehydrationFs,
} from "@minsky/domain/transcripts/transcript-rehydration";

import { describeServerPersistenceUnavailability } from "../db-providers";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";

export interface ConversationRehydrateRouteOptions {
  /** Test seam — overrides the cockpit-wide SQL connection getter. */
  getDb?: () => Promise<PostgresJsDatabase | null>;
  /**
   * Test seam — overrides the real filesystem. Production MUST omit this so
   * `rehydrateTranscript` falls through to `realRehydrationFs`; every test MUST
   * supply a fake, so no test writes into a real `~/.claude/projects/`.
   */
  fs?: RehydrationFs;
  /** Test seam — overrides `os.homedir()`. */
  home?: string;
}

/** Mount POST /api/conversations/:id/rehydrate on `app`. */
export function mountConversationRehydrateRoutes(
  app: express.Express,
  opts: ConversationRehydrateRouteOptions = {}
): void {
  app.post("/api/conversations/:id/rehydrate", async (req, res) => {
    // Express already URI-decodes route params once; a second decode here would
    // corrupt an id containing a literal `%` (the mt#2286 R1 finding on the
    // sibling route). Do not decode again.
    const conversationId = req.params.id;
    if (!conversationId) {
      res.status(400).json({ error: "Conversation ID required" });
      return;
    }

    try {
      const getDb = opts.getDb ?? (await import("../db-providers")).getContextInspectorDb;
      const db = await getDb();
      if (!db) {
        res.status(503).json({
          error: `Transcript store unavailable — cannot rebuild this conversation. ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }

      const rows = await db
        .select({ cwd: agentTranscriptsTable.cwd })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, conversationId))
        .limit(1);

      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: `No ingested conversation with id ${conversationId}` });
        return;
      }
      if (!row.cwd) {
        // `claude --resume` keys its transcript directory off the cwd, so
        // without one there is no path to write to — and guessing would put the
        // file somewhere the harness never reads. mt#3434 hit the same wall.
        res.status(422).json({
          outcome: "no-recorded-cwd",
          error:
            "This conversation has no recorded working directory, so its transcript path cannot be derived.",
        });
        return;
      }

      const outcome = await rehydrateTranscript(db, conversationId, row.cwd, {
        fs: opts.fs,
        home: opts.home,
      });

      // `already-present` is 200, not a conflict: the caller asked whether the
      // conversation is resumable, and it is.
      const status = outcome.status === "nothing-captured" ? 422 : 200;
      res.status(status).json(outcome);
    } catch (err) {
      // mt#4086/mt#4125: this route reads the transcript store twice, so a
      // database outage is a live failure mode here — and reporting one as a
      // generic 500 tells the operator their application is broken when the
      // database is. Classify first; `db-unavailable-response.test.ts` fails
      // the build on a cockpit catch that answers 500 without this.
      if (await respondIfDatabaseUnavailable(res, err, "conversation-rehydrate")) return;
      log.error(`Conversation rehydrate failed for ${conversationId}`, {
        conversationId,
        error: getLoggableErrorSummary(err),
      });
      res.status(500).json({ error: "Failed to rebuild the conversation transcript" });
    }
  });
}
