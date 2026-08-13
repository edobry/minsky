/**
 * What happened to a terminal ask (mt#4091) — the closure notice and the
 * recorded answer, rendered in operator language.
 *
 * Sits ABOVE `<AskDetail readOnly>` on `AskPage`'s terminal branch rather than
 * replacing it. Before mt#4091 this notice WAS the whole terminal branch, which
 * is how resolving an ask came to destroy the operator's view of what it had
 * asked; the body is now always rendered and this component answers only the
 * narrower question the body cannot: how did this end, and what was recorded?
 *
 * The `describeRecordedAnswer` ladder does the classification (see
 * `../lib/ask-response.ts` for the shape census that makes it a ladder); this
 * component only phrases each rung.
 */
import { Prose } from "./Prose";
import { useEntityIndex } from "../lib/use-entity-index";
// Browser-safe import (mt#3239): NOT from "@minsky/domain/ask/close-as-resolved",
// whose sibling exports pull the logger's top-level `process.env` reads into the
// browser bundle. See packages/shared/src/ask-closure.ts.
import { isAutomatedClosureResponder } from "@minsky/shared/ask-closure";
import { describeRecordedAnswer } from "../lib/ask-response";
import type { AskItem, AskState } from "../widgets/AskDetail";

/**
 * Human phrasing for a terminal state. Terminal-vs-open classification itself
 * comes from the domain state machine's `isTerminal` (the single source of
 * truth — note "responded" is NOT terminal: the response is recorded but the
 * ask has not closed, so it still renders the actionable detail view).
 */
export function terminalLabel(state: AskState): string {
  if (state === "expired") return "expired";
  if (state === "cancelled") return "cancelled";
  return "resolved";
}

/** The recorded answer itself, one rung per payload shape. */
function RecordedAnswer({ ask }: { ask: AskItem }) {
  const entityIndex = useEntityIndex();
  const answer = describeRecordedAnswer(ask);

  switch (answer.kind) {
    case "none":
      return null;

    case "option":
      return (
        <div className="text-sm">
          <p className="text-foreground font-medium">{answer.label}</p>
          {answer.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{answer.description}</p>
          )}
        </div>
      );

    case "approval":
      return (
        <p className="text-sm text-foreground font-medium">
          {answer.approved ? "Approved" : "Denied"}
        </p>
      );

    case "message":
      return <Prose entityIndex={entityIndex}>{answer.message}</Prose>;

    case "policy":
      return (
        <div className="text-sm">
          <p className="text-foreground font-medium">Resolved by policy</p>
          <p className="text-xs text-muted-foreground mt-0.5 font-mono break-words">
            {answer.citation}
          </p>
        </div>
      );

    case "systemClosure":
      return (
        <div className="text-sm">
          <p className="text-foreground">Closed because {answer.signal}.</p>
          {answer.detail.length > 0 && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {answer.detail.map((entry) => (
                <div key={entry.key} className="contents">
                  <dt className="font-medium">{entry.key}:</dt>
                  <dd className="font-mono break-words">{entry.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      );

    case "raw":
      return (
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            Raw response record — this payload matches no known response shape:
          </p>
          <pre className="text-xs bg-muted/40 border border-border rounded p-2 overflow-x-auto">
            {answer.json}
          </pre>
        </div>
      );
  }
}

export function TerminalAskNotice({ ask }: { ask: AskItem }) {
  // mt#3215: a system-driven closure (e.g. the stale-suspended-close sweep's
  // parent-terminal signal) leaves `ask.response` populated — the SAME field a
  // genuine operator answer populates — so this must not render the two
  // identically. `isAutomatedClosureResponder` is the single source of truth
  // both this surface and `formatAskWaitMessage` (the agent-facing wait tool)
  // use to tell them apart. The ask#6024 incident: an operator opened this page
  // to answer a pending authorization and was told it had "already been
  // responded to" — it had actually been auto-closed, unanswered, when its
  // parent task went terminal.
  const autoClosed = ask.response ? isAutomatedClosureResponder(ask.response.responder) : false;
  const respondedAt = ask.respondedAt ? new Date(ask.respondedAt).toLocaleString() : null;

  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-2">
      <p className="text-sm text-muted-foreground">
        {autoClosed
          ? "This ask was auto-closed by the system — it was NOT answered by an operator."
          : `This ask was ${terminalLabel(ask.state)}.`}
      </p>
      {ask.response ? (
        <>
          <p className="text-xs text-muted-foreground">
            {autoClosed
              ? `Auto-closed by ${ask.response.responder} (not an operator response)`
              : `Response${ask.response.responder ? ` — by ${ask.response.responder}` : ""}`}
            {respondedAt ? ` on ${respondedAt}` : ""}:
          </p>
          <RecordedAnswer ask={ask} />
        </>
      ) : null}
    </div>
  );
}
