/**
 * Turn-origin classifier (mt#3374) — who actually authored a `user`-role turn.
 *
 * The conversation view labels every turn from `turn.role` alone, so a turn the
 * HARNESS injected (a skill body, a slash-command wrapper, a system-reminder, a
 * tool result) renders under the same `user` label as a message the operator
 * typed. The principal's report: "there was one user-labeled block, but it was
 * a skill body. That's not really a message from me; that's from the harness."
 *
 * Everything needed to tell them apart is already computed one layer down —
 * `splitInjectedContent` (`./injected-content.ts`, mt#2791 / mt#3322) classifies
 * each span by origin, and the renderer collapses it. The classification just
 * never reached the turn's label. This module carries it the last step, so
 * there is ONE origin classifier rather than a second heuristic living in the
 * render layer.
 *
 * **Per-origin labels, not a single "harness".** Principal decision, 2026-07-30:
 * a turn carrying a skill body says `skill body`, one carrying a tool result says
 * `tool result`. The vocabulary is `InjectedContentKind`'s existing taxonomy plus
 * the tool-result case — no new taxonomy is invented here.
 *
 * Pipeline-agnostic by construction: it reads `PreparedTurn`, which both the
 * DB-sourced observed path and the driven-session WS path produce. A driven
 * session's operator turns arrive as `minsky_operator_input` frames (mt#3372)
 * and carry real prose, so they classify as operator; every other `user` frame
 * on that channel is harness-origin and classifies accordingly.
 *
 * @see mt#3374 — this module
 * @see mt#3809 — the precedence fix documented on `classifyTurnOrigin` below
 * @see ./injected-content.ts — the span-level classifier this consumes
 * @see ../widgets/ConversationView.tsx — the consumer (turn label + accent)
 */
import { INJECTED_KIND_NOUN } from "./injected-content";
import { TOOL_RESULT_NOUN, type PreparedElement } from "../components/ConversationElementRenderers";

/**
 * A turn's author. `null` from {@link classifyTurnOrigin} means "no origin
 * signal" — the caller keeps its existing role-derived styling rather than
 * guessing.
 */
export type TurnOrigin = { kind: "operator" } | { kind: "harness"; label: string };

/**
 * Label for a turn that mixes several harness origins. Rare (the harness
 * usually injects one kind per turn), but a turn labeled with only ONE of its
 * several origins would be actively misleading, so it degrades to the general
 * term rather than picking a winner.
 */
const MIXED_HARNESS_LABEL = "harness";

/** The harness-origin label an element contributes, or null if it contributes none. */
function harnessLabelOf(element: PreparedElement): string | null {
  switch (element.kind) {
    case "injected":
      return INJECTED_KIND_NOUN[element.span.kind];
    case "command-invocation":
      // The merged command element (mt#3322) folds the wrapper, its captured
      // output, and the caveat into one — all three are the same origin.
      return INJECTED_KIND_NOUN.command;
    case "tool-invocation":
    case "tool-result-orphan":
      return TOOL_RESULT_NOUN;
    default:
      return null;
  }
}

/** True when the element is operator-authored prose rather than harness plumbing. */
function isOperatorProse(element: PreparedElement): boolean {
  return element.kind === "text" && element.text.trim().length > 0;
}

/**
 * The single harness label the turn's elements agree on: the one span label
 * when they all carry the same origin, the general term when they disagree, and
 * `null` when no element carries a harness origin at all.
 */
function harnessLabelOfTurn(elements: PreparedElement[]): string | null {
  const labels = new Set<string>();
  for (const element of elements) {
    const label = harnessLabelOf(element);
    if (label !== null) labels.add(label);
  }
  if (labels.size === 0) return null;
  if (labels.size > 1) return MIXED_HARNESS_LABEL;
  const [only] = [...labels];
  return only as string;
}

/**
 * Classify who authored `turn`.
 *
 * Returns `null` when the turn carries no origin signal at all — a non-`user`
 * role (assistant turns are never ambiguous), or a `user` turn whose elements
 * are neither prose nor recognizable harness content. `null` means "keep doing
 * what you were doing", never "assume operator": silently promoting an
 * unclassifiable turn to the operator's label is the exact failure this module
 * exists to remove.
 *
 * ## Precedence, in order (mt#3809)
 *
 * 1. **Line-level `isMeta`** — the harness's own assertion that IT produced this
 *    whole JSONL line. First-party and whole-line, so it outranks everything
 *    below; span classification is still consulted, but only to name the turn
 *    more precisely than the general term.
 * 2. **Operator prose** — text the operator actually typed.
 * 3. **Span classification** — what `splitInjectedContent` recognized.
 *
 * Prose beating span classification (2 over 3) is deliberate and load-bearing: a
 * mixed turn — an injected prefix plus the operator's own typed continuation —
 * IS the operator's message; the injected span still collapses on its own, so
 * nothing is hidden by labeling the turn theirs.
 *
 * `isMeta` beating prose (1 over 2) is what mt#3809 fixed. The prose-over-spans
 * rationale does not reach a line the harness wrote in full: there is no
 * operator continuation to protect, and its "text" is addressed to the model
 * rather than to a reader. The originating report was a pasted screenshot's
 * coordinate-mapping note, which the harness writes as its own `isMeta` line and
 * which therefore rendered under the operator's label. Ordering `isMeta` last
 * left that branch unreachable for any meta line carrying text — which is nearly
 * all of them (74 across the 12 most recent local conversations; 69 carry text).
 */
export function classifyTurnOrigin(turn: {
  role: string;
  elements: PreparedElement[];
  isMeta?: boolean;
}): TurnOrigin | null {
  if (turn.role !== "user") return null;

  const spanLabel = harnessLabelOfTurn(turn.elements);

  if (turn.isMeta === true) return { kind: "harness", label: spanLabel ?? MIXED_HARNESS_LABEL };

  if (turn.elements.some(isOperatorProse)) return { kind: "operator" };

  if (spanLabel !== null) return { kind: "harness", label: spanLabel };

  return null;
}
