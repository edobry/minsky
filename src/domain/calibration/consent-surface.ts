/**
 * The customer-facing surface of the guard-tuning loop (mt#3581, ADR-032).
 *
 * Pure: no fs, no DB, no clock. The store lives in
 * `.minsky/hooks/guard-tuning-store.ts` (hook-side, because guards read it);
 * this module decides WHAT to say and WHETHER a proposal may be applied.
 *
 * ## The one rule this module exists to enforce
 *
 * mem#802: preference expression is the customer's only owned job, and it must
 * be in the CUSTOMER's vocabulary — outcomes and annoyance — never Minsky's
 * (thresholds, FP rates, detector names). Everything below is in service of
 * that: a customer never sees `MINSKY_WALL_OF_TEXT_WORD_BUDGET`, never sees
 * `200`, never sees `wall-of-text`, and cannot express a number.
 *
 * The register is the principal's, chosen 2026-08-03: **observation + offer** —
 * the agent states what it noticed and offers to change it, in the first
 * person. Not a system notice, not an apply-and-tell.
 *
 * @see docs/architecture/adr-032-guard-threshold-tuning-loop.md §The customer-vocabulary preference surface
 * @see src/domain/calibration/threshold-tuning.ts — produces the proposals this gates
 */

import type { ThresholdProposal, TuningOwnership } from "./threshold-tuning";

// ---------------------------------------------------------------------------
// The vocabulary bridge
// ---------------------------------------------------------------------------

/**
 * What a threshold IS, in the customer's terms.
 *
 * This table is the entire translation layer between Minsky's vocabulary and
 * the customer's, and it is deliberately hand-written per threshold rather than
 * derived from the guard's name. Deriving it would reintroduce exactly what
 * mem#802 rules out: `silent-stretch` → "silent stretch" is still Minsky's word
 * for it. A customer experiences "you going quiet without saying anything," and
 * that phrasing has to be authored, not generated.
 */
export interface PreferenceSubject {
  /** The registered `MINSKY_*` env var this subject tunes. Never shown. */
  thresholdKey: string;
  /** How the agent names the behavior when it brings it up. Lowercase, no article. */
  noun: string;
  /** What the agent says it has been doing, for the observation clause. */
  observation: string;
  /** The button that loosens the guard (fewer interruptions). */
  loosenLabel: string;
  /** The button that leaves it alone. */
  keepLabel: string;
  /** Which direction on the underlying threshold means "bother me less". */
  loosenDirection: "raise" | "lower";
}

export const PREFERENCE_SUBJECTS: readonly PreferenceSubject[] = [
  {
    thresholdKey: "MINSKY_WALL_OF_TEXT_WORD_BUDGET",
    noun: "length reminders",
    observation: "flagging your updates as too long",
    loosenLabel: "Ease off",
    keepLabel: "Keep as is",
    loosenDirection: "raise",
  },
  {
    thresholdKey: "MINSKY_SILENT_STRETCH_GAP_MINUTES",
    noun: "quiet-stretch reminders",
    observation: "nudging you when I go quiet for a while",
    loosenLabel: "Ease off",
    keepLabel: "Keep as is",
    loosenDirection: "raise",
  },
  {
    thresholdKey: "MINSKY_SILENT_STRETCH_TOOL_CALLS",
    noun: "quiet-stretch reminders",
    observation: "nudging you when I work for a long stretch without checking in",
    loosenLabel: "Ease off",
    keepLabel: "Keep as is",
    loosenDirection: "raise",
  },
];

export function findSubject(thresholdKey: string): PreferenceSubject | undefined {
  return PREFERENCE_SUBJECTS.find((s) => s.thresholdKey === thresholdKey);
}

// ---------------------------------------------------------------------------
// The consent question
// ---------------------------------------------------------------------------

export interface ConsentQuestion {
  /** The question text. Contains no guard name, no threshold key, and no number. */
  prompt: string;
  /** Exactly two buttons, in order: loosen, keep. */
  options: [string, string];
}

/**
 * Render the consent question for one subject.
 *
 * The register is fixed by the principal's choice and is not a per-call
 * parameter: first person, observation then offer, no hedging beyond the
 * frequency word. Making it configurable would let the voice drift per call
 * site, which is the thing a locked register prevents.
 *
 * `frequency` is a WORD, never a count — "fairly often", "a lot". The
 * temptation to pass the real fire count through is exactly the leak this
 * surface exists to prevent, so the parameter's type makes it impossible.
 */
export function renderConsentQuestion(
  subject: PreferenceSubject,
  frequency: "fairly often" | "a lot" | "a few times" = "fairly often"
): ConsentQuestion {
  return {
    prompt: `I've been ${subject.observation} ${frequency} lately — want me to ease off?`,
    options: [subject.loosenLabel, subject.keepLabel],
  };
}

/**
 * Assert a rendered question leaks nothing from Minsky's vocabulary.
 *
 * Exported because it is the machine-checkable half of "no detector names, no
 * numbers" — the property is easy to state and easy to violate by editing a
 * string, so the check ships next to the renderer rather than living only in a
 * test. Returns the offending fragments; empty means clean.
 */
export function findVocabularyLeaks(
  question: ConsentQuestion,
  forbidden: { guardName?: string; thresholdKey: string }
): string[] {
  const haystack = `${question.prompt} ${question.options.join(" ")}`;
  const leaks: string[] = [];
  if (/\d/.test(haystack)) leaks.push("contains a digit");
  if (haystack.includes(forbidden.thresholdKey)) leaks.push(forbidden.thresholdKey);
  if (forbidden.guardName && haystack.includes(forbidden.guardName))
    leaks.push(forbidden.guardName);
  if (/MINSKY_[A-Z_]+/.test(haystack)) leaks.push("contains an env-var name");
  return leaks;
}

// ---------------------------------------------------------------------------
// Gating an application
// ---------------------------------------------------------------------------

export type ApplicationRefusal =
  | "invariant-class-never-tunable"
  | "no-consent-path-not-in-this-task"
  | "unknown-threshold-key"
  | "value-outside-bounds";

export type ApplicationDecision =
  | { kind: "apply"; value: number }
  | { kind: "refuse"; reason: ApplicationRefusal };

/**
 * Decide whether a proposal may be applied through the CONSENTED path.
 *
 * Re-checks the bounds rather than trusting the proposal, per this task's
 * Success Criterion 3. The decider already enforced them; a second check here
 * is not redundant, because the proposal crosses a module boundary and
 * `applyValue` is the last point before a value becomes a threshold a guard
 * actually reads.
 *
 * **Refuses `requiresConsent: false`.** That is the no-prompt advisory path,
 * and it is deliberately NOT in this task — it consumes labels whose accuracy
 * is unmeasured (mt#3615), so it waits for that measurement under mt#3633.
 * Refusing here rather than silently applying is what keeps the split honest:
 * if mt#3633 never ships, nothing quietly auto-applies in the meantime.
 */
export function decideApplication(
  proposal: ThresholdProposal,
  context: { tuningOwnership: TuningOwnership; shippedDefault: number; maxMultiple: number }
): ApplicationDecision {
  if (context.tuningOwnership === "invariant") {
    return { kind: "refuse", reason: "invariant-class-never-tunable" };
  }
  if (!proposal.requiresConsent) {
    return { kind: "refuse", reason: "no-consent-path-not-in-this-task" };
  }
  if (!findSubject(proposal.thresholdKey)) {
    return { kind: "refuse", reason: "unknown-threshold-key" };
  }

  const { proposedValue } = proposal;
  const ceiling = context.shippedDefault * context.maxMultiple;
  const floor = Math.max(1, Math.ceil(context.shippedDefault / context.maxMultiple));
  if (!Number.isInteger(proposedValue) || proposedValue < floor || proposedValue > ceiling) {
    return { kind: "refuse", reason: "value-outside-bounds" };
  }

  return { kind: "apply", value: proposedValue };
}

// ---------------------------------------------------------------------------
// Customer-expressed preference
// ---------------------------------------------------------------------------

export type NudgeDirection = "loosen" | "tighten";

export interface Nudge {
  thresholdKey: string;
  direction: NudgeDirection;
}

/**
 * Turn a customer's own words into a bounded nudge.
 *
 * Deliberately a small keyword map rather than anything cleverer. Two reasons:
 * a customer's phrasing here is short and intentional (they are answering a
 * prompt or issuing a direct instruction, not writing prose), and a wrong
 * reading is cheap to correct — the move is one bounded step and reversible.
 * Escalating to semantic matching would be the arms-race shape ADR-024 names,
 * paid for before there is any evidence the keyword map is insufficient.
 *
 * Returns null when nothing matches. Guessing which guard a customer meant is
 * worse than asking.
 */
export function interpretPreference(phrase: string): Nudge | null {
  const text = phrase.toLowerCase();

  const wantsLess =
    /\b(stop|quit|less|fewer|ease off|back off|enough|stop nagging|too much)\b/.test(text);
  const wantsMore = /\b(more|sooner|earlier|stricter|keep flagging|tighten)\b/.test(text);

  const aboutLength = /\b(long|length|verbose|wordy|updates?|reports?|summar)/.test(text);
  const aboutQuiet = /\b(quiet|silent|going dark|check in|checking in|heartbeat)/.test(text);

  if (!wantsLess && !wantsMore) return null;
  if (!aboutLength && !aboutQuiet) return null;

  const direction: NudgeDirection = wantsMore && !wantsLess ? "tighten" : "loosen";
  const thresholdKey = aboutLength
    ? "MINSKY_WALL_OF_TEXT_WORD_BUDGET"
    : "MINSKY_SILENT_STRETCH_GAP_MINUTES";

  return { thresholdKey, direction };
}

/**
 * One bounded step for a nudge, from whatever value is currently in force.
 *
 * A step is 25% of the SHIPPED default, floored at 1 — proportional to the
 * threshold's own scale so the same rule works for a 200-word budget and a
 * 10-minute gap, and derived from the shipped default rather than the current
 * value so repeated nudges move linearly instead of compounding. Clamped to the
 * same ceiling/floor the decider and the env path enforce.
 *
 * Returns null when the value is already at the bound — the caller says "that's
 * as far as I can go" rather than silently doing nothing.
 */
export function stepForNudge(
  nudge: Nudge,
  context: { currentValue: number; shippedDefault: number; maxMultiple: number }
): number | null {
  const subject = findSubject(nudge.thresholdKey);
  if (!subject) return null;

  const step = Math.max(1, Math.round(context.shippedDefault * 0.25));
  const looserIsUp = subject.loosenDirection === "raise";
  const goingUp = nudge.direction === "loosen" ? looserIsUp : !looserIsUp;

  const ceiling = context.shippedDefault * context.maxMultiple;
  const floor = Math.max(1, Math.ceil(context.shippedDefault / context.maxMultiple));

  const next = goingUp ? context.currentValue + step : context.currentValue - step;
  const clamped = Math.min(ceiling, Math.max(floor, next));
  return clamped === context.currentValue ? null : clamped;
}
