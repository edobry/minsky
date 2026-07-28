/**
 * Shared per-block conversation-element renderers (mt#3262 SC 2).
 *
 * EXTRACTED (not forked) from `../widgets/ConversationView.tsx` (mt#2374/
 * mt#2790/mt#2791) so a second surface — the session-film ribbon's expanded
 * row (`../components/session-film/SessionFilmRibbon.tsx`) — can render the
 * REAL content of a single conversational element (thinking text, message
 * text, a tool call's params+result) using the EXACT same rendering code
 * ConversationView already uses, rather than a parallel copy that drifts.
 *
 * `ElementView` is the unit an expanded film row needs: it renders exactly
 * ONE `PreparedElement`. `ConversationView.tsx` still owns turn-level
 * assembly (`pairToolInvocations`, `TurnView`, `CompactionBoundary`) — only
 * the single-element renderers moved here.
 *
 * @see mt#3262 — this extraction
 * @see mt#2374 / mt#2790 / mt#2791 — original implementation history
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import type { ConversationElement, ConversationRole } from "@minsky/domain/transcripts/conversation-elements";
import type { EntityIndex } from "../lib/entity-linkifier";
import { Prose } from "./Prose";
import { ToolPayload } from "./ToolPayload";
import { friendlyToolName, parseToolName } from "../lib/tool-name";
import { toolIconFor } from "../lib/tool-icon";
import { summarizeToolInvocation } from "../lib/tool-summary";
import type { InjectedSpan } from "../lib/injected-content";

// ── Shared element types ─────────────────────────────────────────────────────

export type ToolCallElement = Extract<ConversationElement, { kind: "tool-call" }>;
export type ToolResultElement = Extract<ConversationElement, { kind: "tool-result" }>;

/** View-level "expand all / collapse all" broadcast — see `ToolInvocation`/`InjectedContentBlock`. */
export type ExpandSignal = { epoch: number; open: boolean } | undefined;

/** One conversational sub-element after tool-invocation pairing — the unit `ElementView` renders. */
export type PreparedElement =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "tool-invocation"; call: ToolCallElement; result?: ToolResultElement }
  | { kind: "tool-result-orphan"; result: ToolResultElement; callName: string | undefined }
  | { kind: "injected"; span: InjectedSpan }
  | { kind: "unknown"; rawType: string; raw: unknown };

// ── API-error text detection (mt#2793) ──────────────────────────────────────
//
// Harness-emitted failure text sometimes lands as an ordinary assistant text
// turn (e.g. "API Error: Connection closed mid-response.") rather than a
// tool-result error — it renders identically to normal prose and is easy to
// scroll past. Detection is intentionally conservative: an ANCHORED prefix
// match on the turn's TRIMMED text, not a substring match anywhere in the
// turn — a turn that merely discusses "the API Error" elsewhere in its text
// stays unstyled.
const API_ERROR_PREFIX = "API Error:";

export function isApiErrorText(text: string): boolean {
  return text.trimStart().startsWith(API_ERROR_PREFIX);
}

// ── Element renderers ──────────────────────────────────────────────────────────

export function ThinkingBlock({
  thinking,
  entityIndex,
}: {
  thinking: string;
  entityIndex: EntityIndex;
}) {
  // Render the (potentially very large) body only while expanded — collapsed
  // thinking blocks otherwise pay full serialization/reconciliation cost for
  // text nobody is looking at (PR #1667 R1 non-blocking).
  const [open, setOpen] = useState(false);

  return (
    <details
      className="group rounded border border-border/60 bg-muted/20"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <span className="italic">thinking</span>
        <span className="ml-1 text-muted-foreground/60 group-open:hidden">
          ({thinking.length} chars — click to expand)
        </span>
      </summary>
      {open && (
        // Thinking is agent reasoning prose — render as Markdown via the shared
        // <Prose> (same as assistant text), entity-aware. mt#2556 (mt#2550 follow-up).
        // Newline semantics intentionally match assistant text (Markdown soft
        // newlines): model reasoning is paragraph-structured. remark-breaks is NOT
        // enabled globally — it would regress spec/memory rendering on <Prose>'s
        // other callers (PR #1746 reviewer note).
        <Prose entityIndex={entityIndex} className="px-2 pb-2 pt-1 text-xs text-muted-foreground">
          {thinking}
        </Prose>
      )}
    </details>
  );
}

// ── Unified tool-invocation block (mt#2790) ─────────────────────────────────────
//
// A merged call+result block, collapsed by default to one summary line
// (icon + friendly name + arg/outcome digest), expandable to the full args +
// result payloads via the existing (unchanged) ToolPayload rendering. Errors
// default EXPANDED with destructive styling — a failure must never read as an
// ok-looking collapsed line.
//
// `expandSignal` is a view-level "expand all / collapse all" broadcast (see
// `ConversationThread`): each bump of `epoch` forces this block's local
// `open` state to `expandSignal.open`, while the per-block toggle button
// keeps working normally in between broadcasts.

export function ToolInvocation({
  call,
  result,
  entityIndex,
  expandSignal,
}: {
  call: ToolCallElement;
  result?: ToolResultElement;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  const isError = result?.isError === true;
  // Errors default expanded; everything else collapsed (mt#2790 design direction).
  const [open, setOpen] = useState(isError);
  // Re-sync on a NEW broadcast only (epoch), not on every `expandSignal.open`
  // identity change — `expandSignal` is a fresh object per click by design.
  const expandEpoch = expandSignal?.epoch;
  useEffect(() => {
    if (expandSignal) setOpen(expandSignal.open);
  }, [expandEpoch]);

  const parsed = useMemo(() => parseToolName(call.name), [call.name]);
  const Icon = toolIconFor(parsed);
  const label = friendlyToolName(call.name);
  const digest = useMemo(
    () =>
      summarizeToolInvocation(
        call.name,
        call.input,
        result ? { content: result.content, isError: result.isError } : undefined
      ),
    [call.name, call.input, result]
  );

  return (
    <div
      className={cn(
        "rounded border",
        isError ? "border-destructive/50 bg-destructive/5" : "border-sky-500/30 bg-sky-500/5"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs"
      >
        <Icon
          aria-hidden
          className={cn("h-3.5 w-3.5 shrink-0", isError ? "text-destructive" : "text-sky-500/80")}
        />
        <span
          title={call.name}
          className={cn(
            "shrink-0 font-mono font-medium",
            isError ? "text-destructive" : "text-sky-300"
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-muted-foreground",
            isError && "text-destructive/80"
          )}
        >
          {digest}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {call.spawn && (
            <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
              → subagent{call.spawn.agentKind ? ` (${call.spawn.agentKind})` : ""}
            </span>
          )}
          <span aria-hidden className="text-muted-foreground/60">
            {open ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40">
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            args
          </div>
          {/* Full expanded body (mt#2552, unchanged): JSON → entity-aware JsonView, else <pre> */}
          <ToolPayload
            value={call.input}
            toolName={call.name}
            entityIndex={entityIndex}
            className="border-sky-500/20 text-foreground/80"
          />
          {result ? (
            <>
              <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                {result.isError ? "error" : "result"}
              </div>
              <ToolPayload
                value={result.content}
                toolName={call.name}
                entityIndex={entityIndex}
                className={cn(
                  result.isError
                    ? "border-destructive/30 text-destructive"
                    : "border-border/40 text-foreground/70"
                )}
              />
            </>
          ) : (
            <div className="px-2 py-1 text-xs text-muted-foreground/60">pending…</div>
          )}
        </div>
      )}
    </div>
  );
}

// Standalone fallback for a tool-result with no matching call in the rendered
// window (mt#2790) — keeps the pre-redesign treatment. Uncommon: happens when
// windowing/pagination cuts the call's turn out of view (or mt#2789's
// subagent-transcript duplication produces a result with no local call).
export function ToolResult({
  element,
  callName,
  entityIndex,
}: {
  element: ToolResultElement;
  callName: string | undefined;
  entityIndex: EntityIndex;
}) {
  return (
    <div
      className={cn(
        "rounded border bg-muted/20",
        element.isError ? "border-destructive/40" : "border-border/60"
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span aria-hidden>{element.isError ? "⚠" : "↩"}</span>
        <span className="font-medium">{element.isError ? "tool error" : "tool result"}</span>
        {callName && <span className="font-mono text-muted-foreground/70">{callName}</span>}
      </div>
      {/* Content-type dispatch (mt#2552): JSON payloads → JsonView (a Tier-3
          per-tool renderer if registered, else the generic entity-aware tree);
          non-JSON content → <pre> (unchanged). */}
      <ToolPayload
        value={element.content}
        toolName={callName}
        entityIndex={entityIndex}
        className={cn(
          element.isError
            ? "border-destructive/30 text-destructive"
            : "border-border/40 text-foreground/70"
        )}
      />
    </div>
  );
}

// ── Injected-content block (mt#2791) ────────────────────────────────────────────
//
// Harness-injected content — slash-command wrappers, skill-body preambles,
// `<system-reminder>` blocks — collapsed by default behind a muted,
// origin-labeled header (see ../lib/injected-content.ts for the detector).
// Mirrors ToolInvocation's collapsed/expand-on-click + expandSignal
// participation, but muted (not blue-accented) styling — this is harness
// plumbing, not an agent action.

export function InjectedContentBlock({
  span,
  entityIndex,
  expandSignal,
}: {
  span: InjectedSpan;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  const [open, setOpen] = useState(false);
  // Re-sync on a NEW broadcast only (epoch), not on every `expandSignal.open`
  // identity change — mirrors ToolInvocation (mt#2790).
  const expandEpoch = expandSignal?.epoch;
  useEffect(() => {
    if (expandSignal) setOpen(expandSignal.open);
  }, [expandEpoch]);

  return (
    <div className="rounded border border-border/40 bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-muted-foreground"
      >
        <span className="italic">{span.label}</span>
        <span className="text-muted-foreground/50">
          ({span.content.length.toLocaleString()} chars)
        </span>
        <span aria-hidden className="ml-auto text-muted-foreground/60">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40 px-2 py-1">
          <Prose entityIndex={entityIndex} className="text-muted-foreground/90">
            {span.content}
          </Prose>
        </div>
      )}
    </div>
  );
}

// ── The single-element renderer ─────────────────────────────────────────────

export function ElementView({
  element,
  role,
  entityIndex,
  expandSignal,
}: {
  element: PreparedElement;
  /** Turn role — scopes assistant-only treatments (e.g. API-error styling). */
  role: ConversationRole;
  /** Known-entity id-set for linkification of bare refs and minsky:// URIs. */
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  switch (element.kind) {
    case "text": {
      // Assistant/user prose turns are Markdown — render via the shared <Prose>
      // (Markdown structure + entity-linkification). mt#2550.
      if (element.text.trim().length === 0) return null;
      // A harness-emitted "API Error: …" turn gets destructive-toned treatment
      // (semantic `destructive` token only, per src/cockpit/CLAUDE.md §status
      // colors) so a terminal failure is visible without reading every turn.
      // Scoped to ASSISTANT turns (PR #1973 R1): the harness emits these as
      // assistant output; a user asking about an "API Error:" is ordinary prose.
      if (role === "assistant" && isApiErrorText(element.text)) {
        return (
          <div
            role="alert"
            className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1"
          >
            <Prose entityIndex={entityIndex} className="text-destructive">
              {element.text}
            </Prose>
          </div>
        );
      }
      return <Prose entityIndex={entityIndex}>{element.text}</Prose>;
    }
    case "thinking":
      // mt#3276: thinking text is NEVER recorded — Claude Code writes
      // `{"type":"thinking","thinking":"","signature":"…"}`, keeping the
      // signature for API replay while the reasoning text is withheld
      // server-side and never reaches the client (evidence: the EVENT_VERBS
      // note in `packages/domain/src/transcripts/event-schema.ts`). So this
      // guard drops EVERY thinking element in practice, not an occasional one.
      //
      // That is DELIBERATE here and should not be "fixed" by rendering an
      // explanatory placeholder: the conversation view shows every turn, so a
      // "thinking not recorded" line would repeat on essentially every
      // assistant turn — ~29k of them in the local corpus — to say the same
      // thing each time. The film's ribbon is the opposite case and DOES
      // explain it (`SessionFilmRibbon.tsx`'s `EventContentView`): there the
      // operator has expanded one specific THINK row and is owed an answer
      // about that row.
      return element.thinking.trim().length > 0 ? (
        <ThinkingBlock thinking={element.thinking} entityIndex={entityIndex} />
      ) : null;
    case "tool-invocation":
      return (
        <ToolInvocation
          call={element.call}
          result={element.result}
          entityIndex={entityIndex}
          expandSignal={expandSignal}
        />
      );
    case "tool-result-orphan":
      return (
        <ToolResult
          element={element.result}
          callName={element.callName}
          entityIndex={entityIndex}
        />
      );
    case "injected":
      return (
        <InjectedContentBlock
          span={element.span}
          entityIndex={entityIndex}
          expandSignal={expandSignal}
        />
      );
    case "unknown":
      return (
        <div className="rounded border border-border/40 bg-muted/10 px-2 py-1 text-xs text-muted-foreground">
          unsupported block{element.rawType ? `: ${element.rawType}` : ""}
        </div>
      );
    default: {
      // Compiler-enforced exhaustiveness: adding a PreparedElement kind without
      // a render case is a type error here, not a silently-dropped block.
      const unhandled: never = element;
      return unhandled;
    }
  }
}
