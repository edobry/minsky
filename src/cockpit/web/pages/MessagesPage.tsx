/**
 * MessagesPage — the "/messages" route (mt#4874).
 *
 * Cross-session peer messages, both halves against each other: what this
 * project's conversations SENT (a `SendMessage` tool call) and what they
 * RECEIVED (a delivered message carrying a structured `origin` envelope).
 *
 * The interesting thing this can show is the PAIRING, and specifically where it
 * fails. The sender's transcript records attempts; the receiver's records only
 * deliveries — so a send with no matching delivery is signal rather than a gap
 * in the page.
 *
 * ## Three renderings this page deliberately refuses
 *
 * 1. **`sent - received` as an undelivered count.** The gap is real and its
 *    composition is unmeasured: a send to a subagent lands in that subagent's
 *    transcript, and whether that transcript was ingested is a different
 *    question from whether the message arrived. The vendor documentation adds
 *    held, refused, expired, over-size, burst and loop-throttled outcomes. So an
 *    unpaired send says "no delivery record found" and is never totalled.
 * 2. **A guessed pairing.** When a body matches more than one send in the
 *    window the row says so; it does not pick one. Two identical sends stamped
 *    at the same instant are a measured property of the corpus, not a corner
 *    case.
 * 3. **A silent empty state.** Most projects have no cross-session traffic at
 *    all, so "empty" is the expected reading and has to be distinguishable from
 *    "something is broken" and from "this view cannot see it".
 *
 * ## Volume is a design constraint, not a caveat
 *
 * 12 deliveries and ~348 sends in the entire corpus. This is a page that must
 * be honest when empty, not one that assumes a stream.
 *
 * @see mt#4874 — this page
 * @see ../../widgets/messages.ts — payload shape + the coverage accounting
 * @see @minsky/domain/transcripts/peer-message-correlation — the pairing rules
 */
import { EntityRef } from "../components/EntityRef";
import { useMessages } from "../hooks/useMessages";
import { relativeTime } from "../lib/format";
import type { MessagesCoverage } from "../hooks/useMessages";
import type {
  PeerCorrelation,
  PeerMessageFeedEntry,
} from "@minsky/domain/transcripts/peer-message-correlation";

// ---------------------------------------------------------------------------
// Coverage — SC10: the limits are on the PAGE, not only in the spec.
// ---------------------------------------------------------------------------

/**
 * What this view cannot see, stated where it is read.
 *
 * Rendered in every state including the empty one — an operator looking at an
 * empty feed is exactly the person who needs to know whether "no messages"
 * means no traffic or no coverage.
 */
export function CoverageNotice({ coverage }: { coverage: MessagesCoverage }) {
  return (
    <section
      className="mb-4 rounded-md border border-border bg-card p-3"
      data-testid="messages-coverage"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
        What this view can and cannot see
      </h2>
      <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
        <li>
          <span className="text-foreground">Local transcripts only.</span> A message appears here
          only if at least one endpoint is a conversation ingested on this machine. Two remote or
          cloud sessions messaging each other are invisible.
        </li>
        <li>
          <span className="text-foreground">Not real-time.</span> Latency is the transcript
          watcher&apos;s debounce plus ingest, so a message sent seconds ago may not be here yet.
        </li>
        <li>
          <span className="text-foreground">Held and refused messages never arrive at all.</span>{" "}
          They exist only on the sender&apos;s side, so they appear here as a send with no delivery
          record — not as a delivery.
        </li>
        {coverage.envelopesMissing > 0 ? (
          <li data-testid="messages-envelope-gap">
            <span className="text-warn-amber">
              {coverage.envelopesMissing} of {coverage.peerTurns} known deliveries
            </span>{" "}
            have no indexed envelope, so they cannot be shown in detail. This is transcript-line
            coverage, not a lost message.
          </li>
        ) : null}
        {coverage.senderScanTruncated ? (
          <li data-testid="messages-scan-truncated">
            <span className="text-warn-amber">Older sends are not shown.</span> This view reads the
            newest {coverage.senderScanLimit} sends; the corpus now has more.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Feed rows
// ---------------------------------------------------------------------------

function DirectionBadge({ direction }: { direction: PeerMessageFeedEntry["direction"] }) {
  const sent = direction === "sent";
  return (
    <span
      className={`rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${
        sent ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary"
      }`}
      data-testid={`messages-direction-${direction}`}
    >
      {sent ? "Sent" : "Received"}
    </span>
  );
}

/**
 * SC8 — a session peer and an in-session agent are NOT the same thing, and
 * `origin.kind` is `peer` for both. Merging them would present a subagent's
 * message as if it came from another of the operator's terminals.
 */
function PeerKindBadge({ fromKind }: { fromKind: NonNullable<PeerMessageFeedEntry["fromKind"]> }) {
  const isSession = fromKind === "session";
  return (
    <span
      className={`rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${
        isSession ? "bg-primary/10 text-primary" : "bg-warn-amber/15 text-warn-amber"
      }`}
      data-testid={`messages-peer-kind-${fromKind}`}
      title={
        isSession
          ? "Another Claude Code session on this machine, over a Unix socket"
          : "A teammate or subagent inside one session"
      }
    >
      {isSession ? "Session peer" : "In-session agent"}
    </span>
  );
}

/** How the counterpart resolved — including, deliberately, when it did not. */
function CorrelationBadge({
  correlation,
  direction,
}: {
  correlation: PeerCorrelation;
  direction: PeerMessageFeedEntry["direction"];
}) {
  if (correlation.state === "paired") {
    return (
      <span className="text-[10px] text-muted-foreground" data-testid="messages-correlation-paired">
        {direction === "sent" ? "delivery recorded" : "matched to a send"}
      </span>
    );
  }
  if (correlation.state === "ambiguous") {
    return (
      <span className="text-[10px] text-warn-amber" data-testid="messages-correlation-ambiguous">
        ambiguous — {correlation.candidateCount} identical candidates, not resolved
      </span>
    );
  }
  return (
    <span className="text-[10px] text-muted-foreground" data-testid="messages-correlation-unmatched">
      {/* Never "undelivered" or "lost" — see the module docblock. */}
      {direction === "sent" ? "no delivery record found" : "no matching send found"}
    </span>
  );
}

export function MessageRow({ entry }: { entry: PeerMessageFeedEntry }) {
  return (
    <li
      className="border-b border-border/50 last:border-0 py-2"
      data-testid={`messages-row-${entry.key}`}
    >
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <DirectionBadge direction={entry.direction} />
        {entry.fromKind ? <PeerKindBadge fromKind={entry.fromKind} /> : null}
        <span className="text-xs text-muted-foreground" title={entry.at ?? undefined}>
          {entry.at === null ? "no timestamp" : relativeTime(entry.at)}
        </span>
        <CorrelationBadge correlation={entry.correlation} direction={entry.direction} />
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs mb-1">
        <span className="text-muted-foreground">
          {entry.direction === "sent" ? "from" : "in"}
        </span>
        <EntityRef type="conversation" id={entry.agentSessionId} />
        {entry.direction === "sent" && entry.recipient !== null ? (
          <>
            <span className="text-muted-foreground">to</span>
            <span className="font-mono text-foreground" data-testid="messages-recipient">
              {entry.recipient}
            </span>
          </>
        ) : null}
        {entry.origin?.name ? (
          <>
            <span className="text-muted-foreground">from</span>
            <span className="font-mono text-foreground" data-testid="messages-sender-name">
              {entry.origin.name}
            </span>
          </>
        ) : null}
      </div>

      {entry.body === null ? (
        <p className="text-xs italic text-muted-foreground" data-testid="messages-body-unreadable">
          message text not readable on this record
        </p>
      ) : (
        <p className="text-xs text-foreground whitespace-pre-wrap break-words line-clamp-4">
          {entry.body}
        </p>
      )}

      {/* Receiver-side facts, recorded and displayed — but NOT join keys: the
          sender carries neither, which is why correlation is on text. */}
      {entry.origin !== null ? (
        <div
          className="mt-1 flex flex-wrap gap-x-3 text-[10px] font-mono text-muted-foreground"
          data-testid="messages-origin-facts"
        >
          <span>from: {entry.origin.from}</span>
          {entry.origin.peerPid !== null ? <span>pid: {entry.origin.peerPid}</span> : null}
          {entry.origin.msgId !== null ? <span>msg_id: {entry.origin.msgId}</span> : null}
          {entry.origin.senderTaskId !== null ? (
            <span>task: {entry.origin.senderTaskId}</span>
          ) : null}
          {entry.origin.hopChain !== null ? (
            <span>hops: {entry.origin.hopChain.join(" → ")}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MessagesPage() {
  const { data, isLoading, isError, error } = useMessages();

  return (
    <div className="p-4 w-full max-w-5xl mx-auto" data-testid="messages-page">
      <header className="mb-4">
        <h1 className="text-h1 font-semibold text-foreground m-0">Messages</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Cross-session peer messages for this project — what was sent, what was delivered, and
          which halves line up. Both sides come from transcripts already ingested; nothing here
          binds a socket or intercepts a message in flight.
        </p>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="messages-loading">
          Loading…
        </p>
      ) : null}

      {/* A live query failure must never look like an empty feed — this corner
          of the cockpit rendered healthy zeros for five weeks while every query
          under it threw (mt#2076 / mt#2757). */}
      {isError ? (
        <div
          className="rounded-md border border-warn-red/40 bg-warn-red/10 p-3 text-sm text-foreground"
          role="alert"
          data-testid="messages-error"
        >
          <div className="font-semibold text-warn-red mb-1">Data unavailable</div>
          <div>{error instanceof Error ? error.message : "Failed to load messages."}</div>
        </div>
      ) : null}

      {data !== undefined ? <CoverageNotice coverage={data.coverage} /> : null}

      {data?.status === "no-data" ? (
        <div
          className="rounded-md border border-border bg-card p-4"
          data-testid="messages-empty"
        >
          <div className="text-sm font-medium text-foreground mb-1">
            No cross-session messages in this project
          </div>
          <p className="text-xs text-muted-foreground">
            This is the expected state for most projects. Messages appear here once one of this
            project&apos;s sessions sends to another with the <code>SendMessage</code> tool, or
            receives one — subject to the coverage limits above.
          </p>
        </div>
      ) : null}

      {data?.status === "ok" ? (
        <>
          <div
            className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mb-2"
            data-testid="messages-counts"
          >
            <span>{data.feed.counts.sent} sent</span>
            <span>{data.feed.counts.received} delivered</span>
            <span>{data.feed.counts.paired} correlated</span>
            {data.feed.counts.ambiguous > 0 ? (
              <span className="text-warn-amber">{data.feed.counts.ambiguous} ambiguous</span>
            ) : null}
            <span>{data.feed.counts.sentUnmatched} sends with no delivery record</span>
          </div>

          <ul className="rounded-md border border-border px-3" data-testid="messages-feed">
            {data.feed.entries.map((entry) => (
              <MessageRow key={entry.key} entry={entry} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
