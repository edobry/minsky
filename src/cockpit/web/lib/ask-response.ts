/**
 * Reading a terminal ask's recorded response in operator language (mt#4091).
 *
 * `AskResponse.payload` is `unknown` by design — the ask substrate lets each
 * closure path record whatever it needs, and seven distinct shapes are in the
 * store today. `AskPage` used to render all of them as `JSON.stringify`, so an
 * operator opening a resolved ask read `{"chosen": "hold"}` rather than the
 * option they picked ("Hold off on production storage").
 *
 * The shape distribution, counted 2026-08-13 over the 4,540 terminal asks that
 * carry a response, is what makes this a ladder rather than a single lookup —
 * the option-choice shape this page most obviously needs to render is ~2% of
 * the population:
 *
 *   {citation}                     policy                            1,317
 *   {prNumber, prUrl}              system:pr-merged                  1,194
 *   {parentTaskId, taskStatus}     system:backfill-parent-terminal     793
 *   {message}                      stale-sweep / operator / agents    ~575
 *   {commitHash}                   system:commit-landed                400
 *   {parentTaskId, sweep, task}    system:superseded / parent-terminal  129
 *   {chosen, option}               operator                            104
 *   {approved}                     operator                              4
 *
 * Pure and render-free so the classification is unit-testable on its own; the
 * component layer switches on the returned discriminant.
 */
import { stripOptionLetterPrefix } from "@minsky/shared/ask-option-label";
import { isAutomatedClosureResponder } from "@minsky/shared/ask-closure";
import type { AskItem, AskOption } from "../widgets/AskDetail";

/** A payload narrowed to a plain object, the only shape any rung reads. */
function asRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The option an operator picked, resolved from the recorded payload.
 *
 * Matches on `value` FIRST and `label` SECOND, because `composeResolvePayload`
 * writes whichever one the option actually had: its mt#3181 fallback stores the
 * LABEL when an option carries no `value` (asks created before `askOptionSchema`
 * started normalizing that are still in the store). A value-only lookup silently
 * misses every one of them — which is why `ask-response.test.ts` covers the two
 * cases separately.
 *
 * Compares after `stripOptionLetterPrefix` for the same reason `AskDetail` renders
 * through it: a producer-supplied "B — " prefix is presentation, not identity.
 */
export function resolveChosenOption(ask: AskItem): { index: number; option: AskOption } | null {
  const options = ask.options;
  if (!options || options.length === 0) return null;

  const record = asRecord(ask.response?.payload);
  if (!record) return null;

  const chosen = readString(record, "chosen") ?? readString(record, "option");
  if (chosen === null) return null;

  const byValue = options.findIndex(
    (opt) => opt.value !== undefined && String(opt.value) === chosen
  );
  if (byValue !== -1) return { index: byValue, option: options[byValue] as AskOption };

  const byLabel = options.findIndex(
    (opt) => stripOptionLetterPrefix(opt.label) === stripOptionLetterPrefix(chosen)
  );
  if (byLabel !== -1) return { index: byLabel, option: options[byLabel] as AskOption };

  return null;
}

/** One `key: value` line from a payload the ladder renders structurally. */
export interface AnswerDetail {
  key: string;
  value: string;
}

/**
 * What a terminal ask's recorded response actually says, classified into the
 * rungs the render layer knows how to phrase.
 */
export type RecordedAnswer =
  /** No response recorded at all — an expired or cancelled ask nobody answered. */
  | { kind: "none" }
  /** An operator picked one of the ask's own options. */
  | { kind: "option"; label: string; description?: string }
  /** An optionless `authorization.approve` — the payload is a bare boolean. */
  | { kind: "approval"; approved: boolean }
  /** Free-text disposition, the shape `asks respond --message` persists. */
  | { kind: "message"; message: string }
  /** The router matched a covering policy. Automated, but a real answer. */
  | { kind: "policy"; citation: string }
  /** Closed by a system signal with nobody answering (mt#3215). */
  | { kind: "systemClosure"; signal: string; detail: AnswerDetail[] }
  /** Unrecognized shape — the one rung where a JSON dump still survives. */
  | { kind: "raw"; json: string };

/**
 * Plain-words rendering of the event that closed an ask nobody answered.
 * Falls back to the raw responder string, which is already self-describing
 * (`system:<event>`), rather than inventing phrasing for an unknown signal.
 */
function describeClosureSignal(responder: string): string {
  switch (responder) {
    case "system:pr-merged":
      return "the pull request was merged";
    case "system:commit-landed":
      return "a commit landed for this session";
    case "system:parent-task-terminal":
    case "system:backfill-parent-terminal":
      return "the parent task reached a terminal status";
    case "system:superseded-by-later-commit":
      return "a later commit superseded the one this ask covered";
    case "timeout":
      return "the deadline passed with no response";
    default:
      return responder;
  }
}

function toDetail(record: Record<string, unknown>): AnswerDetail[] {
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/**
 * Classify a terminal ask's recorded response.
 *
 * Rung order is load-bearing. `systemClosure` is keyed on the RESPONDER and
 * checked FIRST, so no payload-keyed operator-answer rung can preempt an
 * automated closure. Everything below it is keyed on the PAYLOAD.
 *
 * One consequence is intended rather than incidental: a `stale-sweep-mt2747`
 * closure carrying `{message}` lands on `message` (rendered with its responder
 * attributed), not on `systemClosure`, because `isAutomatedClosureResponder`
 * matches `system:*` and `timeout` only. Widening the predicate here to catch
 * that sweep would diverge from the single source of truth mt#3215 established;
 * the responder-naming gap is real and tracked outside this task.
 */
export function describeRecordedAnswer(ask: AskItem): RecordedAnswer {
  const response = ask.response;
  if (!response) return { kind: "none" };

  const record = asRecord(response.payload);
  if (!record) {
    return { kind: "raw", json: JSON.stringify(response.payload, null, 2) };
  }

  // Checked FIRST (PR #2961 R1): an automated closure is never an operator's
  // option choice or approval, so no operator-answer rung below can preempt it
  // whatever its payload happens to contain. The review raised this as
  // `{approved}` firing regardless of `ask.kind`; gating on the KIND would have
  // been the wrong fix — `composeResolvePayload` writes `{approved}` for ANY
  // optionless ask, and `AskDetail` offers those buttons for `quality.review`
  // as well as `authorization.approve`, so a kind check would have started
  // rendering real `quality.review` approvals as an unrecognized payload.
  // Gating on the RESPONDER is what the concern actually calls for.
  if (isAutomatedClosureResponder(response.responder)) {
    return {
      kind: "systemClosure",
      signal: describeClosureSignal(response.responder),
      detail: toDetail(record),
    };
  }

  const chosen = resolveChosenOption(ask);
  if (chosen) {
    return {
      kind: "option",
      label: stripOptionLetterPrefix(chosen.option.label),
      ...(chosen.option.description ? { description: chosen.option.description } : {}),
    };
  }

  if (typeof record.approved === "boolean") {
    return { kind: "approval", approved: record.approved };
  }

  const message = readString(record, "message");
  if (message !== null) return { kind: "message", message };

  const citation = readString(record, "citation");
  if (citation !== null) return { kind: "policy", citation };

  return { kind: "raw", json: JSON.stringify(response.payload, null, 2) };
}
