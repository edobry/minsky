/**
 * AskDetail widget + Ask API surface (mt#2410).
 *
 * Extracted verbatim from AsksPage.tsx so the detail body can render in the
 * URL-addressable entity-tab frame (/ask/:id, AskPage) per the mt#2398 PR2
 * unification — sibling of TaskDetail / SessionDetail / MemoryDetail in the
 * widgets/ convention. AsksPage keeps the list; this module owns the shared
 * Ask types, the /api/asks fetch/mutate helpers, the kind styling, and the
 * detail panel component.
 */
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { PendingButton } from "../components/PendingButton";
import { ErrorState } from "../components/ErrorState";
import { Prose } from "../components/Prose";
import { CopyId } from "../components/CopyId";
import { EntityRef } from "../components/EntityRef";
import { useEntityIndex } from "../lib/use-entity-index";
import { LinkifiedText } from "../lib/entity-linkifier";
import { formatRequestor } from "../lib/entity-labels";
import { Link } from "react-router-dom";
import { entityToPath, type RoutableEntityType } from "../lib/entity-codec";
import { stripOptionLetterPrefix } from "@minsky/shared/ask-option-label";
import { resolveChosenOption } from "../lib/ask-response";
import { readCredentialRequest } from "@minsky/shared/credential-request";
import { CredentialRequestForm } from "./CredentialRequestForm";

// ---------------------------------------------------------------------------
// Types — mirrors of server Ask shape (no server imports on frontend)
// ---------------------------------------------------------------------------

export type AskKind =
  | "capability.escalate"
  | "information.retrieve"
  | "authorization.approve"
  | "direction.decide"
  | "coordination.notify"
  | "quality.review"
  | "stuck.unblock";

export type AskState =
  | "detected"
  | "classified"
  | "routed"
  | "suspended"
  | "responded"
  | "closed"
  | "cancelled"
  | "expired";

export interface AskOption {
  label: string;
  /**
   * Machine-readable value recorded in the response payload when an operator
   * picks this option.
   *
   * REQUIRED deliberately, and this is a constraint on CONSTRUCTION rather than
   * a description of every stored row — see `packages/domain/src/ask/types.ts`
   * for the full reasoning. `askOptionSchema` (mt#3181) defaults an omitted
   * `value` to `label` at the CLI/MCP boundary, so every ask created through a
   * command has one; a TypeScript caller building an `AskOption` directly does
   * not go through that boundary and must supply it.
   *
   * Exactly ONE stored ask predates the normalization and has options without a
   * `value` — ask#5769, closed, the ask mt#3181 was filed about (measured
   * 2026-08-13: 1 of 183 asks carrying options). Do NOT widen this field to
   * accommodate it; the two `value === undefined` branches below already render
   * it correctly, and widening would reverse a documented decision.
   */
  value: unknown;
  description?: string;
}

export interface ContextRef {
  kind: string;
  ref: string;
  description?: string;
}

/** Ask contextRef kinds that resolve to an in-SPA entity detail route (mt#2942). */
const ROUTABLE_CONTEXT_KINDS = new Set<RoutableEntityType>([
  "task",
  "ask",
  "session",
  "memory",
  "changeset",
  "conversation",
]);

/**
 * Resolve an Ask contextRef to a clickable destination (mt#2942). Entity refs
 * route to their in-SPA detail page; a `notion` ref opens the Notion doc in the
 * operator's browser (the tray's external-link handler routes it there).
 * Everything else (e.g. `file`) has no reliable target and stays plain text.
 */
function contextRefHref(kind: string, ref: string): { href: string; external: boolean } | null {
  if (kind === "notion") {
    // Accept a pasted full Notion URL as-is; otherwise treat the ref as a page
    // id (32-hex, optionally dashed) and build the canonical www.notion.so URL.
    if (/^https?:\/\//i.test(ref)) return { href: ref, external: true };
    const id = ref.replace(/-/g, "");
    if (!/^[0-9a-fA-F]{32}$/.test(id)) return null;
    return { href: `https://www.notion.so/${id}`, external: true };
  }
  if (ROUTABLE_CONTEXT_KINDS.has(kind as RoutableEntityType)) {
    return { href: entityToPath(kind as RoutableEntityType, ref), external: false };
  }
  return null;
}

/** Recorded response on a terminal ask (mt#2669). */
export interface AskResponse {
  responder: string;
  payload: unknown;
}

export interface AskItem {
  id: string;
  /** ask#N short id (mt#2965) — absent for legacy asks pre-backfill. */
  shortId?: string;
  kind: AskKind;
  state: AskState;
  title: string;
  question: string;
  requestor: string;
  routingTarget?: string;
  parentTaskId?: string;
  parentSessionId?: string;
  options?: AskOption[];
  contextRefs?: ContextRef[];
  deadline?: string;
  createdAt: string;
  suspendedAt?: string;
  windowKey?: string;
  windowMissedCount: number;
  serviceStrategy?: "asap" | "scheduled" | "deadline-bound";
  metadata: Record<string, unknown>;
  /**
   * Present for terminal asks — on the per-id endpoint (mt#2669) and, since
   * mt#4092, on a state-filtered list too.
   */
  response?: AskResponse | null;
  respondedAt?: string;
  closedAt?: string;
}

export interface AsksListResponse {
  asks: AskItem[];
  /**
   * On the default (pending) list this is the number of rows returned. On a
   * state-filtered list it is the TRUE match count before the cap — read
   * `returned` for the array length and `truncated` for whether rows were cut
   * (mt#4092; same convention as the `asks_list` MCP command).
   */
  total: number;
  returned?: number;
  truncated?: boolean;
}

/** Thrown by fetchAskById on a 404 — the id does not exist at all (mt#2669). */
export class AskNotFoundError extends Error {
  constructor(id: string) {
    super(`Ask ${id} not found`);
    this.name = "AskNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/** The pending operator decision queue — `GET /api/asks` with no filter. */
export async function fetchAsks(): Promise<AsksListResponse> {
  return getAsksList("/api/asks");
}

/**
 * Terminal asks — closed, cancelled, or expired (mt#4092).
 *
 * A SEPARATE function rather than an optional parameter on `fetchAsks`, because
 * `fetchAsks` is passed directly as a TanStack `queryFn` in three widgets
 * (TriageBand, Agents, Workstreams) and a query function is invoked with a
 * `QueryFunctionContext`. An optional params object would put that context in
 * the parameter position at every one of those call sites — harmless today only
 * because the context happens to carry no matching keys. Two named functions
 * make the misuse unrepresentable instead of merely unlikely.
 *
 * The endpoint expands `terminal` to every terminal state: an operator looking
 * for an ask they resolved does not know which of the three it landed in.
 */
export async function fetchTerminalAsks(limit?: number): Promise<AsksListResponse> {
  const query = new URLSearchParams({ state: "terminal" });
  if (limit !== undefined) query.set("limit", String(limit));
  return getAsksList(`/api/asks?${query.toString()}`);
}

async function getAsksList(url: string): Promise<AsksListResponse> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch asks (${res.status})`);
  return res.json() as Promise<AsksListResponse>;
}

/**
 * Fetch one ask by id regardless of state (mt#2669). The deeplink resolution
 * path: unlike the pending list, this returns terminal asks (with their
 * recorded response) and distinguishes "not found" from "not pending".
 */
export async function fetchAskById(id: string): Promise<AskItem> {
  const res = await fetch(`/api/asks/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new AskNotFoundError(id);
  if (!res.ok) throw new Error(`Failed to fetch ask (${res.status})`);
  const body = (await res.json()) as { ask: AskItem };
  return body.ask;
}

/**
 * Compose the operator resolve payload for an option letter (mt#2882 R3 —
 * ONE definition shared by AskPage and the AsksPage inline actions so the
 * two surfaces cannot drift): explicit options map letter → option value;
 * optionless asks map A → approved. `resolvedIn` names the invoking surface.
 */
export function composeResolvePayload(
  ask: Pick<AskItem, "options">,
  optionLetter: string,
  resolvedIn: string
): unknown {
  const letterIndex = optionLetter.charCodeAt(0) - "A".charCodeAt(0);
  let payloadValue: unknown;
  if (ask.options && ask.options.length > 0) {
    const option = ask.options[letterIndex];
    // mt#3181: fall back to `label` when `value` is absent. This surface wrote
    // the empty selection observed on ask#5769 — `option?.value ?? ""` yields
    // "" for an option stored without a value, so the Ask closed as answered
    // with no record of WHICH option the operator picked. `askOptionSchema`
    // now normalizes this at create time; the fallback covers Asks created
    // before that fix, which are still in the store.
    // NOT dead code, though the required `value` type makes it look that way:
    // measured 2026-08-13, exactly one stored ask still has the shape —
    // ask#5769, the one this incident was about. See the `AskOption.value`
    // comment above before deleting this branch.
    // Strict `=== undefined` check (not `??`): `??` also treats an explicitly
    // provided `null` as nullish, which would silently discard a legitimate
    // falsy-but-present machine value (PR #2266 R1 BLOCKING #2). `option`
    // itself can be `undefined` when `optionLetter` is out of range — that
    // case still falls back to `""`.
    const optionValue =
      option === undefined ? "" : option.value === undefined ? option.label : option.value;
    payloadValue = { option: String(optionValue), chosen: String(optionValue) };
  } else {
    payloadValue = { approved: optionLetter === "A" };
  }
  return {
    responder: "operator",
    payload: payloadValue,
    attentionCost: { transport: "inbox", resolvedIn },
  };
}

export async function resolveAsk(id: string, payload: unknown): Promise<void> {
  const res = await fetch(`/api/asks/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`resolve failed (${res.status}): ${text}`);
  }
}

export async function deferAsk(id: string): Promise<void> {
  const res = await fetch(`/api/asks/${id}/defer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`defer failed (${res.status}): ${text}`);
  }
}

export async function escalateAsk(id: string): Promise<void> {
  const res = await fetch(`/api/asks/${id}/escalate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`escalate failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatRelative(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return "unknown";
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function formatDeadlineRemaining(isoDeadline: string | undefined): string | null {
  if (!isoDeadline) return null;
  const deadline = new Date(isoDeadline).getTime();
  const now = Date.now();
  const diffMs = deadline - now;
  if (diffMs <= 0) return "overdue";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m left`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h left`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d left`;
}

export interface KindStyle {
  badge: string;
  label: string;
  priority: string;
}

/**
 * Per-kind badge colors (mt#2917 register pass). Per docs/design-system.md
 * §5.1's red-scarcity rule, a priority badge is classification, not an
 * active alarm — never red, regardless of priority tier. This was the exact
 * mt#2914 audit finding: authorization.approve (P2) rendering bg-destructive
 * at volume across the ask console. P1/P2 now differentiate by amber
 * weight; red stays reserved for genuine escalation (an overdue deadline,
 * a missed-window count — see the isOverdue / windowMissedCount treatments
 * elsewhere in this file, both unchanged).
 */
export function kindStyle(kind: AskKind): KindStyle {
  switch (kind) {
    case "stuck.unblock":
      return {
        badge: "bg-warn-amber text-background font-semibold",
        label: "stuck.unblock",
        priority: "P1",
      };
    case "authorization.approve":
      return {
        badge: "bg-warn-amber/40 text-foreground",
        label: "authorization.approve",
        priority: "P2",
      };
    case "direction.decide":
      return {
        badge: "bg-accent text-accent-foreground",
        label: "direction.decide",
        priority: "P3",
      };
    case "quality.review":
      return {
        badge: "bg-secondary text-secondary-foreground",
        label: "quality.review",
        priority: "P4",
      };
    case "coordination.notify":
      return {
        badge: "bg-muted text-muted-foreground",
        label: "coordination.notify",
        priority: "P5",
      };
    case "capability.escalate":
      return {
        badge: "bg-muted text-muted-foreground",
        label: "capability.escalate",
        priority: "P6",
      };
    case "information.retrieve":
      return {
        badge: "bg-muted text-muted-foreground",
        label: "information.retrieve",
        priority: "P7",
      };
  }
}

export const KIND_PRIORITY: Record<AskKind, number> = {
  "stuck.unblock": 1,
  "authorization.approve": 2,
  "direction.decide": 3,
  "quality.review": 4,
  "coordination.notify": 5,
  "capability.escalate": 6,
  "information.retrieve": 7,
};

// ---------------------------------------------------------------------------
// Ask detail panel
// ---------------------------------------------------------------------------

interface AskDetailBaseProps {
  ask: AskItem;
  /**
   * Renders the "Back" affordance when supplied; omitted entirely when not
   * (mt#4069).
   *
   * Optional because a peek pane brings its own close control — Esc, the pane's
   * button, browser Back. A "Back" inside it would either do nothing (the inert
   * control mt#4069's criteria forbid) or duplicate a control the operator
   * already has. The page supplies it; the peek does not.
   */
  onClose?: () => void;
}

/**
 * Which control the operator clicked, for as long as its request is in flight
 * (mt#4503).
 *
 * This replaced a bare `resolving: boolean`, and the reason is the whole point
 * of the change: a boolean can say THAT something is saving but never WHICH
 * answer, so every option button rendered identically and the only signal was
 * `disabled`. An ask routinely offers three or four options whose labels the
 * operator is choosing between — "did my click land on the one I meant?" is
 * precisely the question the old shape could not answer.
 */
export type AskActionInFlight =
  | { kind: "resolve"; optionLetter: string }
  | { kind: "defer" }
  | { kind: "escalate" };

/** True when `acting` is this specific option's resolve. */
export function isResolvingOption(
  acting: AskActionInFlight | null | undefined,
  optionLetter: string
): boolean {
  return acting?.kind === "resolve" && acting.optionLetter === optionLetter;
}

/**
 * Plain words for the `role="status"` line rendered beside an acting control.
 *
 * The spinner carries WHICH; this carries WHAT, and it is what a screen reader
 * actually announces — `PendingButton`'s spinner is `aria-hidden` precisely so
 * this is the single announcement rather than one of three.
 */
export function describeActionInFlight(acting: AskActionInFlight): string {
  switch (acting.kind) {
    case "resolve":
      return "Saving your response…";
    case "defer":
      return "Deferring…";
    case "escalate":
      return "Escalating…";
  }
}

/** Actionable presentation — the ask is still open and the operator can settle it. */
interface AskDetailActionableProps extends AskDetailBaseProps {
  readOnly?: false;
  onResolve: (ask: AskItem, optionLetter: string) => void;
  onDefer: (ask: AskItem) => void;
  onEscalate: (ask: AskItem) => void;
  /** The control whose request is in flight, or null when idle. */
  acting: AskActionInFlight | null;
  /**
   * The last action's failure, when it failed.
   *
   * Optional so a caller that genuinely cannot fail need not pass it, but every
   * caller wired to `/api/asks/:id/resolve` can: that endpoint answers 403 on a
   * non-operator-routed ask, 404, 409 on a concurrent transition, 500, and 503
   * when persistence is down. Before mt#4503 all five landed in a rejected
   * mutation nobody read, and the operator saw the success rendering.
   */
  actionError?: unknown;
}

/**
 * Read-only presentation (mt#4091) — the same body, with the action row absent
 * rather than disabled, and the answered option marked when there is one.
 *
 * This mode exists because `AskPage`'s terminal branch used to REPLACE the body
 * with a closure notice, so resolving an ask destroyed the operator's ability to
 * see what it had asked (the question, the options and the `contextRefs` were
 * all dropped). Suppressing the actions as a MODE rather than forking the
 * renderer is what keeps that from recurring: there is one component to change
 * when the ask body changes.
 *
 * Discriminated rather than "handlers are optional" so the actionable call site
 * still cannot forget one — omitting `onResolve` without `readOnly: true` is a
 * type error, exactly as it was before this mode existed.
 */
interface AskDetailReadOnlyProps extends AskDetailBaseProps {
  readOnly: true;
}

export type AskDetailProps = AskDetailActionableProps | AskDetailReadOnlyProps;

/**
 * The words beneath an action row: what is happening, or what went wrong
 * (mt#4503).
 *
 * Renders nothing at rest, so an idle ask looks exactly as it did before. The
 * two states are mutually exclusive by construction rather than by convention —
 * a surface clears its error when it starts a new action, so `acting` winning
 * the branch cannot leave a stale failure on screen underneath a live spinner.
 */
function AskActionStatus({
  acting,
  error,
}: {
  acting: AskActionInFlight | null;
  error?: unknown;
}) {
  if (acting !== null) {
    return (
      <p
        role="status"
        className="pt-1.5 text-xs text-muted-foreground"
        data-testid="ask-action-status"
      >
        {describeActionInFlight(acting)}
      </p>
    );
  }
  if (error != null) {
    // Wrapped rather than given a testid directly: `ErrorState` takes a fixed
    // prop set and does not spread the rest, so a `data-testid` on it would not
    // compile. The wrapper is also what keeps the shared primitive's own markup
    // (its `role="alert"`, its `text-destructive` token) untouched.
    return (
      <div data-testid="ask-action-error">
        <ErrorState prefix="Your response was not saved" error={error} className="pt-1.5 text-xs" />
      </div>
    );
  }
  return null;
}

export function AskDetail(props: AskDetailProps) {
  const { ask, onClose } = props;
  /** Non-null exactly when the action row should render; carries its handlers. */
  const actions = props.readOnly === true ? null : props;
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";
  const entityIndex = useEntityIndex();
  /** Which option the recorded response names, so the list can mark it. */
  const chosen = actions === null ? resolveChosenOption(ask) : null;

  /**
   * The credential-request payload when this ask is one (mt#4030).
   *
   * This is the render-mode dispatch the mt#4030 ↔ mt#4447 seam decision names:
   * a `metadata` key selects which control replaces the option buttons. A second
   * payload kind adds a branch here and shares nothing else.
   */
  const credentialRequest = readCredentialRequest(ask);

  const hasOptions =
    (ask.options && ask.options.length > 0) ||
    ask.kind === "authorization.approve" ||
    ask.kind === "quality.review";

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  // A credential request has no letter options: the form owns Save, and Decline
  // is rendered there rather than as a bare "B) Deny". Zeroing the count here
  // rather than gating the button map keeps one source of truth for "how many
  // lettered choices does this ask have".
  const optionCount = credentialRequest
    ? 0
    : ask.options
      ? Math.min(ask.options.length, letters.length)
      : hasOptions
        ? 2
        : 0;

  return (
    <Card className="border-border">
      <CardContent className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${ks.badge}`}>
                {ks.priority} {ask.kind}
              </span>
              {deadlineStr && (
                <span
                  className={`text-xs tabular-nums ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
                >
                  {deadlineStr}
                </span>
              )}
            </div>
            <h3 className="text-sm font-semibold text-foreground">{ask.title}</h3>
          </div>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} className="flex-shrink-0">
              Back
            </Button>
          )}
        </div>

        {/* Question */}
        <div className="rounded-md bg-muted/40 p-3">
          <Prose entityIndex={entityIndex}>{ask.question}</Prose>
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>
            <span className="font-medium">Id:</span>{" "}
            <CopyId type="ask" id={ask.id} displayId={ask.shortId} />
          </div>
          <div>
            <span className="font-medium">From:</span>{" "}
            {(() => {
              // Derived requestor label (mt#2883): ascribed unknown:hash
              // actors render as "unattributed agent" (raw id on hover);
              // declared identities keep the monospace treatment.
              const display = formatRequestor(ask.requestor, ask.parentTaskId ?? null);
              return (
                <span className={display.isAscribed ? "italic" : "font-mono"} title={display.raw}>
                  {display.label}
                </span>
              );
            })()}
          </div>
          <div>
            <span className="font-medium">Age:</span> <span>{formatRelative(ask.createdAt)}</span>
          </div>
          {ask.parentTaskId && (
            <div>
              <span className="font-medium">Task:</span>{" "}
              <EntityRef type="task" id={ask.parentTaskId} />
            </div>
          )}
          {ask.windowKey && (
            <div>
              <span className="font-medium">Window:</span>{" "}
              <span className="font-mono">{ask.windowKey}</span>
            </div>
          )}
          {ask.windowMissedCount > 0 && (
            <div className="text-destructive/80">Missed {ask.windowMissedCount}x</div>
          )}
        </div>

        {/* Context refs */}
        {ask.contextRefs && ask.contextRefs.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Context:</p>
            {ask.contextRefs.map((ref, i) => {
              const link = contextRefHref(ref.kind, ref.ref);
              return (
                <div
                  key={i}
                  className="text-xs text-muted-foreground pl-2 border-l-2 border-border"
                >
                  <span className="font-medium">{ref.kind}:</span>{" "}
                  {link ? (
                    link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-mono text-primary underline-offset-2 hover:underline"
                      >
                        {ref.ref}
                      </a>
                    ) : (
                      <Link
                        to={link.href}
                        className="font-mono text-primary underline-offset-2 hover:underline"
                      >
                        {ref.ref}
                      </Link>
                    )
                  ) : (
                    <span className="font-mono">{ref.ref}</span>
                  )}
                  {ref.description && (
                    <span className="ml-1 text-muted-foreground/70"> — {ref.description}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Options / response affordances */}
        {hasOptions && (
          <div className="space-y-2">
            {ask.options && ask.options.length > 0 && (
              <div className="space-y-1">
                {ask.options.map((opt, i) => {
                  const letter = letters[i] ?? "?";
                  const isChosen = chosen?.index === i;
                  return (
                    <div key={String(opt.value ?? i)} className="flex items-start gap-2 text-sm">
                      <span
                        className={`font-mono w-5 flex-shrink-0 ${isChosen ? "text-foreground font-semibold" : "text-muted-foreground"}`}
                      >
                        {letter})
                      </span>
                      <div>
                        <span className="text-foreground font-medium">
                          {/* The letter is rendered above by this surface, so a
                              producer-supplied "B — " / "[b] " prefix would
                              double it (mt#3253). */}
                          <LinkifiedText
                            text={stripOptionLetterPrefix(opt.label)}
                            index={entityIndex}
                          />
                        </span>
                        {isChosen && (
                          // Carries a testid so a test can assert THIS badge on
                          // THIS option, rather than the bare word "chosen"
                          // appearing somewhere on the page (PR #2961 R1).
                          <span
                            data-testid="ask-option-chosen"
                            className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground align-middle"
                          >
                            chosen
                          </span>
                        )}
                        {opt.description && (
                          <span className="ml-1 text-muted-foreground text-xs">
                            {" "}
                            — <LinkifiedText text={opt.description} index={entityIndex} />
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!ask.options &&
              ask.kind === "authorization.approve" &&
              !credentialRequest && (
                <div className="text-sm text-muted-foreground">
                  <p>A) Approve &nbsp; B) Deny</p>
                </div>
              )}

            {/* A credential request renders a masked input instead of the
                approve/deny pair: there is nothing to approve, only a value to
                supply, and the value must not travel the response path. The
                Decline affordance is still the ask's own B) resolution, so a
                declined request stays distinguishable from an unanswered one. */}
            {credentialRequest && actions && (
              <CredentialRequestForm
                providerId={credentialRequest.provider}
                declining={isResolvingOption(actions.acting, "B")}
                blocked={actions.acting !== null}
                onDecline={() => actions.onResolve(ask, "B")}
              />
            )}
            {!ask.options && ask.kind === "quality.review" && (
              <div className="text-sm text-muted-foreground">
                <p>A) Approve &nbsp; B) Request changes</p>
              </div>
            )}

            {actions && (
              <>
                <div className="flex flex-wrap gap-2 pt-2">
                  {Array.from({ length: optionCount }, (_, i) => {
                    const letter = letters[i] ?? "?";
                    const rawLabel = ask.options?.[i]?.label ?? (i === 0 ? "Approve" : "Deny");
                    const optLabel = stripOptionLetterPrefix(rawLabel);
                    return (
                      <PendingButton
                        key={letter}
                        variant="outline"
                        size="sm"
                        pending={isResolvingOption(actions.acting, letter)}
                        disabled={actions.acting !== null}
                        onClick={() => actions.onResolve(ask, letter)}
                      >
                        {letter}) {optLabel}
                      </PendingButton>
                    );
                  })}
                  <PendingButton
                    variant="outline"
                    size="sm"
                    pending={actions.acting?.kind === "defer"}
                    disabled={actions.acting !== null}
                    onClick={() => actions.onDefer(ask)}
                    className="text-muted-foreground"
                  >
                    Defer
                  </PendingButton>
                  <PendingButton
                    variant="outline"
                    size="sm"
                    pending={actions.acting?.kind === "escalate"}
                    disabled={actions.acting !== null}
                    onClick={() => actions.onEscalate(ask)}
                    className="text-muted-foreground"
                  >
                    Escalate
                  </PendingButton>
                </div>
                <AskActionStatus acting={actions.acting} error={actions.actionError} />
              </>
            )}
          </div>
        )}

        {!hasOptions && actions && (
          <>
            <div className="flex flex-wrap gap-2 pt-2">
              <PendingButton
                variant="outline"
                size="sm"
                pending={actions.acting?.kind === "defer"}
                disabled={actions.acting !== null}
                onClick={() => actions.onDefer(ask)}
                className="text-muted-foreground"
              >
                Defer
              </PendingButton>
              <PendingButton
                variant="outline"
                size="sm"
                pending={actions.acting?.kind === "escalate"}
                disabled={actions.acting !== null}
                onClick={() => actions.onEscalate(ask)}
                className="text-muted-foreground"
              >
                Escalate
              </PendingButton>
              <p className="text-xs text-muted-foreground italic self-center">
                No response options — defer/escalate or resolve via CLI.
              </p>
            </div>
            <AskActionStatus acting={actions.acting} error={actions.actionError} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
