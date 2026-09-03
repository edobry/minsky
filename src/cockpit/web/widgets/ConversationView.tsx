/**
 * ConversationView (mt#2374) — readable chat-thread render of a session transcript.
 *
 * A LAYOUT-AGNOSTIC body component (per the mt#2373 widget contract): it takes
 * data + a render context and renders a chronological chat thread — it does NOT
 * assume it lives in a tab vs. a panel vs. a full page. The surrounding chrome
 * is supplied by the host (a WidgetShell variant, a page section, a tab body).
 *
 * Three ways to give it data (mt#2374 success criterion "given a session id or
 * a pre-fetched snapshot"; the third added by mt#2751):
 *   - `{ sessionId }`  — self-fetches the snapshot from the existing
 *                        `/api/cockpit/context-inspector/snapshot` endpoint
 *                        (mt#2023) via TanStack Query.
 *   - `{ snapshot }`   — renders a pre-fetched SessionContextSnapshot directly
 *                        (used by hosts that already hold the snapshot, and by
 *                        the layout-agnostic acceptance test).
 *   - `{ drivenSessionId, drivenBlocks }` — mt#2751 Rung 2B: renders a
 *                        driven-session's live blocks with NO DB snapshot at
 *                        all (a fresh spawn has no prior transcript). The
 *                        caller owns the single `useDrivenSession` WS
 *                        connection (so composer/status siblings can share
 *                        it) and passes its accumulated `blocks` straight
 *                        through — this variant just wraps them in an empty
 *                        base snapshot and feeds `ConversationThread`'s
 *                        EXISTING `extraBlocks` seam, so the two Rung-1 SSE
 *                        live-tail channels above and this driven WS channel
 *                        all share the identical rendering code path.
 *
 * Data comes from `assembleSessionContextSnapshot()` (mt#2022), which preserves
 * each turn's full `message.content` (thinking / tool_use / tool_result). The
 * per-line blocks are expanded into ordered conversational sub-elements by the
 * shared domain parser `snapshotBlocksToConversation` — NOT by a parallel
 * frontend copy, and NOT by reading the raw JSONL (the mt#2021 DB-only
 * invariant holds: the only substrate read is the snapshot endpoint).
 *
 * @see mt#2374 — this component
 * @see packages/domain/src/transcripts/conversation-elements.ts — the shared parser
 * @see mt#2370 — the session-tab frame this will eventually render into
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  useCallback,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";
import type { ConversationId, WorkspaceId } from "@minsky/domain/ids";
import { useEntityIndex } from "../lib/use-entity-index";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { useLiveTail, useConversationLiveTail } from "../hooks/useLiveTail";
import type { ExpandSignal } from "../components/ConversationElementRenderers";
import { SpawnParentBacklink } from "../components/SpawnParentBacklink";
import { buildTurnNodes } from "../components/ConversationTurnView";
import { buildConversationThread } from "../lib/conversation-thread-model";
import { SupersededPromptMarker, supersededMarkerKey } from "../components/SupersededPromptMarker";
import {
  classifySnapshotError,
  fetchSnapshot,
  mergeSnapshotPages,
  snapshotQueryKey,
  snapshotRetry,
} from "../lib/conversation-snapshot";
import type { TurnAddress } from "../lib/conversation-turn-address";
import { useTurnAddressLanding } from "../hooks/useTurnAddressLanding";
import {
  hasRenderablePreparedElement,
  mergeCommandInvocations,
  pairToolInvocations,
} from "../lib/conversation-turn-assembly";
import { findScrollParent, hasGrown, isNearTop, isPinnedToBottom } from "../lib/scroll-pinning";
import { INITIAL_TURNS, useThreadWindow } from "../hooks/useThreadWindow";
import { ThreadPositionPill, ThreadStartBoundary } from "../components/ThreadOrientation";

// ── Props ─────────────────────────────────────────────────────────────────────

/**
 * Props every variant carries (mt#3791).
 *
 * Intersected onto the union below rather than repeated in each arm: a turn
 * address is orthogonal to WHERE the blocks come from — a fetched conversation,
 * a pre-fetched snapshot, and a driven session can all be arrived at with one
 * turn named.
 */
type ConversationViewCommonProps = {
  /**
   * Land on this turn instead of the newest exchange, and mark it. Resolved from
   * the URL by a router-aware host (`RunDetail`), never read from the router
   * here — several existing callers render this component with no router at all.
   */
  turnTarget?: TurnAddress;
  /**
   * Path of the film tab showing this same conversation, WITHOUT a query string
   * (mt#3794) — supplying it turns on the per-row "watch this moment" affordance.
   *
   * Same reason as `turnTarget` for arriving as a prop (callers with no router),
   * plus one this direction has and that one does not: a film is reachable only
   * in the conversation keyspace (mt#3468), so `/agents/:id/conversation` — the
   * same thread, rendered under a workspace — supplies nothing and shows no
   * affordance. That asymmetry with `turnTarget`, which is deliberately NOT
   * keyspace-scoped, is intended: an address means the same thing wherever the
   * thread is shown, but the film it would link to does not exist there.
   */
  filmPath?: string;
  /**
   * Chrome the host pins to the BOTTOM of the thread — today the activity line
   * ("Running <tool> · <elapsed>", mt#3344). Arrives as a prop for a reason the
   * other two do not share: it has to be RENDERED INSIDE the thread, not beside
   * it (mt#3843).
   *
   * The thread already pins two controls of its own to the bottom edge (the
   * position pill and the return-to-newest button). While the host mounted its
   * tail as a SIBLING of this component, all three resolved into one stacking
   * context at the same `z-10`, so which one won was decided by DOM order — and
   * the host's tail, being last and opaquely backgrounded, painted over the
   * pill. Measured: 16.5px of the pill's 25px height covered, and a hit test at
   * the centre of the pill's "↑ start" button landed on the tail, so the
   * control was not merely hidden but unclickable.
   *
   * Passing the tail IN lets `ThreadFooter` lay all three out as one flex
   * column, which stacks by construction. The host still decides WHAT the tail
   * is; the thread decides WHERE it sits relative to its own controls, which is
   * the only place that knowledge exists.
   */
  tail?: ReactNode;
};

type ConversationViewProps = ConversationViewCommonProps &
  (
    | {
      sessionId: ConversationId;
      snapshot?: undefined;
      className?: string;
      /**
       * Minsky workspace sessionId (WorkspaceId). When provided, `ConversationFetcher`
       * opens the `GET /api/agents/:id/live-tail` SSE channel and appends new turns
       * in real time alongside the DB snapshot. The id-spaces are distinct — this must
       * NOT be the same string as `sessionId` (which is the harness agentSessionId).
       *
       * This is the pluggable live stream-source seam (mt#2232 Rung 1).
       * Mutually exclusive with `liveByConversationId` — when both are set,
       * this workspace-keyed channel takes precedence.
       */
      workspaceSessionId?: WorkspaceId;
      /**
       * Opt in to the conversation-keyed live-tail channel (mt#2749): when
       * `true` (and `workspaceSessionId` is NOT set), `ConversationFetcher`
       * opens `GET /api/conversation/:sessionId/live-tail` directly off
       * `sessionId` — no workspace/cwd bridge required. Used by the
       * conversation surface (`ConversationPage`, keyed by agentSessionId
       * alone) where no workspace context exists at all.
       */
      liveByConversationId?: boolean;
      drivenSessionId?: undefined;
      drivenBlocks?: undefined;
      /**
       * Called once when the snapshot fetch resolves to a genuine "no
       * transcript" 404 (mt#2769) — NOT for `wrong_id_space`, which has its
       * own inline fail-loud surface and is a routing mistake, not an
       * invalid entity. Lets a URL-routed host (e.g. `ConversationPage`)
       * prune its own tab-strip entry for an unresolvable id.
       */
      onNotFound?: () => void;
    }
  | {
      snapshot: SessionContextSnapshot;
      sessionId?: undefined;
      workspaceSessionId?: never;
      liveByConversationId?: never;
      onNotFound?: never;
      className?: string;
      drivenSessionId?: undefined;
      drivenBlocks?: undefined;
    }
  | {
      /**
       * Driven-session id (mt#2751 Rung 2B — the `DrivenSessionRecord.localId`
       * a `useDrivenSession` caller is connected to). Opt-in driven-source
       * variant mirroring `liveByConversationId`'s shape: pass a distinct id +
       * its accumulated blocks rather than a DB-fetched `sessionId`/`snapshot`.
       * Unlike the other two variants, ConversationView does NOT own the data
       * connection here — the caller's own `useDrivenSession(drivenSessionId)`
       * call is the single source of truth (so composer/status UI siblings
       * outside this component can share the same WebSocket), and its
       * `blocks` are passed straight through as `drivenBlocks`.
       */
      drivenSessionId: string;
      /** The `blocks` array from the caller's `useDrivenSession` hook. */
      drivenBlocks: SessionContextSnapshotBlock[];
      /**
       * One-line record header (mt#4935, ADR-047 §Consequences) — the
       * caller's `useDrivenSession(drivenSessionId).harnessKind`/`.authMode`,
       * passed straight through (same "caller owns the data, this component
       * only renders" contract as `drivenBlocks` above). Omitted or `null`
       * renders no header line rather than a placeholder — the registry read
       * that supplies these is best-effort and may not have resolved yet.
       */
      harnessKind?: string | null;
      authMode?: string | null;
      sessionId?: undefined;
      snapshot?: undefined;
      workspaceSessionId?: never;
      liveByConversationId?: never;
      className?: string;
    }
  );

// ── Snapshot fetch — shared with ContextBlockView via lib/conversation-snapshot ──
// (mt#2768 "one snapshot query key" success criterion; see that module's docblock)

// ── Entity index for linkification ────────────────────────────────────────────
//
// The known-entity id-set used to linkify bare references (mt#NNNN, UUIDs) is
// now built by the shared `useEntityIndex` hook (../lib/use-entity-index.ts),
// extracted from this file in mt#2550 so every prose surface (`<Prose>`) shares
// one index. ConversationView consumes it via ConversationThread below.

// -- Turn rendering ------------------------------------------------------------
//
// `TurnView`, `buildTurnNodes`, the compaction boundary and the outcome-chip
// adapter now live in `../components/ConversationTurnView.tsx` (mt#4024), so
// the published share page renders the identical thread without importing this
// module and everything in it.

/**
 * The thread's bottom-edge chrome, as ONE sticky stack (mt#3843).
 *
 * Everything that pins to the bottom of the scrollport goes through here: the
 * thread's own floating controls (return-to-newest, position pill) and the
 * host's `tail`. Before this they were three independently-`sticky` elements —
 * two inside the thread, one mounted by the host as a SIBLING of it — all at
 * `z-10` in a single stacking context. That made their paint order DOM order
 * and their non-overlap an accident of horizontal alignment (`mx-auto` vs
 * `ml-auto`), and it did not hold: the host's tail, last and opaquely
 * backgrounded, covered 16.5px of the pill's 25px and took the click aimed at
 * the pill's "↑ start" button, leaving that control unreachable whenever a tool
 * was running. A flex column orders them by construction.
 *
 * Renders nothing at all when it holds nothing — an empty sticky box would
 * still claim the band and still eat clicks.
 */
function ThreadFooter({ floating, tail }: { floating?: ReactNode; tail?: ReactNode }) {
  if (!floating && !tail) return null;
  return (
    // `pointer-events-none` so the footer's transparent regions never eat a
    // click meant for the turn scrolling underneath; each member opts back in
    // for itself.
    <div
      className="pointer-events-none sticky bottom-0 z-10 flex flex-col"
      data-testid="thread-footer"
    >
      {/* The floating controls sit ABOVE the tail, and `pb-2` keeps them clear
          of the scrollport's bottom edge when no tail follows. The tail
          deliberately gets no such padding: its background has to reach the
          edge, because transcript text scrolls under it. */}
      {floating && <div className="flex flex-col gap-2 pb-2">{floating}</div>}
      {/* Restores the tail's ordinary hit-testing, which the footer's
          `pointer-events-none` would otherwise strip. It is opaque and
          full-width, so letting clicks fall through it to the transcript
          underneath would be the surprising behavior. */}
      {tail && <div className="pointer-events-auto">{tail}</div>}
    </div>
  );
}

function ConversationThread({
  snapshot,
  extraBlocks,
  className,
  turnTarget,
  filmPath,
  tail,
  isLoadingOlder = false,
  onLoadOlder,
}: {
  snapshot: SessionContextSnapshot;
  /**
   * A fetch for an older page is in flight (mt#4263). Only the self-fetching
   * host windows, so a caller passing a whole pre-fetched snapshot leaves both
   * of these unset and the thread behaves exactly as it did before.
   */
  isLoadingOlder?: boolean;
  /** Fetch the next older page. Absent when the host holds the whole transcript. */
  onLoadOlder?: () => void;
  /** Host chrome pinned to the thread's bottom edge — see `ConversationViewCommonProps.tail`. */
  tail?: ReactNode;
  /** Film-tab path enabling the per-row "watch this moment" link (mt#3794). */
  filmPath?: string;
  /**
   * A turn to land on instead of the newest exchange (mt#3791) — resolved from
   * the URL by the router-aware caller, so this component stays snapshot-in.
   */
  turnTarget?: TurnAddress;
  /**
   * Live-tail blocks to append after the snapshot's historical blocks (mt#2232).
   * When non-empty, they are merged into the block list before turn conversion.
   * Block ids in `extraBlocks` must NOT collide with snapshot block ids — live
   * blocks use the `<agentSessionId>:live:<N>` scheme to guarantee this.
   */
  extraBlocks?: SessionContextSnapshotBlock[];
  className?: string;
}) {
  // Build the entity index for transcript linkification. Fetches the same
  // underlying data as CommandPalette via useEntityIndex (which uses distinct
  // query keys to avoid cache-shape collisions — see useEntityIndex for details).
  const entityIndex = useEntityIndex();

  // Merge snapshot blocks with any live-tail appends.
  const allBlocks = useMemo(
    () =>
      extraBlocks && extraBlocks.length > 0
        ? [...snapshot.blocks, ...extraBlocks]
        : snapshot.blocks,
    [snapshot.blocks, extraBlocks]
  );

  // Blocks -> renderable turns, plus the rewind markers suppression leaves
  // behind. The model itself lives in `../lib/conversation-thread-model`
  // (mt#4024) so the published share page builds the identical one from the
  // same blocks; this component owns only the memo boundary.
  const {
    supersededGroups,
    blockIndexById,
    turnIndexByBlockId,
    blockIdByTurnIndex,
    callNameByToolUseId,
    visibleTurns,
  } = useMemo(
    () =>
      buildConversationThread(
        allBlocks,
        snapshot.spawnChildrenByToolUseId,
        snapshot.toolNamesByUseId
      ),
    [allBlocks, snapshot.spawnChildrenByToolUseId, snapshot.toolNamesByUseId]
  );

  /**
   * Turns the server still holds beyond what has been fetched (mt#4263).
   *
   * `0` whenever the response carried no window — which is every caller that
   * hands this component a whole pre-fetched snapshot, so nothing about those
   * paths changes. Derived from the response rather than counted locally
   * because `visibleTurns` is a count of RENDERABLE turns after rewind
   * suppression, and the server's cursor is an index into the raw transcript;
   * subtracting one from the other would produce a plausible wrong number.
   */
  // `nextBefore` is the count as well as the cursor: indices are zero-based, so
  // a cursor of 2186 means turns 0..2185 are unfetched. Reading
  // `oldestTurnIndex` here collapsed to 0 on a page that rendered nothing, and
  // a 0 falls through to "Beginning of conversation" over real history —
  // exactly the false picture this boundary exists to prevent (PR #3148 R1).
  const unfetchedBefore = Math.max(0, snapshot.window?.nextBefore ?? 0);

  /**
   * Where the rendered window STARTS, as an index into `visibleTurns` — `null`
   * until the operator has revealed anything.
   *
   * The null-vs-index distinction is load-bearing. While `null` the window is
   * DERIVED (`length - INITIAL_TURNS`) and therefore tracks the tail, so a live
   * session appending turns keeps showing the newest fifty — right for a reader
   * who has not scrolled. The first reveal turns it into an INDEX, which stops
   * moving, so later appends cannot push revealed history back out of the
   * window.
   *
   * Before mt#3688 both this and the separate "show all" flag were counts from
   * the TAIL, and `slice(length - count)` shifts forward as the tail grows: each
   * arriving turn silently re-hid one the operator had explicitly asked for. The
   * old "show all" carried a comment about exactly this hazard (PR #1667 R1) and
   * solved it only for itself; an index solves it for both, which is why the two
   * states collapse into this one — "show all" is just `revealedFrom === 0`.
   */
  // One-shot gate for the initial scroll-to-newest. Declared before the
  // session-change effect below, which re-arms it.
  const didInitialScrollRef = useRef(false);

  /**
   * Re-arm the one-shot on a genuine session SWAP — not on mount.
   *
   * Two details are load-bearing, and getting either wrong disables the
   * scroll-driven reveal silently (found by
   * `scripts/verify-conversation-orientation.ts`, which is the only place it is
   * observable — happy-dom cannot scroll):
   *
   *   - It compares the key rather than firing on every run of the effect. As a
   *     plain mount effect it re-armed on MOUNT too, landing AFTER the layout
   *     effect below had set the gate — so the gate read false for the entire
   *     session and `isNearTop` was never consulted.
   *   - It is a LAYOUT effect, so on a real swap the reset lands before the
   *     scroll effect below reads the gate. As a passive effect it would run
   *     after, clobbering the flag that effect had just set.
   *
   * The render window resets on the same key, inside `useThreadWindow`.
   */
  const lastSessionKeyRef = useRef(snapshot.agentSessionId);
  useLayoutEffect(() => {
    if (lastSessionKeyRef.current === snapshot.agentSessionId) return;
    lastSessionKeyRef.current = snapshot.agentSessionId;
    didInitialScrollRef.current = false;
  }, [snapshot.agentSessionId]);

  /**
   * Whether the live tail should follow new content — false once the operator
   * has scrolled up to read history (mt#3376). Declared here, ahead of the
   * window hook, because a reveal that jumps to the start clears it.
   */
  const pinnedRef = useRef(true);

  /**
   * The resolved scrollport, as STATE so that everything depending on it — the
   * scroll listener below, the measurement effect further down — moves together
   * the moment the resolution changes (mt#3445).
   *
   * It is state rather than a ref because the resolution genuinely changes
   * mid-session and nothing else announces it: `findScrollParent` only accepts
   * an ancestor that ALREADY overflows, and a live thread spends its first
   * seconds too short to overflow anything, so the first answer is always the
   * document fallback. Keying the listener on a ref left it bound to an element
   * that does not scroll — the reader's scrolling was then never heard, and
   * whether it ever corrected depended on a ResizeObserver bump landing at the
   * right moment (observed: it often did not, for a whole session).
   *
   * The REF half is what the window hook and the measurement effect read, since
   * both run outside render and want the resolution as of right now.
   */
  const scrollportRef = useRef<Element | null>(null);
  const [scrollport, setScrollport] = useState<Element | null>(null);

  const {
    hiddenBefore,
    renderEnd,
    isRevealing,
    revealingCount,
    revealOlder,
    notePinned,
    revealFromStart,
    revealTo,
    paintPosition,
    positionFillRef,
    positionReadoutRef,
  } = useThreadWindow({
    totalTurns: visibleTurns.length,
    sessionKey: snapshot.agentSessionId,
    scrollportRef,
    pinnedRef,
  });

  // Serving an incoming turn address — resolve, reveal, land (mt#3791). Called
  // after the window hook because its landing must run after that hook's
  // post-reveal scroll correction; see the hook's own docblock.
  const { addressed, addressedTurn, threadRef } = useTurnAddressLanding({
    turnTarget,
    blockIdByTurnIndex,
    visibleTurns,
    hiddenBefore,
    revealTo,
    didInitialScrollRef,
    pinnedRef,
  });

  const windowedTurns = useMemo(
    () => visibleTurns.slice(hiddenBefore, renderEnd),
    [visibleTurns, hiddenBefore, renderEnd]
  );

  /**
   * What the scroll listener needs to decide whether reaching the top should
   * FETCH (mt#4263), held in a ref for the same reason `useThreadWindow` keeps
   * its own window state in one: the listener below is keyed on its scrollport
   * alone and must not re-bind every time a page arrives.
   *
   * Assigned during render and read only from the event handler, so nothing
   * renders from it.
   */
  const loadOlderRef = useRef<{
    hiddenBefore: number;
    canLoad: boolean;
    load: (() => void) | undefined;
  }>({ hiddenBefore, canLoad: false, load: undefined });
  loadOlderRef.current = {
    hiddenBefore,
    canLoad: unfetchedBefore > 0 && !isLoadingOlder,
    load: onLoadOlder,
  };

  // Merge call+result pairs within the rendered window (mt#2790), then drop
  // any turn that has nothing left to render (a pure-tool-result USER turn
  // whose result got merged into its call's block above).
  const preparedTurns = useMemo(
    () =>
      mergeCommandInvocations(pairToolInvocations(windowedTurns, callNameByToolUseId)).filter((t) =>
        t.elements.some(hasRenderablePreparedElement)
      ),
    [windowedTurns, callNameByToolUseId]
  );

  // View-level expand-all / collapse-all broadcast (mt#2790): each click bumps
  // `epoch` so every mounted ToolInvocation re-syncs its local `open` state.
  const [expandSignal, setExpandSignal] = useState<ExpandSignal>(undefined);

  /**
   * The dispatch brief, pinned above the thread's start boundary (mt#4909).
   *
   * A subagent conversation opens with the assignment its parent wrote, and the
   * tail-first FETCH (mt#4263 — not the render window; the two are different
   * mechanisms) leaves that turn unfetched on anything longer than one page. It
   * was three `load earlier turns` round trips away on the conversation this
   * was measured against, which made mt#4354's whole argument — the brief is
   * what a reader opens this page to find — false in practice.
   *
   * Built by running the ONE block back through the same thread pipeline the
   * windowed turns use, rather than rendering it specially. A brief pinned here
   * and the same brief reached by paging back must be the same artifact; giving
   * the pin its own render path is how those two drift, and mt#4354's header,
   * ascent link and folded boilerplate all live in that shared path anyway.
   *
   * `null` whenever the server sent no head block — a root conversation, a
   * pre-stamp subagent, or a window that already reached index 0 — so there is
   * no empty affordance in any of those cases.
   */
  const pinnedBriefNodes = useMemo(() => {
    const head = snapshot.headBlock;
    if (head === undefined) return null;
    const brief = buildConversationThread(
      [head],
      snapshot.spawnChildrenByToolUseId,
      snapshot.toolNamesByUseId
    );
    const prepared = mergeCommandInvocations(
      pairToolInvocations(brief.visibleTurns, brief.callNameByToolUseId)
    ).filter((t) => t.elements.some(hasRenderablePreparedElement));
    if (prepared.length === 0) return null;
    return buildTurnNodes({
      preparedTurns: prepared,
      supersededGroups: [],
      blockIndexById: brief.blockIndexById,
      turnIndexByBlockId: brief.turnIndexByBlockId,
      entityIndex,
      expandSignal,
      filmPath,
    });
  }, [
    snapshot.headBlock,
    snapshot.spawnChildrenByToolUseId,
    snapshot.toolNamesByUseId,
    entityIndex,
    expandSignal,
    filmPath,
  ]);

  // Land on the newest exchange once, after the windowed items are actually in
  // the DOM (layout effect keyed on the mounted count — an empty first commit
  // must not consume the one-shot; PR #1667 R1). Expanding "Show older" later
  // must not yank the scroll position, hence the one-shot flag.
  const endRef = useRef<HTMLDivElement | null>(null);
  // The sentinel as STATE as well as a ref, because everything that measures
  // this thread hangs off it and a ref alone cannot wake an effect when it
  // arrives (mt#3445). A live session mounts EMPTY — the early return above
  // renders no sentinel — so a mount-time effect reading `endRef.current` binds
  // to nothing and never rebinds once the first turn lands.
  const [endNode, setEndNode] = useState<HTMLDivElement | null>(null);
  const attachEnd = useCallback((node: HTMLDivElement | null) => {
    endRef.current = node;
    setEndNode(node);
  }, []);
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    // An address is a more specific instruction than "land on the newest"
    // (mt#3791), and both want to own the arrival. Yield without consuming the
    // one-shot: if the address turns out to resolve to no element, this effect
    // is still owed its landing on a later commit.
    if (addressedTurn) return;
    if (preparedTurns.length === 0) return;
    didInitialScrollRef.current = true;
    if (hiddenBefore > 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
    // Keyed on the session too, so a swap whose new transcript happens to have
    // the same turn count and window still re-runs this and re-lands on its
    // newest turn — and re-sets the gate the reset above just cleared.
  }, [preparedTurns.length, hiddenBefore, snapshot.agentSessionId, addressedTurn]);

  // Live-tail auto-scroll: when live content arrives (the SSE stream, mt#2232,
  // or a driven session's WS frames), scroll to the bottom so the operator sees
  // it — but ONLY when the operator is already at the bottom (mt#3376).
  // Scrolling unconditionally yanked the view out from under anyone reading
  // back through an active session, once per arriving tool call or message.
  const extraBlocksLen = extraBlocks?.length ?? 0;
  const [hasNewBelow, setHasNewBelow] = useState(false);

  // Forces a re-render whenever the thread's own box changes size — the signal
  // that layout, not content, may have created or removed a scrollport.
  // `ResizeObserver` catches in-page causes (a tool block expanding, a sibling
  // panel opening) that a window-resize listener alone would miss; the window
  // listener is the fallback where `ResizeObserver` is unavailable (older test
  // DOMs).
  //
  // The COUNT is deliberately never read (PR #2469 R2). What this state exists
  // for is the render it schedules: the resolution effect below re-runs on every
  // render, so scheduling one is the whole mechanism, and there is nothing for a
  // dependency array to compare. Do not delete it as unused — a window resize
  // that gives the thread a scrollport, or takes one away, changes no other
  // state, so without this the view would keep measuring a stale scrollport.
  const [, setLayoutTick] = useState(0);
  useEffect(() => {
    const bump = () => setLayoutTick((t) => t + 1);
    const target = endNode?.parentElement;
    if (typeof ResizeObserver === "function" && target) {
      const observer = new ResizeObserver(bump);
      observer.observe(target);
      return () => observer.disconnect();
    }
    if (typeof window === "undefined") return;
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
    // Keyed on the sentinel NODE, not `[]`: it does not exist on the first
    // commit of a live session, and a `[]` effect would observe nothing for the
    // rest of the session (mt#3445).
  }, [endNode]);

  // Keep `pinnedRef` current from the scrollport itself. Sampling at append
  // time would be too late — the append is what moves the scroll.
  useEffect(() => {
    if (!scrollport) return;
    /** Sample the scrollport. Runs on mount AND on every scroll. */
    const sample = () => {
      const pinned = isPinnedToBottom(scrollport);
      pinnedRef.current = pinned;
      // The window has to hear this too, not just the live tail (mt#3736).
      // Holding the scroll position is not enough on its own: while the window
      // tracks the tail, every arriving turn unmounts the oldest rendered one
      // and the reader's content slides up by that turn's height without any
      // scroll happening at all.
      notePinned(pinned);
      // Scrolling back down by hand dismisses the affordance too — the
      // operator has caught up, so there is nothing left to point at.
      if (pinned) setHasNewBelow(false);
      paintPosition(scrollport);
    };
    /**
     * Reveal older turns as the reader approaches the top.
     *
     * Bound to the EVENT only, deliberately never to the priming call below. A
     * reveal answers the reader scrolling; it must not answer this component
     * re-resolving its scrollport, which happens on a schedule of its own (the
     * resolution effect re-runs on every render, and the resolution genuinely
     * moves mid-session — mt#3445). Priming at scrollTop 0 would read as "near
     * the top" every time that happened, and since each reveal re-renders, the
     * result was a loop that unwound the whole window in one mount — mounting
     * the entire transcript, the precise cost the window exists to avoid.
     */
    const onScroll = () => {
      sample();
      if (!didInitialScrollRef.current || !isNearTop(scrollport)) return;
      revealOlder();
      // Everything fetched is already mounted, and the server still holds
      // history: the same gesture has to cross the FETCH boundary too, or
      // scrolling to the top of a windowed conversation stops at a wall the
      // reader has no way to see past. `revealOlder` above is a no-op in this
      // state (it bails when the window cannot move back), so the two never
      // both fire for one scroll frame.
      const older = loadOlderRef.current;
      if (older.hiddenBefore === 0 && older.canLoad) older.load?.();
    };
    sample();
    scrollport.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollport.removeEventListener("scroll", onScroll);
    // Just the resolved element. Whether an element scrolls is a LAYOUT fact,
    // not a content-count fact (PR #2459 R1, non-blocking) — and the resolution
    // effect below already re-runs on every render, so a re-resolution reaches
    // this listener by changing the thing it is keyed on, rather than by this
    // effect guessing which inputs might have moved it.
    //
    // The two callbacks are stable by construction (`useCallback` over refs, not
    // over the window state), so listing them satisfies exhaustive-deps without
    // reintroducing the per-chunk re-binding this key deliberately avoids.
  }, [scrollport, paintPosition, revealOlder, notePinned]);

  const scrollToEnd = useCallback(() => {
    endRef.current?.scrollIntoView({ block: "end" });
    pinnedRef.current = true;
  }, []);

  const scrollToNewest = useCallback(() => {
    scrollToEnd();
    setHasNewBelow(false);
  }, [scrollToEnd]);

  // The last state the arrival check ran against. `extraBlocks` is replaced
  // wholesale by every accumulator fold (`upsertBlock` returns a new array in
  // both its append and its in-place-replace branch), so its IDENTITY is an
  // exact, O(1) "live content arrived" signal — where its LENGTH is not, since
  // a streaming turn folds every delta into one block id.
  const prevExtraBlocksRef = useRef(extraBlocks);
  const prevExtraBlocksLenRef = useRef(extraBlocksLen);
  const prevHeightRef = useRef<number | null>(null);

  // Decide what to do about content that arrived (mt#3445). Runs on every
  // render rather than on a turn count, because the case that matters most —
  // a single assistant turn streaming for a minute — never changes the count.
  //
  // Two independent signals, both required:
  //   - identity: did live content actually arrive, or did the thread just
  //     reflow? Expanding a tool block grows the thread by hundreds of pixels
  //     and is not "new messages below".
  //   - height: did that arrival land BELOW the reader? A count bump answers
  //     this for a new turn; only a measurement answers it for in-place growth.
  //
  // The measurement is one `scrollHeight` read in a layout effect — the same
  // layout the frame is about to perform anyway, and cheaper than the
  // `scrollIntoView` this effect already ran per turn before mt#3445.
  useLayoutEffect(() => {
    const contentArrived = extraBlocks !== prevExtraBlocksRef.current;
    const countGrew = extraBlocksLen > prevExtraBlocksLenRef.current;
    prevExtraBlocksRef.current = extraBlocks;
    prevExtraBlocksLenRef.current = extraBlocksLen;

    // Re-resolve unless the cached element is ACTUALLY scrolling. The cache is
    // an optimization, and a resolution that landed on the document fallback is
    // exactly the one that must not stick: it reports a constant height, so no
    // growth is ever measurable against it and no scroll of the reader's is
    // ever heard. Correcting it must not depend on a ResizeObserver bump
    // arriving at the right moment — that was observed failing for a whole
    // session, leaving the affordance silent while the thread doubled in height.
    const cached = scrollportRef.current;
    const resolved =
      cached && cached.scrollHeight > cached.clientHeight
        ? cached
        : findScrollParent(endRef.current);
    if (resolved !== cached) {
      scrollportRef.current = resolved;
      // Wakes the scroll listener above onto the element that actually scrolls.
      setScrollport(resolved);
    }
    if (!resolved) return;

    const height = resolved.scrollHeight;
    const previousHeight = prevHeightRef.current;
    prevHeightRef.current = height;

    if (!contentArrived) return;
    if (!countGrew && !hasGrown(previousHeight, height)) return;

    if (pinnedRef.current) {
      scrollToEnd();
      return;
    }
    // Reading history: hold position and say something arrived instead.
    setHasNewBelow(true);
  });

  if (visibleTurns.length === 0) {
    // Both empty states still render the host's tail (mt#3843). A conversation
    // with no turns can be running RIGHT NOW — "Running <tool>" is precisely
    // what explains why there is nothing to show yet — and before the tail
    // became a prop the host rendered it as a sibling, so it appeared here.
    // There are no floating controls to collide with, so `ThreadFooter` holds
    // the tail alone.
    if (supersededGroups.length > 0) {
      return (
        <div className={cn("flex flex-col gap-3", className)}>
          <p className="text-sm text-muted-foreground">
            Every message in this session was superseded — the operator rewrote each one before the
            agent received it.
          </p>
          {supersededGroups.map((group) => (
            <SupersededPromptMarker key={supersededMarkerKey(group)} prompts={group.prompts} />
          ))}
          <ThreadFooter tail={tail} />
        </div>
      );
    }
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <p className="text-sm text-muted-foreground">
          This session has no conversational turns to display.
        </p>
        <ThreadFooter tail={tail} />
      </div>
    );
  }

  // Shown only once the conversation is long enough that the window mechanism
  // engaged at all (mt#3688). Below INITIAL_TURNS every turn is rendered, so the
  // native scrollbar already tells the truth and a floating readout would be
  // chrome for its own sake.
  const showPositionPill = visibleTurns.length > INITIAL_TURNS;
  // Built as one node so `ThreadFooter` can distinguish "no floating controls"
  // from "controls that happen to render nothing" — a `children` array of
  // `false`s is still truthy, which would leave an empty padded box in the stack.
  const floatingControls =
    hasNewBelow || showPositionPill ? (
      <>
        {/* Return-to-newest (mt#3376). Rendered only while the operator is
            scrolled up AND live content has arrived since — the two conditions
            that together mean "you are missing something below". */}
        {hasNewBelow && (
          <button
            type="button"
            onClick={scrollToNewest}
            data-testid="jump-to-newest"
            className="pointer-events-auto mx-auto w-fit rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            New messages below ↓
          </button>
        )}
        {showPositionPill && (
          <ThreadPositionPill
            fillRef={positionFillRef}
            readoutRef={positionReadoutRef}
            totalTurns={visibleTurns.length}
            hiddenBefore={hiddenBefore}
            onRevealFromStart={revealFromStart}
          />
        )}
      </>
    ) : null;

  return (
    // `[overflow-anchor:none]` opts the thread OUT of the browser's scroll
    // anchoring (mt#3688). The reveal corrects the scroll itself, because the
    // platform mechanism does not exist in WebKit — the engine the tray's macOS
    // window uses — and a correction competing with an anchor on the engines
    // that DO implement it would double-count the prepended height.
    <div
      ref={threadRef}
      // An app-owned marker for the out-of-process verify scripts (PR #2693 R1).
      // They used to find this element by its `scroll-mb-8` sentinel child and a
      // parentElement hop, so an unrelated class or wrapper change broke the
      // geometry checks silently. A testid is a contract; a class fragment is not.
      data-testid="conversation-thread"
      className={cn("flex flex-col gap-4 [overflow-anchor:none]", className)}
    >
      <SpawnParentBacklink parent={snapshot.spawnParent} />
      {/* An address that names no rendered turn says so (mt#3791). Silence here
          is the failure this task was filed on: the reader followed a link to a
          specific action and cannot tell whether it landed. */}
      {addressed === "unresolved" && (
        <p
          data-testid="turn-address-unresolved"
          className="text-xs italic text-muted-foreground/70"
        >
          Couldn&apos;t find that turn in this conversation — it may have been rewound, or the link
          may predate a re-ingest of this transcript. Showing the whole thread instead.
        </p>
      )}
      <div className="flex items-center justify-end gap-3 text-[11px] text-muted-foreground/70">
        <button
          type="button"
          onClick={() => setExpandSignal((s) => ({ epoch: (s?.epoch ?? 0) + 1, open: true }))}
          className="transition-colors hover:text-foreground hover:underline"
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={() => setExpandSignal((s) => ({ epoch: (s?.epoch ?? 0) + 1, open: false }))}
          className="transition-colors hover:text-foreground hover:underline"
        >
          Collapse all
        </button>
      </div>
      {/* Above the start boundary, not below it (mt#4909): the boundary's job
          is to say what sits further back, and the brief is the conversation's
          own opening rather than something hidden behind that count. Reading
          top-down then gives the assignment, then "N earlier turns not loaded",
          then the turns — which is the order they actually occurred in. */}
      {pinnedBriefNodes !== null && (
        <div data-testid="pinned-dispatch-brief" className="flex flex-col gap-4">
          {pinnedBriefNodes}
        </div>
      )}
      <ThreadStartBoundary
        hiddenBefore={hiddenBefore}
        isRevealing={isRevealing}
        revealingCount={revealingCount}
        firstTurnAt={visibleTurns[0]?.timestamp}
        onRevealOlder={revealOlder}
        onRevealFromStart={revealFromStart}
        unfetchedBefore={unfetchedBefore}
        isLoadingOlder={isLoadingOlder}
        onLoadOlder={onLoadOlder}
      />
      {buildTurnNodes({
        preparedTurns,
        supersededGroups,
        blockIndexById,
        turnIndexByBlockId,
        entityIndex,
        expandSignal,
        address: addressedTurn ? turnTarget : undefined,
        addressedBlockId: addressedTurn?.blockId,
        filmPath,
      })}
      <ThreadFooter tail={tail} floating={floatingControls} />
      {/* The end sentinel both `scrollIntoView({block:"end"})` calls target.
          
          `scroll-mb-8` was load-bearing under mt#3344, when the activity strip
          was mounted BELOW this sentinel by the host: aligning the sentinel's
          bottom to the scrollport's bottom would have parked the newest turn
          exactly where the strip floated, so the reservation kept the strip
          off the turn it reports on. mt#3843 moved the strip ABOVE the
          sentinel into `thread-footer`, which removes that condition — the
          sentinel is now the last element in the scrollport, so the margin has
          no room left to consume and is inert.
          
          It is kept rather than deleted because `PINNED_THRESHOLD_PX`
          (`lib/scroll-pinning.ts`) documents itself as this 32px plus 16px of
          slack, and re-deriving that constant is mt#3455's subject, not this
          task's. Retiring the class belongs in the same change that corrects
          that derivation. */}
      <div ref={attachEnd} aria-hidden className="scroll-mb-8" />
    </div>
  );
}

// ── Driven-session wrapper (mt#2751 Rung 2B) ────────────────────────────────────

/** Stable empty-array reference — avoids recreating a fresh `[]` (and therefore
 * invalidating `ConversationThread`'s internal `useMemo`) on every render. */
const EMPTY_DRIVEN_BASE_BLOCKS: SessionContextSnapshotBlock[] = [];
/** Fixed placeholder — never read by any renderer; only present because
 * `SessionContextSnapshot.assembledAt` is required by the type. */
const DRIVEN_BASE_ASSEMBLED_AT = new Date(0).toISOString();

/**
 * Wraps a driven session's live-accumulated `drivenBlocks` in an empty base
 * snapshot and feeds them through `ConversationThread`'s `extraBlocks` seam —
 * the SAME renderer `ConversationFetcher` uses for the two SSE live-tail
 * channels above. Verifies mt#2751 success criterion 2 ("the display
 * component is shared with Rung 1... verified by shared code path").
 */
function DrivenSessionThread({
  drivenSessionId,
  drivenBlocks,
  harnessKind,
  authMode,
  className,
  turnTarget,
  filmPath,
  tail,
}: ConversationViewCommonProps & {
  drivenSessionId: string;
  drivenBlocks: SessionContextSnapshotBlock[];
  /** mt#4935 — one-line record header; see `ConversationViewProps`'s doc comment. */
  harnessKind?: string | null;
  authMode?: string | null;
  className?: string;
}) {
  const baseSnapshot = useMemo<SessionContextSnapshot>(
    () => ({
      agentSessionId: drivenSessionId,
      // `claude_code` is correct-by-construction here, not a placeholder: the
      // driven-session host (mt#2750) only ever spawns the genuine `claude`
      // binary, so a driven session IS a Claude Code harness session. If the
      // host ever drives a second harness, thread the harness through from the
      // driven-session record instead (mt#2751 R1 note).
      //
      // mt#4935 note: that "thread it through" record now exists
      // (`harnessKind` below), but this field is a DIFFERENT vocabulary —
      // the transcript-rendering SOURCE FORMAT (`SessionContextSnapshot`'s
      // own underscore-cased `harness` enum), not the supervisor's
      // hyphen-cased `harness_kind` column. The two happen to agree today
      // because only one harness exists; conflating them is a decision for
      // whichever task actually adds a second rendering format, not this one.
      harness: "claude_code",
      blocks: EMPTY_DRIVEN_BASE_BLOCKS,
      assembledAt: DRIVEN_BASE_ASSEMBLED_AT,
    }),
    [drivenSessionId]
  );
  return (
    <>
      {/* mt#4935, ADR-047 §Consequences, SC6 — one line, no new widget. Renders
          nothing until the registry read resolves (harnessKind/authMode both
          null while pending) — see useDrivenSession.ts's doc comment. */}
      {(harnessKind || authMode) && (
        <div className="mb-2 font-mono text-xs text-muted-foreground">
          {harnessKind ?? "unknown harness"}
          {authMode ? ` · ${authMode}` : ""}
        </div>
      )}
      <ConversationThread
        snapshot={baseSnapshot}
        extraBlocks={drivenBlocks.length > 0 ? drivenBlocks : undefined}
        className={className}
        turnTarget={turnTarget}
        filmPath={filmPath}
        tail={tail}
      />
    </>
  );
}

// ── Self-fetching wrapper ───────────────────────────────────────────────────────

function ConversationFetcher({
  sessionId,
  workspaceSessionId,
  liveByConversationId,
  onNotFound,
  className,
  turnTarget,
  filmPath,
  tail,
}: ConversationViewCommonProps & {
  sessionId: ConversationId;
  /**
   * When provided, opens a live-tail SSE connection and appends new turns to
   * the static snapshot in real-time (mt#2232 Rung 1). Must be the Minsky
   * workspace sessionId (WorkspaceId) — NOT the same string as `sessionId`.
   */
  workspaceSessionId?: WorkspaceId;
  /**
   * When `true` (and `workspaceSessionId` is NOT set), opens the
   * conversation-keyed live-tail channel directly off `sessionId` (mt#2749).
   */
  liveByConversationId?: boolean;
  /** See `ConversationViewProps` — fires on a genuine 404, not on wrong_id_space. */
  onNotFound?: () => void;
  className?: string;
}) {
  /**
   * The conversation is fetched a PAGE at a time (mt#4263).
   *
   * This host is the only snapshot consumer that renders a window rather than
   * aggregating over every block, so it is the only one that asks for one. The
   * other three keep calling `fetchSnapshot(sessionId)` with no window and keep
   * receiving the whole transcript under the unchanged three-part query key.
   *
   * `INITIAL_TURNS` is reused as the page size rather than picking a second
   * number: it is already what the render window mounts, so a page fetched is a
   * page shown, and the two budgets cannot drift apart.
   */
  const windowParams = useMemo(() => ({ turns: INITIAL_TURNS }), []);
  const query = useInfiniteQuery<SessionContextSnapshot, Error>({
    queryKey: snapshotQueryKey(sessionId, windowParams),
    queryFn: ({ pageParam }) =>
      fetchSnapshot(sessionId, {
        ...windowParams,
        ...(typeof pageParam === "number" ? { before: pageParam } : {}),
      }),
    initialPageParam: undefined,
    // The cursor is the oldest ORIGINAL turn index this page reached, which is
    // exactly what the endpoint's `before` is exclusive of. `undefined` stops
    // paging — TanStack's contract for "no next page" — and `hasMore` false is
    // the server saying it has nothing older.
    // `nextBefore`, NOT `oldestTurnIndex` — the latter describes what rendered
    // and is null for a page of purely non-renderable entries, which would end
    // paging while the server still reports history (PR #3148 R1).
    getNextPageParam: (lastPage) => lastPage.window?.nextBefore ?? undefined,
    staleTime: 30_000,
    retry: snapshotRetry,
  });

  /**
   * The pages folded back into the one snapshot the thread consumes.
   *
   * Merging HERE rather than teaching the thread about pages keeps every other
   * consumer of `ConversationThread` — the share page, the publish preview,
   * the driven-session host — on the plain single-snapshot shape they already
   * pass.
   */
  const mergedSnapshot = useMemo(
    () => (query.data ? mergeSnapshotPages(query.data.pages) : undefined),
    [query.data]
  );

  // Live-tail seam: exactly one of the two channels is active per host —
  // workspaceSessionId (mt#2232, WorkspaceDetailPage) takes precedence when
  // both happen to be set; liveByConversationId (mt#2749, ConversationPage)
  // opens the conversation-keyed channel with no workspace bridge. Both hooks
  // are always called (rules-of-hooks) — each is a no-op when its id arg is
  // falsy, so only the selected channel actually connects.
  const workspaceLive = useLiveTail(workspaceSessionId);
  const conversationLive = useConversationLiveTail(
    liveByConversationId && !workspaceSessionId ? sessionId : undefined
  );
  const liveBlocks = workspaceSessionId ? workspaceLive.liveBlocks : conversationLive.liveBlocks;

  // mt#3131 (PR #2245 R1): all error-code/status interpretation is centralized
  // in `classifySnapshotError` (lib/conversation-snapshot.ts) next to the
  // `SnapshotError` type it classifies — this component never keys on raw
  // `code === "..."` strings or bare status numbers, so a server-side contract
  // drift has exactly one client site to update.
  const errClass = query.isError ? classifySnapshotError(query.error) : null;
  const wrongIdSpace = errClass === "wrong_id_space";
  // mt#3131 (D3/D5): the server rejects a syntactically-invalid id (not even
  // UUID-shaped) BEFORE any DB lookup, so it can never mean "still running" —
  // distinguish it from a genuine "no transcript yet" so the copy below never
  // tells the reader an impossible id "may still be running".
  const invalidId = errClass === "invalid_id";
  const notFound = errClass === "not_found";

  // Report a genuine unresolvable id to the host (mt#2769) — e.g. so a
  // URL-routed page can prune its own tab-strip entry. NOT fired for
  // wrong_id_space: that's a routing mistake (a valid workspace id used on
  // the wrong route), not an invalid entity. `invalidId` (mt#3131 D3/D5) is
  // the strongest case of "genuinely unresolvable" — it fires too.
  useEffect(() => {
    if (notFound || invalidId) onNotFound?.();
  }, [notFound, invalidId, onNotFound]);

  if (query.isError) {
    // Fail LOUD on the wrong-id-space mistake (mt#2525 / mt#2420): a workspace
    // session id was passed where a harness conversation id is required. This
    // must NOT fall through to the "no transcript yet" empty state — that was
    // the original misleading surface. Also key off the 422 status so an
    // intermediary/proxy that drops the JSON body but preserves the status still
    // routes here (reviewer #1729 robustness suggestion).
    if (wrongIdSpace) {
      return (
        <div
          role="alert"
          className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}
        >
          <p className="text-sm font-medium text-destructive">
            Wrong id type for the conversation view.
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            This looks like a Minsky workspace session id, not a harness conversation id.{" "}
            <Link to={`/agents/${encodeURIComponent(sessionId)}`} className="underline">
              Open its workspace detail page
            </Link>{" "}
            and use its &ldquo;View conversation&rdquo; link to reach the transcript.
          </p>
          <ThreadFooter tail={tail} />
        </div>
      );
    }
    // mt#3131 (D5): a syntactically-invalid id is definitively NOT FOUND —
    // it could never have resolved, so the copy must not suggest it "may
    // still be running" (that framing only makes sense for a plausible id
    // whose transcript simply hasn't landed yet).
    if (invalidId) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}>
          <p className="text-sm text-muted-foreground">Conversation not found.</p>
          <p className="max-w-md text-xs text-muted-foreground/70">
            &ldquo;{sessionId}&rdquo; is not a valid conversation id.
          </p>
          <ThreadFooter tail={tail} />
        </div>
      );
    }
    if (notFound) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}>
          <p className="text-sm text-muted-foreground">
            No conversation transcript for this session yet.
          </p>
          <p className="max-w-md text-xs text-muted-foreground/70">
            Transcripts are ingested when a Claude Code session ends; this one may still be running,
            or its transcript was never ingested.
          </p>
          {/* The most load-bearing of these branches for the tail (mt#3843):
              a transcript is ingested when the harness session ENDS, so a
              conversation that is running right now routinely has none — and
              "Running <tool>" is the line that says the emptiness is liveness,
              not absence. */}
          <ThreadFooter tail={tail} />
        </div>
      );
    }
    return (
      <>
        <ErrorState prefix="Failed to load conversation" error={query.error} className={className} />
        <ThreadFooter tail={tail} />
      </>
    );
  }
  if (query.isLoading || !mergedSnapshot) {
    return (
      <>
        <LoadingState message="Loading conversation…" className={className} />
        <ThreadFooter tail={tail} />
      </>
    );
  }
  return (
    <ConversationThread
      snapshot={mergedSnapshot}
      extraBlocks={liveBlocks.length > 0 ? liveBlocks : undefined}
      className={className}
      turnTarget={turnTarget}
      filmPath={filmPath}
      tail={tail}
      isLoadingOlder={query.isFetchingNextPage}
      onLoadOlder={query.hasNextPage ? () => void query.fetchNextPage() : undefined}
    />
  );
}

// ── Public component ────────────────────────────────────────────────────────────

/**
 * Renders a session's conversation as a chronological chat thread. Layout-agnostic:
 * the host supplies the chrome. Pass `sessionId` (self-fetch), `snapshot`
 * (pre-fetched), or `drivenSessionId`+`drivenBlocks` (mt#2751 live-only, no DB
 * snapshot).
 *
 * Two mutually-exclusive live-tail seams (both bridge a DB-fetched snapshot with
 * a live SSE append):
 *   - `workspaceSessionId` (mt#2232 Rung 1) — real-time appends bridged through
 *     a Minsky workspace. `sessionId` is the harness ConversationId;
 *     `workspaceSessionId` is the distinct Minsky workspace WorkspaceId.
 *   - `liveByConversationId` (mt#2749) — real-time appends opened directly off
 *     `sessionId` alone, no workspace bridge. Used on the conversation surface
 *     (`ConversationPage`), which has no workspace context at all.
 *
 * A third, fully-live seam needs no DB snapshot at all:
 *   - `drivenSessionId` + `drivenBlocks` (mt#2751 Rung 2B) — a driven session
 *     the caller is connected to via its own `useDrivenSession` hook; see
 *     `DrivenSessionThread` above.
 */
export function ConversationView(props: ConversationViewProps) {
  if (props.snapshot !== undefined) {
    return (
      <ConversationThread
        snapshot={props.snapshot}
        className={props.className}
        turnTarget={props.turnTarget}
        filmPath={props.filmPath}
        tail={props.tail}
      />
    );
  }
  if (props.drivenSessionId !== undefined) {
    return (
      <DrivenSessionThread
        drivenSessionId={props.drivenSessionId}
        drivenBlocks={props.drivenBlocks}
        harnessKind={props.harnessKind}
        authMode={props.authMode}
        className={props.className}
        turnTarget={props.turnTarget}
        filmPath={props.filmPath}
        tail={props.tail}
      />
    );
  }
  return (
    <ConversationFetcher
      sessionId={props.sessionId}
      workspaceSessionId={props.workspaceSessionId}
      liveByConversationId={props.liveByConversationId}
      onNotFound={props.onNotFound}
      className={props.className}
      turnTarget={props.turnTarget}
      filmPath={props.filmPath}
      tail={props.tail}
    />
  );
}
