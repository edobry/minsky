/**
 * Action-burst folding for the conversation thread (mt#4250).
 *
 * A **burst** is a stretch of consecutive turns between two speech blocks that
 * contain only machinery — thinking, tool calls, shell commands — and no prose.
 * The thread renders one summary line in its place, expandable to the turns it
 * stands for.
 *
 * ## Why "burst" and not "run"
 *
 * `ConversationTurnView` already uses "run" for a different unit: `RunView`,
 * `runLabelOf`, `runAccentOf` and `sameActor` group consecutive turns by ACTOR
 * (mt#3845 SC1). That grouping is the container this one nests inside, so two
 * senses of "run" would sit in the same file one indent apart. This module owns
 * the ACTION sense and calls it a burst throughout. The principal's phrasing —
 * "runs of consecutive agent actions" — is the task's language, not the code's.
 *
 * ## Why the unit is a TURN, not an element
 *
 * Consecutive tool calls arrive as separate assistant turns, and
 * `pairToolInvocations` (`conversation-turn-assembly.ts`) drops the answering
 * user turn's `tool-result` once it has been merged into the call — so a stretch
 * of tool calls is already contiguous same-actor turns with nothing between
 * them. Folding whole turns therefore covers the real case while leaving
 * `TurnSegment` untouched, which is what keeps expansion lossless: every
 * per-turn affordance (the turn anchor, the addressed ring, outcome and retry
 * chips, the spawn badge, the film link) is still rendered by exactly the same
 * component once the burst is open. A finer element-level fold would have to
 * reproduce all of that.
 *
 * A turn holding BOTH prose and a tool call is not foldable — it has speech in
 * it, so it stays. That is deliberately conservative: it makes bursts shorter,
 * never wrong.
 *
 * ## The selection rule is PORTED, and its evidence is in the spec
 *
 * Which action classes fold was derived from four Claude Code terminal
 * specimens supplied by the principal (mt#4250 `## Selection rule — DERIVED
 * FROM SPECIMENS`), NOT invented here and NOT guessed from information content
 * — the spec's original "high-information actions keep their row" hypothesis was
 * falsified by those specimens, which fold MCP calls wholesale. Read that
 * section before changing {@link STANDALONE_TOOLS}.
 */
import { SYNTHETIC_MODEL_SENTINEL } from "@minsky/domain/ai/dispatch-models";
import { classifyTool } from "@minsky/shared/tool-effect";

import { classifyOutcome } from "./conversation-outcome";
import { formatDurationShort } from "./format-duration";
import { parseToolName } from "./tool-name";
import type { PreparedElement } from "../components/ConversationElementRenderers";
import type { PreparedTurn } from "./conversation-turn-assembly";

/**
 * How many consecutive foldable turns it takes before folding is worth it.
 *
 * Below this a fold costs more than it saves: it replaces N rows with one row
 * plus the reader's decision about whether to open it, so at N=2 the reader
 * pays a choice to save a line. The reference terminal folds even a lone
 * thinking block, and we deliberately do not — there the fold line is the ONLY
 * rendering thinking gets, whereas here a single thinking turn already renders
 * as its own `ThinkingBlock` and folding it would hide content behind a control
 * that says less than the content did.
 */
export const MIN_BURST_TURNS = 3;

/**
 * Tools that keep their own row instead of folding into a summary.
 *
 * Observed set, from the specimens: `WebSearch`, `WebFetch` and `Skill` each
 * rendered as their own row with a result line while everything around them
 * folded. `Task`/`Agent` are added here on a different basis — a spawn is
 * structure the reader orients by, which the spec names as never-folding
 * independently of the reference — and `turnIsFoldable` also refuses any turn
 * carrying `isSpawnBoundary`, so the two mechanisms agree.
 *
 * Matched against the tool's BARE name (`parseToolName().name`), so an MCP tool
 * is never accidentally caught by a native tool's name.
 */
export const STANDALONE_TOOLS: ReadonlySet<string> = new Set([
  "WebSearch",
  "WebFetch",
  "Skill",
  "Task",
  "Agent",
]);

/**
 * The model value Claude Code records on a harness-generated retry turn rather
 * than a real model response (mt#3260).
 *
 * mt#4237 unified this: the literal is declared ONCE, in
 * `@minsky/domain/ai/dispatch-models`, and imported at the top of this file.
 * That module is a legal import from the web bundle — it is on
 * `eslint.config.js`'s cockpit allowlist and has zero imports of its own — so
 * the "importing it here would be a structural decision made in passing"
 * concern this comment used to carry no longer applies: the decision was made
 * deliberately, on that task, and the reasoning lives at the declaration site.
 */

/** A rendered thread node: either one turn, or a burst standing for several. */
export type BurstNode =
  | { kind: "turn"; turn: PreparedTurn }
  | { kind: "burst"; turns: PreparedTurn[] };

/** Does this element render anything at all? Empty text renders nothing. */
function elementRenders(element: PreparedElement): boolean {
  if (element.kind === "text") return element.text.trim().length > 0;
  return true;
}

/**
 * May this element be hidden behind a fold?
 *
 * Anything that is speech, content, or a failure is not foldable. The rest is
 * machinery.
 */
function elementIsFoldable(element: PreparedElement): boolean {
  switch (element.kind) {
    case "thinking":
      return true;
    case "tool-invocation": {
      // A failure never hides inside a calm-looking line — this is what makes a
      // burst SPLIT around an error rather than swallow it.
      if (element.result?.isError === true) return false;
      if (element.result?.isInterruptionRejection === true) return false;
      return !STANDALONE_TOOLS.has(parseToolName(element.call.name).name);
    }
    case "tool-result-orphan":
      return element.result.isError !== true && element.result.isInterruptionRejection !== true;
    // Speech, harness-injected spans, slash commands and images are all things
    // the reader came to read.
    case "text":
    case "injected":
    case "command-invocation":
    case "image":
      return false;
    // An element shape this renderer does not understand is never hidden:
    // hiding what we cannot describe is how a summary becomes a lie.
    case "unknown":
      return false;
    default:
      return false;
  }
}

/**
 * May this whole turn be hidden behind a fold?
 *
 * Turn-grain refusals come first — a spawn badge, a retry chip, a compaction
 * boundary and an outcome chip are all rendered by `TurnSegment` from turn
 * fields rather than from elements, so an element-only test would fold them
 * away invisibly.
 */
export function turnIsFoldable(turn: PreparedTurn): boolean {
  if (turn.role !== "assistant") return false;
  if (turn.isSpawnBoundary) return false;
  if (turn.isCompactSummary === true) return false;
  if (turn.model === SYNTHETIC_MODEL_SENTINEL) return false;

  const rendered = turn.elements.filter(elementRenders);
  // A turn that renders nothing is not a burst member — it contributes no row,
  // so counting it toward MIN_BURST_TURNS would let a fold claim to be hiding
  // more than it is.
  if (rendered.length === 0) return false;

  // An outcome chip means this turn ended in something the reader must see.
  const outcome = classifyOutcome({
    source: "transcript",
    interrupted: turn.elements.some(
      (el) =>
        (el.kind === "tool-invocation" && el.result?.isInterruptionRejection === true) ||
        (el.kind === "tool-result-orphan" && el.result.isInterruptionRejection === true)
    ),
    texts: turn.elements.flatMap((el) => (el.kind === "text" ? [el.text] : [])),
  });
  if (outcome !== null) return false;

  return rendered.every(elementIsFoldable);
}

/**
 * Group a run's turns into standalone turns and foldable bursts.
 *
 * Pure and order-preserving: concatenating the output's turns in order yields
 * exactly the input. That property is what the losslessness criterion rests on,
 * and it is asserted directly in the tests.
 */
export function groupActionBursts(turns: PreparedTurn[]): BurstNode[] {
  const nodes: BurstNode[] = [];
  let pending: PreparedTurn[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length >= MIN_BURST_TURNS) {
      nodes.push({ kind: "burst", turns: pending });
    } else {
      for (const turn of pending) nodes.push({ kind: "turn", turn });
    }
    pending = [];
  };

  for (const turn of turns) {
    if (turnIsFoldable(turn)) {
      pending.push(turn);
      continue;
    }
    flush();
    nodes.push({ kind: "turn", turn });
  }
  flush();

  return nodes;
}

/** One verb-family tally, in the order the summary renders them. */
interface Tally {
  thought: boolean;
  reads: number;
  searches: number;
  shell: number;
  /**
   * MCP calls, keyed by server, split by effect (mt#3847's `classifyTool`).
   *
   * Split rather than one name list because the two halves have different
   * summary rights: a MUTATION must always be named, and a read may be reduced
   * to a count. An `unclassified` tool rides with the mutations — the
   * classifier's own contract is that unknown is never coerced into a positive
   * verdict, so treating it as a read would be exactly that coercion.
   */
  mcp: Map<string, { reads: number; named: string[]; mutatingCount: number }>;
  /** Native tools with no verb phrase of their own, keyed by name. */
  other: Map<string, number>;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

function tallyBurst(turns: PreparedTurn[]): Tally {
  const tally: Tally = {
    thought: false,
    reads: 0,
    searches: 0,
    shell: 0,
    mcp: new Map(),
    other: new Map(),
  };

  for (const turn of turns) {
    for (const element of turn.elements) {
      if (element.kind === "thinking") {
        tally.thought = true;
        continue;
      }
      if (element.kind !== "tool-invocation") continue;

      const { server, name } = parseToolName(element.call.name);
      if (server !== null) {
        const entry = tally.mcp.get(server) ?? { reads: 0, named: [], mutatingCount: 0 };
        // Classify by the RAW name: `classifyTool` handles the `mcp__` prefix
        // and the underscore/dot spellings itself, so stripping first would
        // hand it a form its own canonicaliser is written to accept anyway.
        const effect = classifyTool(element.call.name);
        if (effect === "reads") {
          entry.reads += 1;
        } else {
          if (effect === "mutates") entry.mutatingCount += 1;
          if (!entry.named.includes(name)) entry.named.push(name);
        }
        tally.mcp.set(server, entry);
        continue;
      }

      switch (name) {
        case "Read":
        case "NotebookRead":
          tally.reads += 1;
          break;
        case "Grep":
        case "Glob":
          tally.searches += 1;
          break;
        case "Bash":
        case "BashOutput":
          tally.shell += 1;
          break;
        default:
          tally.other.set(name, (tally.other.get(name) ?? 0) + 1);
          break;
      }
    }
  }

  return tally;
}

/**
 * The burst's own elapsed wall-clock, or `null` when it is not worth showing.
 *
 * **This is NOT the reference's "Thought for 47s"** and must not be presented as
 * it. Claude Code reports THINKING time; our element model carries no thinking
 * duration at all (`{ kind: "thinking"; thinking: string }` — prose only), so
 * that figure is not derivable here. What IS derivable exactly is the span from
 * the burst's first turn to its last, which is what this returns and what the
 * summary labels. Recorded as a deviation in the mt#4250 spec.
 */
export function burstElapsedMs(turns: PreparedTurn[]): number | null {
  const first = turns[0];
  const last = turns[turns.length - 1];
  if (first === undefined || last === undefined) return null;
  const start = new Date(first.timestamp).getTime();
  const end = new Date(last.timestamp).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = end - start;
  // Sub-second spans round to "0s", which reads as broken rather than fast.
  return ms >= 1000 ? ms : null;
}

/**
 * The one line a folded burst renders.
 *
 * Written as prose with counts rather than a label list, matching the
 * reference's register. Every figure is computed from elements already in hand
 * — per ADR-025 the transcript's system of record is object storage, so a
 * payload is not guaranteed resident and a summary must never be the reason one
 * has to be fetched (mt#3845 SC4).
 *
 * **Named tools, not a bare server count** — this is the deliberate deviation
 * from the reference. Claude Code renders `called minsky`, and mt#3845 SC6 names
 * exactly that as the anti-pattern: *"it discards which tool ran, and
 * `tasks_spec_patch mt#3842` is precisely the thing a supervisor needs."* The
 * reference optimises for someone watching their own agent live; this surface is
 * read by someone auditing a run afterwards, often not the person who launched
 * it.
 *
 * Which names render is decided by mt#3847's `classifyTool`, not by parsing:
 * a `mutates` or `unclassified` tool is NAMED, always and uncapped; a `reads`
 * tool becomes a count. `unclassified` rides with the named half because that
 * classifier's contract is that unknown is never coerced into a positive
 * verdict, and calling it a read would be that coercion. mt#4238 consumes the
 * same table for row weighting — this reads it, it does not re-derive it.
 */
export function summarizeBurst(turns: PreparedTurn[]): string {
  const tally = tallyBurst(turns);
  const parts: string[] = [];

  if (tally.thought) parts.push("thought");
  if (tally.reads > 0) parts.push(`read ${plural(tally.reads, "file", "files")}`);
  if (tally.searches > 0) parts.push(`searched ${plural(tally.searches, "time", "times")}`);
  if (tally.shell > 0) parts.push(`ran ${plural(tally.shell, "shell command", "shell commands")}`);

  for (const [server, entry] of tally.mcp) {
    // EVERY name in `entry.named` renders — no cap. The earlier draft capped
    // this list at three and the reviewer of PR #3125 caught the consequence:
    // with four or more distinct tools, a mutation could fall past the cap
    // while reads survived, which inverts the very thing SC6 asks for. A read
    // may become a number; a mutation may not.
    const segments: string[] = [];
    if (entry.named.length > 0) segments.push(entry.named.join(", "));
    if (entry.reads > 0) segments.push(plural(entry.reads, "read", "reads"));
    parts.push(
      segments.length > 0 ? `called ${server} ${segments.join(", ")}` : `called ${server}`
    );
  }

  for (const [name, count] of tally.other) {
    parts.push(count === 1 ? `used ${name}` : `used ${name} ${count}×`);
  }

  // A burst is never empty (MIN_BURST_TURNS foldable turns, each rendering at
  // least one element), but a shape this tally does not recognise would produce
  // no parts — say how many turns are hidden rather than rendering a bare
  // duration with nothing attached to it.
  if (parts.length === 0) {
    parts.push(`${plural(turns.length, "step", "steps")}`);
  }

  const elapsed = burstElapsedMs(turns);
  const body = parts.join(", ");
  return elapsed === null ? body : `${formatDurationShort(elapsed)} · ${body}`;
}
