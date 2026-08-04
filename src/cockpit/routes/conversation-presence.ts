/**
 * Cockpit conversation-presence read route (mt#3201, mt#3130 Phase 2).
 *
 *   GET /api/conversation/:id/presence
 *
 * The reader for the channel mt#3161 populates. Sibling of
 * `conversation-run-state.ts` (the POST ingest), split for the same reason the
 * domain layer splits `repository.ts` from `read.ts`: opposite hot paths, and
 * an ingest route whose doc block is about hook-write cost should not also
 * carry the render contract.
 *
 * @see packages/domain/src/conversation-run-state/presence.ts — the derivation
 * @see packages/domain/src/conversation-run-state/read.ts — the queries
 */
import type express from "express";
import type { ConversationRunStateRecord } from "@minsky/domain/storage/schemas/conversation-run-state-schema";
import { log } from "@minsky/shared/logger";
import {
  derivePresence,
  type ConversationPresenceResult,
} from "@minsky/domain/conversation-run-state/presence";
import {
  getConversationRunState,
  findOpenAskForConversation,
  type LinkedOpenAsk,
} from "@minsky/domain/conversation-run-state/read";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import { describeServerPersistenceUnavailability } from "../db-providers";
import {
  classifySnapshotMiss,
  looksLikeConversationId,
  WRONG_ID_SPACE_MESSAGE,
} from "../conversation-id-space";
import { createCachedSqlDbGetter, getServerSessionProvider } from "../db-providers";

/**
 * Lazy-cached SQL handle. `cacheNegative: false` — a failed probe is retried on
 * the next request rather than latched, matching the ingest route: this
 * endpoint runs for the life of the daemon and must recover on its own when the
 * database comes back.
 */
const getPresenceDb = createCachedSqlDbGetter({ cacheNegative: false });

/** Stable, user-safe error codes. Raw error text is logged, never returned. */
type PresenceErrorCode = "invalid_id" | "wrong_id_space" | "store_unavailable" | "internal";

/** The response body. `presence` is always present — including for `UNKNOWN`. */
export interface ConversationPresenceResponse extends ConversationPresenceResult {
  conversationId: string;
  /** The open Ask this conversation is waiting on, when one is resolvable. */
  ask: LinkedOpenAsk | null;
}

function presenceError(
  res: express.Response,
  status: number,
  code: PresenceErrorCode,
  message: string
): void {
  res.status(status).json({ error: { code, message } });
}

/**
 * Fold an open Ask into the derived presence.
 *
 * Only an **IDLE** conversation is upgraded to `NEEDS_INPUT (ask)`. A `LIVE` or
 * `STALLED` conversation is left alone: what it is doing right now is the more
 * specific and more useful answer, and an ask can be open for reasons unrelated
 * to the turn in flight. (`/agents`' needs-me BANDING deliberately ranks
 * needs-input above working — that is fleet ORDERING, a different question from
 * "what is this one conversation doing", so the two are not in conflict.)
 *
 * A harness-native `NEEDS_INPUT` is never overwritten — it already carries a
 * more precise reason (`permission` / `idle-prompt`) than `ask` — but the ask is
 * still attached to the response so the render can link it.
 */
export function foldAskIntoPresence(
  derived: ConversationPresenceResult,
  ask: LinkedOpenAsk | null
): ConversationPresenceResult {
  if (!ask) return derived;
  if (derived.presence !== "IDLE") return derived;
  return { ...derived, presence: "NEEDS_INPUT", needsInputReason: "ask" };
}

/** Options accepted by {@link mountConversationPresenceRoutes}. */
export interface ConversationPresenceRoutesOptions {
  /**
   * Injectable readers (mt#3016's lesson: inject the seam explicitly rather
   * than depending on whether a real connection happens to exist in-process).
   * Seamed at the DOMAIN-FUNCTION level, not at the raw `db` handle, so a test
   * supplies plain values instead of mocking drizzle's query builder.
   *
   * `getRunState` returning `undefined` (as opposed to `null`) means "no store"
   * — the 503 path. `null` means "store reached, no row" — the `UNKNOWN` path.
   * The two are deliberately distinguishable: collapsing them is precisely the
   * silent-failure class (mt#3019 / mt#3046) this route must not reproduce.
   */
  getRunState?: (conversationId: string) => Promise<ConversationRunStateRecord | null | undefined>;
  findOpenAsk?: (conversationId: string) => Promise<LinkedOpenAsk | null>;
  isKnownWorkspaceId?: (id: string) => Promise<boolean>;
  /** Override the clock (used in tests). */
  now?: () => Date;
}

/** Mount the conversation-presence read route on `app`. */
export function mountConversationPresenceRoutes(
  app: express.Express,
  options: ConversationPresenceRoutesOptions = {}
): void {
  const now = options.now ?? (() => new Date());

  const defaultGetRunState = async (
    conversationId: string
  ): Promise<ConversationRunStateRecord | null | undefined> => {
    const db = await getPresenceDb();
    if (!db) return undefined;
    return getConversationRunState(db, conversationId);
  };

  const defaultFindOpenAsk = async (conversationId: string): Promise<LinkedOpenAsk | null> => {
    const db = await getPresenceDb();
    if (!db) return null;
    return findOpenAskForConversation(db, conversationId);
  };

  const defaultIsKnownWorkspaceId = async (id: string): Promise<boolean> => {
    const provider = await getServerSessionProvider();
    if (!provider) return false;
    return Boolean(await provider.getSession(id));
  };

  const getRunState = options.getRunState ?? defaultGetRunState;
  const findOpenAsk = options.findOpenAsk ?? defaultFindOpenAsk;
  const isKnownWorkspaceId = options.isKnownWorkspaceId ?? defaultIsKnownWorkspaceId;

  app.get("/api/conversation/:id/presence", async (req, res) => {
    const conversationId = req.params.id;

    // A syntactically-impossible conversation id can never resolve, so reject
    // it with zero I/O (mt#3131). The copy deliberately does NOT hedge with
    // "may still be running" — that phrasing only makes sense for a plausible
    // id, and using it here is the misleading-empty-state defect mt#3131 fixed.
    if (!looksLikeConversationId(conversationId)) {
      presenceError(res, 404, "invalid_id", `"${conversationId}" is not a valid conversation id.`);
      return;
    }

    let row: ConversationRunStateRecord | null | undefined;
    try {
      row = await getRunState(conversationId);
    } catch (err) {
      // Never swallow a dependency failure into a looks-like-nothing-to-do
      // value: log the ACTUAL error and answer 503 rather than a confident
      // `UNKNOWN`.
      log.error("[conversation-presence] run-state read failed", {
        conversationId,
        error: getLoggableErrorSummary(err),
      });
      presenceError(
        res,
        503,
        "store_unavailable",
        // The `store_unavailable` CODE is the contract clients branch on and is
        // unchanged (mt#3687); only the human-facing message gains the cause.
        `Presence store is unavailable. ${await describeServerPersistenceUnavailability()}`
      );
      return;
    }

    if (row === undefined) {
      // Store unreachable. `UNKNOWN` means "no telemetry for this
      // conversation"; it must never stand in for "we could not reach the
      // store".
      log.warn("[conversation-presence] no SQL provider available", { conversationId });
      presenceError(
        res,
        503,
        "store_unavailable",
        // The `store_unavailable` CODE is the contract clients branch on and is
        // unchanged (mt#3687); only the human-facing message gains the cause.
        `Presence store is unavailable. ${await describeServerPersistenceUnavailability()}`
      );
      return;
    }

    if (row === null) {
      // Before answering UNKNOWN, distinguish the id-space mistake: a
      // WORKSPACE session id passed where a conversation id belongs would
      // otherwise render as an honest-looking "no telemetry", hiding a
      // caller bug (mt#2420 / mt#2525).
      const missClass = await classifySnapshotMiss(conversationId, isKnownWorkspaceId);
      if (missClass === "wrong_id_space") {
        presenceError(res, 422, "wrong_id_space", WRONG_ID_SPACE_MESSAGE);
        return;
      }
    }

    const derived = derivePresence(row, now());

    // The Ask join is best-effort by construction: it needs a
    // `minsky_session_links` row, which cannot exist until the conversation
    // is ingested (measured 2026-07-24: 27% of tracked conversations had
    // one). A failure or a miss must degrade to "no ask resolvable", NEVER
    // to a claim that no ask exists.
    let ask: LinkedOpenAsk | null = null;
    try {
      ask = await findOpenAsk(conversationId);
    } catch (err) {
      log.warn("[conversation-presence] ask join failed; reporting without ask enrichment", {
        conversationId,
        error: getLoggableErrorSummary(err),
      });
    }

    const body: ConversationPresenceResponse = {
      ...foldAskIntoPresence(derived, ask),
      conversationId,
      ask,
    };
    res.json(body);
  });
}
