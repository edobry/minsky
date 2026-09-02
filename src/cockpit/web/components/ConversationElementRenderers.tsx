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
 * ## Weight hierarchy (mt#4220)
 *
 * Speech is the narrative spine of a transcript; tool calls are EVIDENCE the
 * reader consults when a claim needs checking. So the visual weight ordering on
 * this surface is, loudest first:
 *
 *   1. failures        — `destructive` border + tint, expanded by default
 *   2. assistant/user prose — full `text-foreground`, `text-sm` (design-system `body`)
 *   3. everything else — `text-muted-foreground`, `text-xs`, NO border, NO tint
 *
 * ### Tier 3 has two steps, not one (mt#4238)
 *
 * Within tier 3, a tool call the registry classifies as MUTATING sits one step
 * above a read: brighter icon, brighter name, `font-semibold`. A read (and
 * anything unclassifiable) recedes one step BELOW today's baseline. Both move
 * away from a common midpoint, which is what makes the difference visible at a
 * glance without spending a new signal.
 *
 * The channel is deliberately the neutral brightness/weight axis and nothing
 * else. Enclosure is spent (tier 1 owns border + tint), `destructive` is
 * reserved for hard alarms and amber for attention debt
 * (`docs/design-system.md` §5.1 red-scarcity) — a healthy write is neither, so
 * a hue here would be a false alarm. `src/cockpit/CLAUDE.md` §"Semantic tokens
 * only" rules out a raw palette class regardless, and `ToolInvocation` is not
 * in `COCKPIT_STATUS_FILES`.
 *
 * Tier 3's floor is unchanged and load-bearing: a healthy row still carries NO
 * border and NO background tint at any effect, which is what
 * `ConversationView.weight-hierarchy.test.tsx` pins at rest.
 *
 * **What this cannot distinguish.** `Bash` is `unclassified` by construction
 * (`packages/shared/src/tool-effect.ts` — its effect is whatever the caller
 * passed), so a shell command that commits renders at read weight. That is the
 * classifier being conservative rather than confident, and it is a real limit
 * of this surface, not an oversight: never guess an effect from a tool name's
 * spelling.
 *
 * Before mt#4220 this was inverted: every machine element (tool call, thinking
 * block, injected span, command) was a bordered, tinted card and the healthy
 * tool row additionally carried an accent hue (`border-sky-500/30 bg-sky-500/5`,
 * name in `text-sky-300`), while assistant prose rendered with no wrapper and no
 * class at all. Border and color are the two strongest attention signals on a
 * dark surface (`src/cockpit/CLAUDE.md` §"Dark-mode-first"), and both were spent
 * entirely on the machinery — so a run of a dozen collapsed calls read as a
 * dozen glowing boxes and the paragraph between them read as the gap between
 * them.
 *
 * The size ordering was ALREADY correct and was not the defect: `<Prose>` renders
 * at `text-sm` (the design-system `body` token, "primary readable content") and
 * every machine element at `text-xs` (`small`, "captions, metadata"). What was
 * wrong was colour and enclosure, which is why the fix is subtractive.
 *
 * **Adding an element kind here?** Give it rule 3 unless it is a failure. Reach
 * for a border, a background tint, or a hue only when you can say which of the
 * three tiers it belongs to and why — not to make it "findable", which is what
 * produced the inversion.
 *
 * @see mt#3262 — this extraction
 * @see mt#2374 / mt#2790 / mt#2791 — original implementation history
 * @see mt#4220 — the weight hierarchy above
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { classifyTool } from "@minsky/shared/tool-effect";
import { cn } from "../lib/utils";
import type {
  ConversationElement,
  ConversationRole,
} from "@minsky/domain/transcripts/conversation-elements";
import type { EntityIndex } from "../lib/entity-linkifier";
import { Prose } from "./Prose";
import { ToolPayload } from "./ToolPayload";
import { friendlyToolName, parseToolName } from "../lib/tool-name";
import { toolIconFor } from "../lib/tool-icon";
import {
  summarizeToolInvocation,
  toolConsequence,
  type ToolConsequence,
} from "../lib/tool-summary";
import { sessionFileTargetFor } from "../lib/session-path";
import type { InjectedSpan, TaskNotificationParts } from "../lib/injected-content";
import { isApiErrorText } from "../lib/conversation-outcome";
import {
  ADDRESSED_MARK_CLASS,
  TOOL_USE_ANCHOR_ATTR,
  TOOL_USE_PARAM,
} from "../lib/conversation-turn-address";
import { FilmMomentLink } from "./FilmMomentLink";

// ── Shared element types ─────────────────────────────────────────────────────

export type ToolCallElement = Extract<ConversationElement, { kind: "tool-call" }>;
export type ToolResultElement = Extract<ConversationElement, { kind: "tool-result" }>;

/** The spawn descriptor an Agent tool call carries. */
export type SpawnInfo = NonNullable<ToolCallElement["spawn"]>;

const SPAWN_BADGE_CLASS =
  "mr-2 shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300";

/**
 * Focus ring for this module's disclosure controls (mt#4220, PR #3078 R1).
 *
 * `src/cockpit/CLAUDE.md` §"Accessibility-first primitives" requires a visible
 * focus state on every interactive element, and these four — the tool-row
 * toggle, the injected-span toggle, the command toggle, and the thinking
 * `<summary>` — had none. That was already a gap before mt#4220 (the card
 * border was unconditional chrome, never a focus indicator), but de-carding
 * makes it acute: a keyboard user tabbing onto a borderless, tintless row had
 * nothing at all to see. `ring-inset` because these rows have no border to sit
 * outside of — an outset ring on a bare line reads as a stray box.
 */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:rounded";

/**
 * Hover affordance for this module's disclosure controls (mt#4251).
 *
 * mt#4220's border was carrying two jobs — excess visual weight, and
 * delimiting the row as a clickable object. Removing it was right for the
 * first and took the second with it: the principal reported (2026-08-18, with
 * a screenshot) that "its not obvious to me that i can click on the entire row
 * to expand it as there's no visual guides affording the row as an object."
 *
 * Answered on HOVER rather than at rest, so mt#4220's calm-at-rest result
 * survives: nothing changes until a pointer is over the row, which is the
 * moment the reader is asking the question. `bg-muted/50` is
 * `docs/design-system.md`'s documented table-row convention, not a fresh
 * pick — that doc is declared by `src/cockpit/CLAUDE.md` as the authority on
 * component interaction states, and mt#4250's action-burst toggle shipped a
 * near-miss `/40` which this task brings into line rather than propagating.
 *
 * Background only, deliberately. A `hover:text-foreground` alongside it would
 * be inert on the tool row, whose every child span sets its own colour; the
 * controls that DO have inheriting text pair it with this constant at their
 * own call sites.
 *
 * Distinct from {@link FOCUS_RING} and never a replacement for it: they answer
 * different questions ("is this clickable" vs "where am I") for different
 * input modes.
 */
export const HOVER_ROW = "hover:bg-muted/50";

/**
 * The disclosure marker every expandable control in this view shares (mt#4348).
 *
 * Before this, the view drew disclosure markers three different ways at two
 * different positions: `BurstFold` rendered its own glyph as a LEADING child,
 * `ThinkingBlock` rendered none at all and inherited the browser's native
 * `<summary>` marker, and the tool row, injected span and command control each
 * pinned their own glyph to the right edge with `ml-auto`. The principal, on the
 * mt#4251 render: *"this looks weird, esp since the information hierarchy for the
 * collapsible section's outer and inner elements is non obvious, and the chevrons
 * are on opposite sides."*
 *
 * **Leading, not trailing, and that is load-bearing rather than a preference.**
 * A right-pinned marker cannot express depth: indenting a nested row shifts its
 * text while leaving its marker in the same column as its parent's siblings, so
 * no amount of indentation reads as containment. A leading marker turns the
 * column itself into the depth indicator — which is why file trees, `<details>`
 * and every outline UI put it there, and why this ships alongside
 * {@link BURST_CHILDREN} rather than as a separate tidy-up.
 *
 * mt#4251's PR argued the opposite (a right-aligned column as a scanning aid).
 * That holds only if the rows in a run SHARE the placement, and they did not.
 */
/**
 * The container an expanded group puts its children in (mt#4348).
 *
 * `RunView` already expresses "these turns belong to one actor" with
 * `border-l-2 pl-3` plus an accent hue. An expanded `BurstFold` expressed its
 * own containment with NOTHING — `{open && turns.map(...)}` inside a bare
 * `flex flex-col gap-2` — so a turn revealed by opening a fold rendered
 * identically to a top-level turn, and the reader had no way to see that it sat
 * inside the fold above it. That is the "information hierarchy … is non obvious"
 * half of the mt#4348 report.
 *
 * Deliberately ONE step lighter than the run rail it nests inside: a hairline
 * `border-l` against `border-2`, and a border token rather than an actor accent.
 * A fold is subordinate to the run containing it, so its rail must not compete
 * with the run's — two rails of equal weight would flatten exactly the hierarchy
 * this exists to show.
 */
export const BURST_CHILDREN = "flex flex-col gap-2 border-l border-border/40 pl-3";

export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden className="shrink-0 select-none text-muted-foreground/60">
      {open ? "▾" : "▸"}
    </span>
  );
}

/**
 * The `→ subagent (kind)` marker on an Agent tool call.
 *
 * Links to the conversation this specific call spawned when one resolved
 * (mt#3692), and stays a plain label when it did not — which is still most
 * spawns, since only about 30% currently resolve a child (mt#3702 tracks raising
 * that). The unresolved case is deliberately not rendered as a disabled control:
 * there is nowhere to go, and a dead link reads worse than a label.
 *
 * Shared by the per-tool-call renderer here and `ConversationView`'s turn-level
 * badge, so the two cannot drift.
 */
export function SpawnBadge({ spawn }: { spawn: SpawnInfo }) {
  const label = `→ subagent${spawn.agentKind ? ` (${spawn.agentKind})` : ""}`;

  if (!spawn.childAgentSessionId) {
    return <span className={SPAWN_BADGE_CLASS}>{label}</span>;
  }

  return (
    <Link
      to={`/conversation/${spawn.childAgentSessionId}`}
      data-testid="spawn-child-link"
      title="Open the conversation this call spawned"
      className={cn(
        SPAWN_BADGE_CLASS,
        "underline decoration-violet-300/40 underline-offset-2",
        "hover:bg-violet-500/25 hover:text-violet-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {label}
    </Link>
  );
}

/** View-level "expand all / collapse all" broadcast — see `ToolInvocation`/`InjectedContentBlock`. */
export type ExpandSignal = { epoch: number; open: boolean } | undefined;

/**
 * Display nouns for a tool result (mt#3374). Exported because the turn-origin
 * classifier (`../lib/turn-origin.ts`) labels a pure tool-result turn with the
 * same word this block header uses — the vocabulary lives once so the turn
 * header and the block it describes cannot drift apart, the same failure
 * PR #2442 R1 caught in the injected-span nouns.
 */
export const TOOL_RESULT_NOUN = "tool result";
export const TOOL_ERROR_NOUN = "tool error";

/** One conversational sub-element after tool-invocation pairing — the unit `ElementView` renders. */
export type PreparedElement =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "tool-invocation"; call: ToolCallElement; result?: ToolResultElement }
  | { kind: "tool-result-orphan"; result: ToolResultElement; callName: string | undefined }
  | { kind: "injected"; span: InjectedSpan }
  /**
   * A generated subagent dispatch brief (mt#4354) — the assignment the PARENT
   * AGENT composed, which opens every Minsky-dispatched subagent conversation.
   *
   * Distinct from `injected` on purpose, and the distinction is the whole
   * design: `injected` exists to SUPPRESS noise behind a muted one-line header
   * (skill bodies, system reminders). A brief is the opposite — it is the
   * highest-value block on a subagent's page, the reason you opened it. So it
   * gets a treatment that is DISTINCT without being DIMINISHED: expanded by
   * default, with the generated boilerplate folded inside it rather than the
   * whole thing collapsed.
   *
   * `stamp` is absent for a dispatch that predates mt#2292's stamp, or whose
   * prompt the guard did not rewrite. That is ordinary, not broken — the brief
   * renders without an ascent link rather than not rendering.
   */
  | {
      kind: "dispatch-brief";
      /** The dispatch-specific instructions — boilerplate split out, markers stripped. */
      body: string;
      /** Generated sections folded behind their own headings. */
      sections: { heading: string; content: string }[];
      /** Parent conversation + the `Agent` call that dispatched this, when stamped. */
      stamp?: { parentAgentSessionId: string; parentToolUseId: string };
      /** Assignment facts shown in the header without hover. */
      facts: { sessionId?: string; taskId?: string; readOnly: boolean };
    }
  /**
   * A slash-command invocation merged with its captured output and the
   * harness caveat that accompanies it (mt#3322) — the command analogue of
   * `tool-invocation`. The harness emits these as up to THREE consecutive
   * user turns; rendering them as three prose bubbles is what buried the real
   * conversation. `output`/`caveat` are optional: a command with no captured
   * stdout, or a transcript whose caveat fell outside the rendered window,
   * still renders as a command.
   */
  | {
      kind: "command-invocation";
      command: InjectedSpan;
      output?: InjectedSpan;
      caveat?: InjectedSpan;
    }
  /**
   * An image the operator pasted (or a tool returned). Mirrors the domain
   * element of the same kind — see `conversation-elements.ts` for why
   * `sourceType` is a plain string and why `data`/`url` are optional.
   */
  | { kind: "image"; sourceType: string; mediaType?: string; data?: string; url?: string }
  | { kind: "unknown"; rawType: string; raw: unknown };

// ── API-error text detection (mt#2793, re-homed by mt#3132) ─────────────────
//
// The detection itself now lives in `../lib/conversation-outcome.ts`, which
// owns the shared terminal-condition taxonomy: the SAME anchored match that
// styles a turn here also decides whether that turn's Outcome chip reads
// `Errored` or `Rate-limited`. Two copies of one rule is precisely the drift
// mt#3132 removes — this re-export keeps the renderer's existing call sites
// (and its published surface) working against the single implementation.
export { isApiErrorText };

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
      className="group rounded"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground",
          // Suppress the USER AGENT's disclosure triangle (mt#4348). This was
          // the only control in the view whose marker we did not draw — the
          // browser's default `<summary>` marker, in its glyph, its size and
          // its colour, none of which matched the three we render ourselves.
          // `list-none` covers the standard `::marker`; the webkit
          // pseudo-element covers Safari/older Chrome, which ignore it.
          "list-none [&::-webkit-details-marker]:hidden",
          HOVER_ROW,
          FOCUS_RING
        )}
      >
        <DisclosureChevron open={open} />
        <span className="italic">thinking</span>
        <span className="text-muted-foreground/60 group-open:hidden">
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

/**
 * The two tier-3 weight steps, by tool effect (mt#4238).
 *
 * `mutates` steps UP from the mt#4220 baseline; everything else steps DOWN.
 * Both directions matter: moving only one of them would leave the pair a
 * hairline apart, and the point is that a run of reads reads as texture while a
 * write reads as an event.
 *
 * Semantic tokens only, and the same two properties in both rows — brightness
 * and font-weight — so the difference is one axis rather than a new signal per
 * element. No border, no tint, no hue at either step.
 */
const EFFECT_WEIGHT = {
  /** The registry says this call changes state the caller asked to change. */
  mutates: {
    icon: "text-muted-foreground",
    name: "font-semibold text-muted-foreground",
    digest: "text-muted-foreground/70",
  },
  /**
   * A read — or anything the registry cannot classify. These share a row on
   * purpose: `unclassified` must never render a mutation signal it did not
   * earn, and read weight is the conservative direction to be wrong in.
   */
  recessive: {
    icon: "text-muted-foreground/50",
    name: "font-normal text-muted-foreground/70",
    digest: "text-muted-foreground/60",
  },
} as const;

/**
 * Pick a call's tier-3 weight step.
 *
 * Classify by the RAW tool name: `classifyTool` normalizes the harness's
 * `mcp__minsky__` prefix and the underscored alias itself, so
 * `mcp__minsky__tasks_spec_patch` resolves to `tasks.spec.patch` without any
 * parsing here. Parsing it ourselves is exactly the name-shaped inference
 * mt#3845 SC3 rules out.
 */
function effectWeightFor(
  toolName: string,
  consequence: ToolConsequence
): (typeof EFFECT_WEIGHT)[keyof typeof EFFECT_WEIGHT] {
  if (classifyTool(toolName) !== "mutates") return EFFECT_WEIGHT.recessive;
  // A mutating tool whose RESULT says it changed nothing did not actuate, so it
  // does not earn the actuation step (mt#4437). The name classified the
  // CAPABILITY; only the payload can speak to the EVENT.
  //
  // `unknown` deliberately keeps the mutates step: no paired result (the
  // windowing case, mt#3481), an error, or a payload carrying no delta all land
  // here, and stepping DOWN on those would assert "nothing happened" from an
  // absence of evidence. Capability weight — today's behaviour — is the honest
  // rendering when the consequence is not known, and it is also the
  // conservative direction, since it claims no more than mt#4238 already did.
  return consequence === "unchanged" ? EFFECT_WEIGHT.recessive : EFFECT_WEIGHT.mutates;
}

export function ToolInvocation({
  call,
  result,
  entityIndex,
  expandSignal,
  isAddressed,
  filmPath,
  turnIndex,
}: {
  call: ToolCallElement;
  result?: ToolResultElement;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
  /** Film-tab path enabling the "watch this moment" link (mt#3794). */
  filmPath?: string;
  /** This call's transcript position — the other half of its address (mt#3794). */
  turnIndex?: number;
  /**
   * This call is what a turn address named (mt#3791) — the reader arrived here
   * from a film row for THIS call, so it opens and marks itself.
   */
  isAddressed?: boolean;
}) {
  const isError = result?.isError === true;
  // Errors default expanded; everything else collapsed (mt#2790 design
  // direction). An addressed call also opens: the reader clicked through from a
  // ribbon row that was already showing this call's params and result, so
  // landing on a collapsed row would hide the thing they navigated to.
  const [open, setOpen] = useState(isError || isAddressed === true);
  // Re-sync on a NEW broadcast only (epoch), not on every `expandSignal.open`
  // identity change — `expandSignal` is a fresh object per click by design.
  const expandEpoch = expandSignal?.epoch;
  useEffect(() => {
    if (expandSignal) setOpen(expandSignal.open);
  }, [expandEpoch]);

  const parsed = useMemo(() => parseToolName(call.name), [call.name]);
  const Icon = toolIconFor(parsed);
  // Tier-3 weight step (mt#4238). Note this reads `call.name`, NOT `parsed` —
  // the classifier does its own normalization, and handing it a pre-parsed bare
  // name would drop the server that distinguishes an MCP tool from a native one.
  // The result payload, in the shape both the digest and the consequence read.
  const resultInfo = useMemo(
    () => (result ? { content: result.content, isError: result.isError } : undefined),
    [result]
  );
  // The weight step, derived in ONE memo from the payload (mt#4437). Kept as a
  // single derivation rather than a consequence memo feeding a weight memo
  // (PR #3273 R1): the intermediate had no other consumer, and chaining memos
  // on a freshly-built `resultInfo` object just adds a link that invalidates on
  // exactly the same inputs.
  const weight = useMemo(
    () => effectWeightFor(call.name, toolConsequence(call.name, resultInfo)),
    [call.name, resultInfo]
  );
  // A native file tool acting on a session workspace reveals that only through
  // its absolute path (mt#3378) — mark it in the label, and keep the session
  // identity in the tooltip rather than spending the line on a raw UUID.
  const sessionTarget = useMemo(
    () => sessionFileTargetFor(call.name, call.input),
    [call.name, call.input]
  );
  const label = `${friendlyToolName(call.name)}${
    sessionTarget?.labelAsSession ? " · session file" : ""
  }`;
  const nameTooltip = sessionTarget
    ? `${call.name}\n${sessionTarget.absolutePath}\nsession ${sessionTarget.sessionId}`
    : call.name;
  const digest = useMemo(
    () => summarizeToolInvocation(call.name, call.input, resultInfo),
    [call.name, call.input, resultInfo]
  );

  return (
    <div
      // The anchor a tool-grain turn address resolves to (mt#3791). Rendered
      // unconditionally, not only when addressed: an address arriving later
      // must find an element that is already anchored.
      {...{ [TOOL_USE_ANCHOR_ATTR]: call.id }}
      className={cn(
        "rounded",
        // A healthy call is a dim LINE, not a card (mt#4220): no border, no
        // tint. Only a failure keeps the card — see the weight hierarchy note
        // at the top of this module for why.
        isError && "border border-destructive/50 bg-destructive/5",
        isAddressed && ADDRESSED_MARK_CLASS
      )}
    >
      {/*
        The spawn badge sits OUTSIDE the toggle button (mt#3692). When its child
        conversation resolves it becomes a link, and an anchor nested inside a
        button is invalid HTML that browsers and screen readers handle
        inconsistently — so the row is a flex container holding the toggle and the
        badge as siblings, rather than one button wrapping both.
      */}
      {/*
        The hover affordance (mt#4251) sits HERE, on the row-spanning flex
        container, not on the toggle button and not on the anchored wrapper
        above. The button is `flex-1`, so a background on it stops short of the
        spawn badge and film link — the row would highlight in part, which is
        the opposite of "this row is one object." The wrapper is the element
        `ConversationView.weight-hierarchy.test.tsx` asserts carries no `bg-`
        class at rest (mt#4220), and `hover:bg-*` matches that assertion's
        regex; putting it there would fail the at-rest guarantee this task must
        preserve. This div is the only element that is both full-width and
        outside that assertion.
      */}
      <div className={cn("group/call flex w-full items-center rounded", HOVER_ROW)}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-xs",
            FOCUS_RING
          )}
        >
          <DisclosureChevron open={open} />
          <Icon
            aria-hidden
            className={cn("h-3.5 w-3.5 shrink-0", isError ? "text-destructive" : weight.icon)}
          />
          <span
            title={nameTooltip}
            className={cn(
              "shrink-0 font-mono",
              // A failure outranks the effect step — tier 1 wins over tier 3, so
              // a failed write and a failed read are equally loud.
              isError ? "font-medium text-destructive" : weight.name
            )}
          >
            {label}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              isError ? "text-destructive/80" : weight.digest
            )}
          >
            {digest}
          </span>
        </button>
        {call.spawn && <SpawnBadge spawn={call.spawn} />}
        {/*
          Tool-grain film link (mt#3794), a SIBLING of the toggle for the same
          reason the spawn badge is one: an anchor nested inside a button is
          invalid HTML that browsers and screen readers handle inconsistently.
          Carries `toolUseId` as well as the turn, so a parallel batch resolves
          to THIS call rather than whichever one the adapter emitted first.
        */}
        {filmPath !== undefined && turnIndex !== undefined && (
          <FilmMomentLink
            address={{ turnIndex, toolUseId: call.id }}
            filmPath={filmPath}
            className="mr-1 group-hover/call:opacity-100"
          />
        )}
      </div>
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
            className="border-border/40 text-foreground/80"
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
        // Same weight rule as ToolInvocation (mt#4220): the healthy case is a
        // dim line, only a failure keeps the card.
        "rounded",
        element.isError && "border border-destructive/40 bg-destructive/5"
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span aria-hidden>{element.isError ? "⚠" : "↩"}</span>
        <span className="font-medium">{element.isError ? TOOL_ERROR_NOUN : TOOL_RESULT_NOUN}</span>
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

/**
 * A generated subagent dispatch brief (mt#4354) — the assignment that opens
 * every Minsky-dispatched subagent conversation.
 *
 * DISTINCT from the operator's own prose, but deliberately NOT diminished the
 * way `InjectedContentBlock` diminishes harness noise. This is the block a
 * reader opens a subagent conversation to find, so the instructions render
 * expanded and only the generated boilerplate folds.
 *
 * The header's ascent link is built from the mt#2292 stamp the dispatch guard
 * wrote into the prompt, so it addresses the exact `Agent` CALL rather than
 * just the parent conversation — `conversation-turn-address.ts` resolves the
 * `toolUse` param and ring-marks the arrival. That is strictly better than the
 * page-level "Spawned by" link, which is a join over `agent_spawns` and lands
 * on the conversation. When the prompt carries no stamp the header renders
 * without the link rather than not rendering.
 */
export function DispatchBriefBlock({
  element,
  entityIndex,
}: {
  element: Extract<PreparedElement, { kind: "dispatch-brief" }>;
  entityIndex: EntityIndex;
}) {
  const { body, sections, stamp, facts } = element;
  return (
    <div
      data-testid="dispatch-brief"
      className="rounded border border-violet-400/30 bg-violet-400/[0.04]"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-violet-400/20 px-2 py-1 text-[11px] text-muted-foreground">
        {/*
          No label here. The RUN header one level up already renders "dispatch
          brief" from `classifyTurnOrigin`, and printing it again inside the
          block is the duplicated-origin-noun defect mt#3728 criterion 4 names
          for skill bodies — caught here by looking at the render rather than by
          review. The violet border and rail carry the block's identity; this row
          carries only what the run header cannot: where the brief came from.
        */}
        {stamp ? (
          <>
            <Link
              to={`/conversation/${stamp.parentAgentSessionId}?${TOOL_USE_PARAM}=${encodeURIComponent(stamp.parentToolUseId)}`}
              title={`Open the Agent call that dispatched this (${stamp.parentToolUseId})`}
              className="rounded text-violet-300 underline decoration-violet-300/40 underline-offset-2 transition-colors hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ↑ dispatched from this call
            </Link>
          </>
        ) : null}
        {facts.taskId ? (
          <>
            <span aria-hidden>·</span>
            <Link
              to={`/tasks/${encodeURIComponent(facts.taskId)}`}
              className="rounded font-mono text-violet-300 underline decoration-violet-300/40 underline-offset-2 transition-colors hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {facts.taskId}
            </Link>
          </>
        ) : null}
        {facts.sessionId ? (
          <>
            <span aria-hidden>·</span>
            <span className="font-mono" title={`Workspace session ${facts.sessionId}`}>
              {/* Short prefix, full id on hover — the id itself is unreadable at
                  a glance and the header is a scan surface, not a reference. The
                  HOVER carries only the long form of something already visible,
                  which is the permitted use (`cockpit-design` anti-pattern 5
                  bans hover-ONLY critical state, not hover detail). */}
              {facts.sessionId.slice(0, 8)}…
            </span>
          </>
        ) : null}
        {facts.readOnly ? (
          <>
            <span aria-hidden>·</span>
            <span
              className="rounded border border-violet-400/40 px-1 text-[10px] uppercase tracking-wide text-violet-300"
              title="This dispatch was declared read-only (mt#2865); a write-gate denies session mutations for it"
            >
              read-only
            </span>
          </>
        ) : null}
      </div>

      <div className="px-2 py-1.5">
        <Prose entityIndex={entityIndex}>{body}</Prose>
      </div>

      {sections.map((section) => (
        <details key={section.heading} className="border-t border-violet-400/15 px-2 py-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
            {section.heading.replace(/^#+\s*/, "")}
          </summary>
          <div className="mt-1">
            <Prose entityIndex={entityIndex}>{section.content}</Prose>
          </div>
        </details>
      ))}
    </div>
  );
}

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
    <div className="rounded">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground",
          HOVER_ROW,
          FOCUS_RING
        )}
      >
        <DisclosureChevron open={open} />
        <span className="italic">{span.label}</span>
        <span className="text-muted-foreground/50">
          ({span.content.length.toLocaleString()} chars)
        </span>
      </button>
      {open &&
        (span.notification !== undefined ? (
          // No padding on the wrapper: the structured body pads its own rows,
          // exactly as ToolInvocation's expanded branch does.
          <div className="border-t border-border/40">
            <TaskNotificationBody span={span} parts={span.notification} entityIndex={entityIndex} />
          </div>
        ) : (
          <div className="border-t border-border/40 px-2 py-1">
            <Prose entityIndex={entityIndex} className="text-muted-foreground/90">
              {span.content}
            </Prose>
          </div>
        ))}
    </div>
  );
}

/**
 * A background-task notification's body, rendered as the deferred TOOL RESULT
 * it is (mt#4419).
 *
 * When the harness backgrounds a slow MCP call it returns the tool's entire
 * JSON payload later, wrapped in a `<task-notification>` turn. That payload is
 * the same shape an INLINE tool result carries, and the cockpit has rendered
 * inline results as an entity-aware collapsible tree since mt#2552 — with an
 * optional per-tool renderer keyed on the bare tool name. Only the DEFERRED
 * copy came through the injected-content path, which prints its body verbatim,
 * so one kind of content had two renderings and the operator met the worse one
 * precisely when a call had taken long enough to be backgrounded.
 *
 * Three things keep this from losing information the prose path preserved:
 *
 *   - The payload goes to `ToolPayload` unconditionally, which dispatches JSON
 *     to the tree and everything else to a `<pre>`. So a non-JSON result is
 *     still shown as its own text, rather than as the envelope markup around it.
 *   - Anything the envelope carried that the parse did not model comes through
 *     as `remainder` and renders beneath — mt#2791's demote-never-drop contract
 *     survives a structured view that has no slot for a future tag.
 *   - A body the parse can make nothing of at all falls back to the exact prose
 *     rendering shipped before, so an unanticipated shape degrades to "shown
 *     verbatim" rather than to blank.
 */
function TaskNotificationBody({
  span,
  parts,
  entityIndex,
}: {
  span: InjectedSpan;
  parts: TaskNotificationParts;
  entityIndex: EntityIndex;
}) {
  // PR #3245 R1. This used to gate the whole structured view on the payload
  // parsing as JSON, and fall back to `span.content` — the ENTIRE decoded body,
  // envelope tags and all — otherwise. The reviewer was right that this
  // reintroduced the exact defect the task exists to fix, on the one path where
  // nobody would look: a tool returning a non-JSON result still rendered
  // `<task-id>…</task-id>` at the operator.
  //
  // The gate was also unnecessary. `ToolPayload` ALREADY dispatches on the same
  // question and renders non-JSON as a <pre> — so asking `classifyToolPayload`
  // here only to route around `ToolPayload` was duplicating its dispatch in
  // order to do something worse with the answer. Handing it the payload
  // unconditionally is both the fix and a deletion.
  const hasStructure =
    parts.taskId !== null ||
    parts.status !== null ||
    parts.summary !== null ||
    parts.result !== null ||
    parts.remainder !== null;

  // The floor, for a body the parse could make nothing of at all — reachable
  // only by a degenerate envelope of empty modelled tags (`<status></status>`),
  // since anything else leaves at least a remainder. It exists so an
  // unanticipated shape degrades to "shown verbatim", never to blank.
  if (!hasStructure) {
    return (
      <div className="px-2 py-1">
        <Prose entityIndex={entityIndex} className="text-muted-foreground/90">
          {span.content}
        </Prose>
      </div>
    );
  }

  return (
    <>
      {(parts.taskId !== null || parts.status !== null) && (
        <div className="flex items-baseline gap-2 px-2 pt-1 text-[10px] text-muted-foreground/60">
          {parts.taskId !== null && (
            <>
              <span className="uppercase tracking-wide">task</span>
              <span className="font-mono">{parts.taskId}</span>
            </>
          )}
          {parts.status !== null && <span className="ml-auto">{parts.status}</span>}
        </div>
      )}
      {parts.result !== null && (
        <>
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            result
          </div>
          {/* Handed over unconditionally: `ToolPayload` dispatches JSON to the
              tree and everything else to a <pre>, so a non-JSON payload still
              renders as its own text rather than as envelope markup.

              `toolName` is the BARE name parsed from the summary, which is the
              form ToolPayload's Tier-3 registry is keyed on — so a renderer
              registered for this tool applies to its deferred result exactly as
              it does to an inline one. */}
          <ToolPayload
            value={parts.result}
            toolName={parts.toolName ?? undefined}
            entityIndex={entityIndex}
            className="border-border/40 text-foreground/70"
          />
        </>
      )}
      {parts.remainder !== null && (
        <div className="px-2 py-1">
          <Prose entityIndex={entityIndex} className="text-muted-foreground/90">
            {parts.remainder}
          </Prose>
        </div>
      )}
    </>
  );
}

// ── Command invocation (mt#3322) ────────────────────────────────────────────
//
// A slash command and its captured output, rendered as ONE element in the
// shape the terminal uses:
//
//     > /model
//       Set model to Fable 5 for this session only
//
// The command name and its result are the two things the operator actually
// wants to read, so both are shown inline rather than collapsed. The raw
// harness markup (the wrapper tags, and the model-directed caveat) is real
// content and is NOT discarded — it moves behind the disclosure toggle, per
// the mt#2791 contract that injected content is demoted, never dropped.

/** Strip the leading slash so the rendered prompt reads `> /model`, not `> //model`. */
function commandLabelText(span: InjectedSpan): string {
  const withoutPrefix = span.label.replace(/^command:\s*/i, "").trim();
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

export function CommandInvocation({
  element,
  entityIndex,
  expandSignal,
}: {
  element: Extract<PreparedElement, { kind: "command-invocation" }>;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  const [open, setOpen] = useState(false);
  const expandEpoch = expandSignal?.epoch;
  useEffect(() => {
    if (expandSignal) setOpen(expandSignal.open);
  }, [expandEpoch]);

  // Ties the toggle to the region it controls so a screen reader announces
  // what expanded (PR #2403 R1, non-blocking).
  const detailsId = useId();
  const { command, output, caveat } = element;

  return (
    <div className="rounded">
      <div className="flex items-start gap-2 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={open ? "Hide raw command markup" : "Show raw command markup"}
          // Unlike its three siblings this control is NOT the row: the command
          // line beside it is content, and only this chevron toggles anything.
          // So the affordance covers the chevron's own hit-area — widening what
          // is clickable would be a behaviour change, not an affordance fix
          // (mt#4251). `px-1` gives the glyph enough box for the background to
          // read as a control rather than a smudge.
          //
          // Leading rather than `ml-auto` (mt#4348): this row sits in the same
          // column as the tool rows and the fold summary, and a marker that
          // wanders to the right edge on one of them is what made the set read
          // as three positions instead of one.
          className={cn(
            "shrink-0 rounded px-1 text-xs hover:text-foreground",
            HOVER_ROW,
            FOCUS_RING
          )}
        >
          <DisclosureChevron open={open} />
        </button>
        <span aria-hidden className="select-none font-mono text-xs text-muted-foreground/60">
          &gt;
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-foreground/90">{commandLabelText(command)}</div>
          {output && output.content.length > 0 && (
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">{output.content}</div>
          )}
        </div>
      </div>
      {open && (
        <div id={detailsId} className="space-y-1 border-t border-border/40 px-2 py-1">
          <Prose entityIndex={entityIndex} className="text-muted-foreground/90">
            {command.content}
          </Prose>
          {caveat && (
            <Prose entityIndex={entityIndex} className="text-muted-foreground/70">
              {caveat.content}
            </Prose>
          )}
        </div>
      )}
    </div>
  );
}

// ── The single-element renderer ─────────────────────────────────────────────

/**
 * Ceiling on base64 payload we will paint inline, in characters.
 *
 * Derived from the corpus rather than picked round (`decision-defaults.mdc
 * §Thresholds`): across the 7 `image` blocks present in this project's local
 * JSONL corpus (2026-08-08), base64 length runs min 20,488 / median 80,096 /
 * max 397,880 chars. 1,000,000 sits ~2.5x above the observed max — so no real
 * screenshot in the corpus trips it — while capping a single inline paint below
 * the multi-megabyte bar SC3 names.
 *
 * Deliberately checked at RENDER time, not in the parser: the payload has
 * already arrived in the snapshot either way (see the delivery note below), so
 * this bounds what the DOM has to hold, not what the network carries. The
 * parser stays faithful to the block it was given.
 */
const MAX_INLINE_BASE64_CHARS = 1_000_000;

/** Render a byte-ish count for the placeholder without pulling in a formatter. */
function approxKb(base64Chars: number): string {
  // base64 encodes 3 bytes per 4 chars; close enough for a diagnostic label.
  return `${Math.round((base64Chars * 3) / 4 / 1024)} KB`;
}

/**
 * Render a pasted/returned image.
 *
 * Delivery note (mt#3810, ADR-025): the base64 payload already travels to the
 * browser inside the context-inspector snapshot whether or not anything draws
 * it, so rendering it here adds ZERO bytes to the payload. A real screenshot
 * block measures ~39 KB of base64 (3840x1936 PNG, conversation
 * `f1048ecf-a061-4725-8e60-dab6ad9bd322`). We deliberately do NOT add a
 * fetch-on-demand path: ADR-025 makes object storage the system of record and
 * mt#2580 re-points this snapshot's reader at it, so a second delivery
 * mechanism built against today's Postgres blob would be rework against a
 * substrate that is being retired. Image weight is an input for mt#2580 to
 * size, not a mechanism for this component to invent.
 *
 * `loading="lazy"` keeps a long transcript from decoding every image up front.
 */
function ImageElement({
  element,
}: {
  element: Extract<PreparedElement, { kind: "image" }>;
}): JSX.Element {
  // SC3's oversized half. Checked BEFORE building the `data:` URI so an
  // outsized payload is never concatenated into a string the DOM then holds.
  if (element.data !== undefined && element.data.length > MAX_INLINE_BASE64_CHARS) {
    return (
      <div className="rounded border border-border/40 bg-muted/10 px-2 py-1 text-xs text-muted-foreground">
        image too large to display inline (~{approxKb(element.data.length)})
      </div>
    );
  }

  const src =
    element.data !== undefined
      ? `data:${element.mediaType ?? "image/png"};base64,${element.data}`
      : element.url;

  if (src === undefined) {
    // Malformed, empty, or a source type we don't render (e.g. `file`, which
    // needs an API fetch we deliberately don't do here). Say which, rather
    // than showing a broken image or silently dropping the turn's content.
    // A blank `sourceType` (no source object at all) reads as "unknown" rather
    // than a dangling label — reviewer non-blocking finding on PR #2711.
    return (
      <div className="rounded border border-border/40 bg-muted/10 px-2 py-1 text-xs text-muted-foreground">
        image not shown (source: {element.sourceType || "unknown"})
      </div>
    );
  }

  return (
    <a href={src} target="_blank" rel="noreferrer" className="block">
      <img
        src={src}
        alt={element.url ?? "Image in conversation"}
        loading="lazy"
        className="max-h-96 max-w-full rounded border border-border/40 object-contain"
      />
    </a>
  );
}

export function ElementView({
  element,
  role,
  entityIndex,
  expandSignal,
  addressedToolUseId,
  filmPath,
  turnIndex,
}: {
  element: PreparedElement;
  /** Film-tab path enabling the "watch this moment" link (mt#3794). */
  filmPath?: string;
  /** This turn's transcript position — half of every address built here (mt#3794). */
  turnIndex?: number;
  /** Turn role — scopes assistant-only treatments (e.g. API-error styling). */
  role: ConversationRole;
  /** Known-entity id-set for linkification of bare refs and minsky:// URIs. */
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
  /**
   * The `tool_use` id a turn address named, when this turn is the addressed one
   * (mt#3791). Only a matching tool call marks itself; every other element
   * renders exactly as it does with no address at all.
   */
  addressedToolUseId?: string;
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
      // Full-strength foreground, overriding <Prose>'s default `text-foreground/90`
      // (mt#4220). Speech is the narrative spine of a transcript and every other
      // element on this surface now recedes to `text-muted-foreground`; a prose
      // block dimmed to 90% while the machinery around it carries the eye is the
      // inverted hierarchy this task exists to correct. Deliberately a CALL-SITE
      // override rather than a change to <Prose>'s default: this is the one
      // surface where prose competes with dense machinery for attention, and
      // ~16 other Prose sites (task specs, memory bodies, ask questions) have no
      // such competition. If a second surface ever needs it, promote it to the
      // default rather than adding a second override.
      return (
        <Prose entityIndex={entityIndex} className="text-foreground">
          {element.text}
        </Prose>
      );
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
          isAddressed={addressedToolUseId !== undefined && element.call.id === addressedToolUseId}
          filmPath={filmPath}
          turnIndex={turnIndex}
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
    case "command-invocation":
      return (
        <CommandInvocation
          element={element}
          entityIndex={entityIndex}
          expandSignal={expandSignal}
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
    case "dispatch-brief":
      return <DispatchBriefBlock element={element} entityIndex={entityIndex} />;
    case "image":
      return <ImageElement element={element} />;
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
