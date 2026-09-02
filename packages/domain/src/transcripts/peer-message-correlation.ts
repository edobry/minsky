/**
 * peer-message-correlation — pair a sender's `SendMessage` tool call with the
 * delivery it produced on the receiving side.
 *
 * Sibling of {@link ./peer-message-origin}, which projects ONE delivered
 * message off its `origin` object. This module joins the two HALVES of a
 * cross-session message: the sender's `tool_use` block and the receiver's
 * `user` line, which live in different conversations and share no identifier.
 *
 * ## Neither of the obvious keys exists on both sides
 *
 * `msg_id` and `verifiedPeerPid` are the two fields that look like correlation
 * keys, and both are RECEIVER-ONLY. Measured over production 2026-09-01:
 *
 * ```
 * 341 SendMessage turns
 *   0 carrying msg_id anywhere in tool_calls
 *   4 carrying any tool_result at all
 * ```
 *
 * The sender's stored payload is `{id, name, type, input: {to, recipient, type,
 * content, message, summary}, caller}` — a recipient AGENT ID, never a socket
 * path, a session uuid, or a message id. So there is no id-to-id join to make.
 *
 * ## The key that does work: exact message text, inside a time window
 *
 * The sender stores the text at `input.message`; the receiver stores it at
 * `origin.body`. Joined on exact equality over the whole corpus
 * (2026-09-02): **11 of 11 receiver lines matched a sender's `input.message`
 * exactly**, each to exactly one send under the window below.
 *
 * ## What the window is FOR — and what it cannot do
 *
 * The window does not disambiguate duplicates, and it must not be described as
 * if it did. Measured 2026-09-02: 3 messages were sent more than once (7 blocks
 * across those groups), and the minimum gap between two identical sends is
 * **0.000s** — one turn fanning the same text to two recipients stamps both at
 * the same instant. No time bound can separate those, so a body matching more
 * than one send resolves to {@link PeerCorrelation} `"ambiguous"`, never to a
 * pick. That is SC5's "never resolved by guess", and it is a permanent property
 * of the data rather than a limitation of this corpus.
 *
 * What the window DOES do is stop a delivery from pairing with an unrelated
 * identical send far in the past — a real hazard once the same short message
 * ("done", "ack") is sent across months.
 *
 * ## Why the window is 5 minutes, and why that is not a round number
 *
 * It is the harness's own `dialogExpiry` default, recorded from Claude Code's
 * cross-session-messaging documentation during mt#4874's planning read
 * (2026-09-01): a message the receiver holds expires after five minutes and can
 * no longer be delivered. So a delivery landing more than one `dialogExpiry`
 * after the send's turn ended cannot be that send's message — the bound is the
 * mechanism's declared maximum, not a measured typical
 * (`decision-defaults.mdc §Thresholds`, the CEILING case).
 *
 * The observed distribution corroborates it without setting it. Delivery lands
 * 1.8s to 208.0s after the sender's turn ENDS (median 2.4s), and 11.5s to
 * 216.8s after it starts — comfortably inside 300s, with the tail explained by
 * turn granularity rather than transport: a send early in a long turn is
 * stamped with that whole turn's boundaries.
 *
 * ## Timestamps bound an INTERVAL, not an instant
 *
 * A turn's timestamps say when the TURN ran, not when the send inside it
 * happened, so a send is compatible with a delivery landing anywhere from the
 * turn's start to one `dialogExpiry` past its end. Both bounds are needed: the
 * lower one because a delivery cannot precede its send, the upper because of
 * expiry. One production turn carries a null `started_at` with a non-null
 * `ended_at`, so each bound falls back to the other rather than dropping the
 * send from consideration.
 *
 * @see mt#4874 — this file
 * @see ./peer-message-origin — the receiver-side projection this consumes
 */
import type { PeerFromKind, PeerMessageOrigin } from "./peer-message-origin";

/**
 * How long after a send's turn ends a delivery may still be attributed to it.
 *
 * Claude Code's `dialogExpiry` default — see the module docblock. Exported so a
 * caller can widen it deliberately (and so a test can shrink it) rather than
 * re-deriving the reasoning at the call site.
 */
export const PEER_PAIRING_WINDOW_MS = 5 * 60 * 1000;

/** The harness tool name a cross-session send is recorded under. */
export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

/** One `SendMessage` tool-use block, as read off a turn's `tool_calls`. */
export interface SentPeerMessage {
  /** The conversation that made the call. */
  agentSessionId: string;
  turnIndex: number;
  /** Position of this block within the turn's `tool_calls` array. */
  ordinal: number;
  /** Whom the sender addressed — an agent id or name, never a socket path. */
  recipient: string | null;
  /** `input.message` — the text that will arrive as the receiver's `origin.body`. */
  message: string | null;
  /** Turn start, in epoch ms; null when the turn carried none. */
  startedAtMs: number | null;
  /** Turn end, in epoch ms; null when the turn carried none. */
  endedAtMs: number | null;
}

/** One delivered message, as read off a receiver's raw `user` line. */
export interface ReceivedPeerMessage {
  /** The conversation the message was delivered INTO. */
  agentSessionId: string;
  lineOrdinal: number;
  /** The line's own timestamp, in epoch ms; null when it carried none. */
  receivedAtMs: number | null;
  origin: PeerMessageOrigin;
}

/**
 * What is known about an entry's counterpart.
 *
 * `"unmatched"` is deliberately not called "undelivered" or "lost". For a
 * `sent` entry it means only that no delivery record was FOUND, which has at
 * least six documented non-delivery causes plus one coverage cause — see
 * {@link PeerMessageFeed}'s notes. For a `received` entry it means the send was
 * not found, which is usually a sender conversation this machine never ingested.
 */
export type PeerCorrelation =
  | { state: "paired"; counterpartKey: string }
  | { state: "ambiguous"; candidateCount: number }
  | { state: "unmatched" };

/** One row of the time-ordered feed (SC4), tagged with its direction. */
export interface PeerMessageFeedEntry {
  /** Stable identity, unique across both directions; also the pairing ref. */
  key: string;
  direction: "sent" | "received";
  /** ISO timestamp this entry is ordered by; null when the source carried none. */
  at: string | null;
  agentSessionId: string;
  /** The message text — `input.message` when sent, `origin.body` when received. */
  body: string | null;
  /** Sent only: whom the sender addressed. */
  recipient: string | null;
  /** Received only: the projected envelope. */
  origin: PeerMessageOrigin | null;
  /**
   * Received only: which sense of "peer" this is, lifted out of {@link origin}
   * so a consumer can group without reaching into it (SC8).
   */
  fromKind: PeerFromKind | null;
  correlation: PeerCorrelation;
}

export interface PeerMessageFeed {
  entries: PeerMessageFeedEntry[];
  counts: {
    sent: number;
    received: number;
    paired: number;
    ambiguous: number;
    /** Sent entries with no delivery record found. NOT a failure count. */
    sentUnmatched: number;
    /** Received entries whose sender conversation was not found. */
    receivedUnmatched: number;
  };
}

export function sentKey(sent: SentPeerMessage): string {
  return `sent:${sent.agentSessionId}:${sent.turnIndex}:${sent.ordinal}`;
}

export function receivedKey(received: ReceivedPeerMessage): string {
  return `received:${received.agentSessionId}:${received.lineOrdinal}`;
}

/** Lower bound of the interval a send could have happened in. */
function sendWindowStart(sent: SentPeerMessage): number | null {
  return sent.startedAtMs ?? sent.endedAtMs;
}

/** Upper bound, before the expiry window is added. */
function sendWindowEnd(sent: SentPeerMessage): number | null {
  return sent.endedAtMs ?? sent.startedAtMs;
}

/**
 * Could this delivery have come from this send?
 *
 * Text equality is necessary but never sufficient — a missing timestamp on
 * either side leaves the interval untestable, and pairing on text alone would
 * be exactly the guess SC5 forbids. So an untestable pair is NOT a candidate.
 */
function isCandidate(
  sent: SentPeerMessage,
  received: ReceivedPeerMessage,
  windowMs: number
): boolean {
  if (sent.message === null || received.origin.body === null) return false;
  if (sent.message !== received.origin.body) return false;

  const receivedAt = received.receivedAtMs;
  const start = sendWindowStart(sent);
  const end = sendWindowEnd(sent);
  if (receivedAt === null || start === null || end === null) return false;

  return receivedAt >= start && receivedAt <= end + windowMs;
}

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Sort newest-first, with undated entries last rather than dropped.
 *
 * An entry whose source carried no timestamp is still a real message; sorting
 * it out of existence would be the same silent loss this module's correlation
 * rules refuse elsewhere. The key tiebreak keeps the order stable across polls.
 */
function byRecencyThenKey(a: PeerMessageFeedEntry, b: PeerMessageFeedEntry): number {
  if (a.at === null && b.at === null) return a.key.localeCompare(b.key);
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  if (a.at === b.at) return a.key.localeCompare(b.key);
  return a.at < b.at ? 1 : -1;
}

/**
 * Build the correlated, time-ordered feed.
 *
 * Pure — the widget owns the queries, this owns the join. That split is what
 * lets the pairing rules be tested against captured shapes with no database,
 * which matters because the rules encode measured properties of the corpus
 * (see the module docblock) rather than anything a type could enforce.
 *
 * Correlation is decided SYMMETRICALLY, and an entry is `paired` only when the
 * relationship is one-to-one in BOTH directions: a delivery with a single
 * candidate send, whose send is claimed by that delivery alone. Anything else
 * with a non-empty candidate set is `ambiguous`. Checking only one direction
 * would call a send "paired" while two deliveries both claimed it.
 */
export function correlatePeerMessages(
  sent: readonly SentPeerMessage[],
  received: readonly ReceivedPeerMessage[],
  options?: { windowMs?: number }
): PeerMessageFeed {
  const windowMs = options?.windowMs ?? PEER_PAIRING_WINDOW_MS;

  // Candidate sends per delivery, and the reverse: deliveries claiming a send.
  const candidatesByReceived = new Map<string, SentPeerMessage[]>();
  const claimantsBySent = new Map<string, ReceivedPeerMessage[]>();

  for (const r of received) {
    const rKey = receivedKey(r);
    const candidates = sent.filter((s) => isCandidate(s, r, windowMs));
    candidatesByReceived.set(rKey, candidates);
    for (const s of candidates) {
      const sKey = sentKey(s);
      const claimants = claimantsBySent.get(sKey);
      if (claimants) claimants.push(r);
      else claimantsBySent.set(sKey, [r]);
    }
  }

  /**
   * Decide one entry's correlation from its own candidate count and, when that
   * count is exactly one, the counterpart's.
   *
   * The order of these branches is the whole rule. A non-zero candidate set can
   * never resolve to `"unmatched"` — that would report "no counterpart found"
   * about an entry whose counterpart plainly exists and merely cannot be
   * identified. Only an EMPTY candidate set is unmatched; everything else is
   * either exclusively paired or ambiguous.
   *
   * `counterpart` is supplied only in the one-candidate case, so its `null` here
   * is unreachable in practice; it resolves to `"ambiguous"` rather than
   * `"paired"` so a future caller that stops supplying it degrades toward the
   * cautious answer instead of inventing a pairing.
   */
  function resolve(
    ownCandidates: number,
    counterpart: { key: string; claimants: number } | null
  ): PeerCorrelation {
    if (ownCandidates === 0) return { state: "unmatched" };
    if (ownCandidates > 1) return { state: "ambiguous", candidateCount: ownCandidates };
    if (counterpart === null) return { state: "ambiguous", candidateCount: ownCandidates };
    if (counterpart.claimants > 1) {
      return { state: "ambiguous", candidateCount: counterpart.claimants };
    }
    return { state: "paired", counterpartKey: counterpart.key };
  }

  const receivedEntries: PeerMessageFeedEntry[] = received.map((r) => {
    const rKey = receivedKey(r);
    const candidates = candidatesByReceived.get(rKey) ?? [];
    const only = candidates.length === 1 ? candidates[0] : undefined;
    const counterpart =
      only === undefined
        ? null
        : { key: sentKey(only), claimants: (claimantsBySent.get(sentKey(only)) ?? []).length };
    return {
      key: rKey,
      direction: "received" as const,
      at: toIso(r.receivedAtMs),
      agentSessionId: r.agentSessionId,
      body: r.origin.body,
      recipient: null,
      origin: r.origin,
      fromKind: r.origin.fromKind,
      correlation: resolve(candidates.length, counterpart),
    };
  });

  const sentEntries: PeerMessageFeedEntry[] = sent.map((s) => {
    const sKey = sentKey(s);
    const claimants = claimantsBySent.get(sKey) ?? [];
    const only = claimants.length === 1 ? claimants[0] : undefined;
    const counterpart =
      only === undefined
        ? null
        : {
            key: receivedKey(only),
            claimants: (candidatesByReceived.get(receivedKey(only)) ?? []).length,
          };
    return {
      key: sKey,
      direction: "sent" as const,
      // A send is ordered by when its turn ENDED — the latest instant it could
      // have happened — falling back to the start so an entry is never undated
      // merely because one bound is missing.
      at: toIso(s.endedAtMs ?? s.startedAtMs),
      agentSessionId: s.agentSessionId,
      body: s.message,
      recipient: s.recipient,
      origin: null,
      fromKind: null,
      correlation: resolve(claimants.length, counterpart),
    };
  });

  const entries = [...sentEntries, ...receivedEntries].sort(byRecencyThenKey);

  return {
    entries,
    counts: {
      sent: sentEntries.length,
      received: receivedEntries.length,
      paired: entries.filter((e) => e.correlation.state === "paired").length,
      ambiguous: entries.filter((e) => e.correlation.state === "ambiguous").length,
      sentUnmatched: sentEntries.filter((e) => e.correlation.state === "unmatched").length,
      receivedUnmatched: receivedEntries.filter((e) => e.correlation.state === "unmatched").length,
    },
  };
}
