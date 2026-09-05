#!/usr/bin/env bun
// Stop-event guard: catch a turn that ENDS by naming an immediately-executable
// next action without executing it (mt#3179).
//
// Why the FINAL message is the whole signal: at Stop time the turn is over, so
// anything appearing in `last_assistant_message` had NO tool call after it by
// construction. Position IS the discriminator — no heuristic needed to decide
// whether the announced action was taken. Announce-then-do is invisible here
// (the announcement sits mid-turn, followed by calls); announce-then-stop puts
// the announcement in the final message. That asymmetry is the guard.
//
// Why this is NOT covered by ask-routing-deferral-detector: that detector's
// corpus is DEFERRAL-shaped ("say the word", "let me know"). The mt#3179 R3
// incident ended with COMMITMENT-shaped text — "I'm taking it forward … that's
// the next step, not a question" — which reads as the opposite of a deferral
// and actively suppresses suspicion by asserting the action is happening. A
// sentiment-keyed corpus cannot catch it; a position-keyed check can.
//
// Key on the SURFACE, not the reason (mt#3179 §R3): R2 stopped by asking
// permission, R3 stopped by announcing intent, one turn after R2's
// retrospective. Reasons are unbounded; the observable surface — turn ends,
// action named, no call made — is one thing.
//
// Advisory-only, never `deny`: the Stop-hook continuation gives the agent one
// beat to actually perform the action, which is the entire remedy. Dedup bounds
// a false positive to exactly one extra beat.
//
// @see .minsky/hooks/turn-end-retro-scan.ts — sibling Stop guard; same shape
// @see .minsky/hooks/dispatch-stop.ts — the Stop dispatcher entrypoint
// @see mt#3179 — originating task; mem#394 — the family record (R1/R2/R3)

import type { DispatchContext, GuardOutcome } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";
import {
  STOP_INJECTED_OVERLAP_FAMILY,
  flagKey,
  overlapTurnKey,
  readFlagged,
  writeFlagged,
} from "./turn-end-scan-store";
import { createHash } from "node:crypto";
import { cappedEvidenceLines } from "./guard-feedback-format";
import { elideQuotedAndCodeContexts } from "./elision";
import { detectDeferralPhrases } from "./ask-routing-deferral-detector";
import { logEvaluationRecord } from "./dispatcher";
import {
  extractFinalTurn,
  extractToolUseNames,
  findToolCallsWithResults,
  findToolUseInputs,
} from "./transcript";

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_UNTAKEN_ACTION";

/**
 * Skip switch for the EVALUATION stream only (mt#4117), distinct from
 * {@link OVERRIDE_ENV_VAR} above. `MINSKY_ACK_UNTAKEN_ACTION` acks the guard
 * entirely — it short-circuits before any scanning happens, so fire behavior
 * is gone too. This one does the opposite: it silences ONLY the per-scan
 * evaluation write, and the detector's fire/suppression/calibration behavior
 * is untouched, per this task's AT5. Registered as its own hook-only env var
 * alongside `OVERRIDE_ENV_VAR`, per the sibling detectors' pattern — see the
 * `HOOK_ONLY_ENV_VAR_CATEGORIES` record in the domain configuration sources
 * and `.minsky/hooks/known-override-env-vars.ts`.
 */
export const EVALUATION_SKIP_ENV_VAR = "MINSKY_SKIP_UNTAKEN_ACTION_EVALUATION";

/**
 * Logical stream name for `logEvaluationRecord` (mt#4117) — matches this
 * guard's `calibrationLog: "untaken-action"` registration
 * (`registry-turn-end-guards.ts`), the same name/path split every other
 * `logEvaluationRecord` writer uses. Resolves to
 * `<state-dir>/projects/<key>/untaken-action-evaluations.jsonl`, sitting
 * beside `untaken-action-calibration.jsonl` — a NEW stream, not a
 * replacement: the calibration log's shape and population (fires only) are
 * unchanged by this addition.
 */
const EVALUATION_LOG_NAME = "untaken-action";

/**
 * Append one evaluation record for this guard's scan. Exported under this
 * exact name so `evaluation-stream-rooting.test.ts` can pin the same
 * state-dir/project-key rooting the other `logEvaluationRecord` writers get,
 * per that test's per-detector enumeration.
 */
export function appendEvaluationRecord(cwd: string, record: Record<string, unknown>): void {
  logEvaluationRecord(EVALUATION_LOG_NAME, record, { fallbackCwd: cwd });
}

function isEvaluationSkipped(): boolean {
  const value = process.env[EVALUATION_SKIP_ENV_VAR];
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

/**
 * RETIRED as an active suppression reason (mt#3620). This guard no longer
 * yields to the prompt-time ask-routing-deferral detector — see the inversion
 * rationale at the overlap block in {@link run}.
 *
 * The string is kept exported because it appears in ~18 pre-mt#3620 calibration
 * records that the review cadence still reads; deleting it would make those
 * records unclassifiable. No code path emits it any more.
 */
export const SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL = "deduped-by-ask-routing-deferral";

/**
 * How much of the final message's tail to scan. The failure shape is a
 * sign-off — the announcement is the last thing said, not something buried
 * mid-message. A tail window keeps a mid-message "I'll do X" (which the turn
 * then went on to DO) from matching.
 */
export const TAIL_WINDOW_CHARS = 600;

/**
 * Commitment-shaped announcements of an immediately-executable next action.
 * Derived from real incidents (mt#3179 R2/R3), not invented:
 *   R2: "say the word and I'll merge"        (deferral-shaped stop)
 *   R3: "I'm taking it forward … that's the next step, not a question"
 */
/**
 * Action verbs an announcement can attach to. Shared by the `I'll …` and
 * `I'm going to …` families so a verb added here is covered in both forms —
 * mt#3853's miss was partly that they could drift apart.
 */
const ACTION_VERB = String.raw`merge|implement|plan|file|fix|ship|land|write|open|build|patch|send|create|add|draft|wire|run|PR`;

/**
 * What the announced action is performed ON. Anaphora (`it`/`that`/`this`) and
 * task ids were the original set; mt#3853 adds NAMED artifacts, because a
 * commitment to a named thing ("I'm going to write and PR option 1") is the
 * most concrete kind and was the one that escaped.
 *
 * Deliberately NOT `.+` — an object-less verb ("I'm going to think about how
 * this works") is not an announcement of an immediately-executable action, and
 * matching it would fire on ordinary reasoning prose.
 */
const ACTION_OBJECT = String.raw`it|that|this|mt#\d+|the\s+\w+|a\s+PR|option\s+\d+|both|these|them`;

/**
 * Present-participle forms of {@link ACTION_VERB} (mt#4835).
 *
 * Spelled out rather than generated by appending `ing`, because English
 * participle inflection is not a suffix append: `file` → `filing` drops the
 * `e`, `ship` → `shipping` doubles the consonant, `run` → `running`. A
 * generated `(?:${ACTION_VERB})ing` would match `fileing` and `runing` and miss
 * every real form. Kept immediately beside `ACTION_VERB` so the two are edited
 * together — the drift risk mt#3853 named for `I'll` vs `I'm going to`.
 *
 * `PR` is deliberately absent: nobody writes `PRing`.
 */
const ACTION_PARTICIPLE = String.raw`merging|implementing|planning|filing|fixing|shipping|landing|writing|opening|building|patching|sending|creating|adding|drafting|wiring|running|dispatching|kicking\s+off|starting`;

const COMMITMENT_PATTERNS: ReadonlyArray<{ family: string; re: RegExp }> = [
  {
    family: "taking-forward",
    re: /\bi'?m\s+(?:taking|carrying)\s+(?:it|this|that|mt#\d+)\s+forward\b/i,
  },
  { family: "next-step", re: /\bthat'?s\s+the\s+next\s+step\b/i },
  { family: "next-up", re: /\bnext\s+(?:up|step)\s*(?:is|:|—|-)/i },
  { family: "proceed-to", re: /\bi'?ll\s+(?:proceed|move|go)\s+(?:to|on\s+to|ahead\s+with)\b/i },
  {
    family: "ill-start",
    re: /\bi'?ll\s+(?:start|begin|kick\s+off|pick\s+up|take)\s+(?:on\s+)?(?:it|that|this|mt#\d+)\b/i,
  },
  {
    family: "ill-action",
    re: new RegExp(
      String.raw`\bi'?ll\s+(?:${ACTION_VERB})\b[\w\s,]*?\b(?:${ACTION_OBJECT})\b`,
      "i"
    ),
  },
  // mt#3853: `I'm going to X` was matched by NOTHING. It is at least as common
  // a commitment form as `I'll X`, and the missed turn used it. `gonna` and the
  // uncontracted `I am going to` are the same speech act.
  {
    family: "going-to",
    re: new RegExp(
      String.raw`\bi'?(?:m|\s+am)\s+(?:going\s+to|gonna)\s+(?:${ACTION_VERB})\b[\w\s,]*?\b(?:${ACTION_OBJECT})\b`,
      "i"
    ),
  },
  { family: "moving-on", re: /\bmoving\s+on\s+to\b/i },
  { family: "say-the-word", re: /\bsay\s+the\s+word\b/i },
  { family: "give-go-ahead", re: /\b(?:give|say)\s+(?:me\s+)?the\s+go-?ahead\b/i },
];

/**
 * Signals that the turn ended for a LEGITIMATE reason — the agent did take an
 * action and is genuinely waiting on it, or the principal deferred the work.
 * Narrow by design: over-suppressing re-opens the exact gap this guard closes.
 *
 * Verified against real fixtures: the mt#3155 turn that armed a retry watcher
 * ("A retry watcher is armed … I'll re-attempt when it fires") must NOT fire;
 * the R2 and R3 failing turns carried none of these markers.
 */
const SUPPRESSION_PATTERNS: ReadonlyArray<RegExp> = [
  // mt#3948: the armed-watcher suppression, in BOTH word orders and over the full noun set.
  //
  // The two patterns these replace were each bound to one phrasing —
  // `/\bwatcher\s+is\s+armed\b/` required the copula AND the noun `watcher`, and
  // `/\barmed\s+(?:a\s+)?(?:background\s+)?(?:watcher|poll|retry|wakeup)\b/` required `armed` to
  // PRECEDE the noun and allowed exactly one modifier. Four attested closing messages from the
  // 2026-08-10 and 2026-08-11 review windows put the participle AFTER the noun, or inserted a
  // different modifier, or named the wait `wait` rather than `watcher`, and all four fired on
  // behavior `work-completion.mdc §External self-resolving waits` explicitly PRESCRIBES:
  //
  //   "I have a background wait armed on it — I'll merge and write the handoff when it fires."
  //   "I have a blocking watcher armed on the checks — I'll merge the moment they go green."
  //   "watcher armed, I'll merge when it's green."
  //   "A background wait is armed; I'll merge when the timer fires."
  //
  // What is deliberately NOT bought with this: the suppression still keys on EVIDENCE THE WAIT
  // EXISTS, never on naming a blocker. "I'll merge when the review lands" names no wait and
  // keeps firing — the same line PR #2784 R1 drew when it rejected a broader `blocked only on
  // ci` pattern. Both patterns require the literal `armed` adjacent to a wait noun; neither can
  // match a message that merely mentions CI, a review, or a check.
  //
  // ADR-024 placement: this is a Rung-1 deterministic fix, the ladder's default, and the rung
  // its Consequences name as plausibly sufficient for the precision axis at ~zero cost. If a
  // THIRD distinct armed-watcher phrasing is filed against this set, that is the measured
  // insufficiency of Rung 1 for this family and the next pass raises the rung rather than the
  // pattern count."
  //
  // ## The armed-watcher patterns are GONE (mt#4063, PR #2972 R2)
  //
  // Three patterns lived here — participle-before-noun, participle-after-noun, and
  // `running in the background`. All three are retired, not merely supplemented.
  //
  // Adding `detectArmedWatcherEvidence` beside them was the first attempt and it was
  // wrong: with the prose patterns still present, a message SAYING "a retry watcher is
  // armed" was suppressed whether or not anything had been armed. That is the exact
  // behavior mt#4063's SC2 rules out — "keys on evidence that a watcher exists, NOT on
  // the prose claiming one, so 'I'll watch for it' with nothing armed still fires" —
  // and it is what "raises the rung RATHER THAN the pattern count" was already saying:
  // a replacement, not an addition. Caught by PR #2972 R2.
  //
  // The cost of removing them is real and bounded: a turn that armed a wait through a
  // tool NOT in `ARMED_WAIT_TOOLS` used to be covered by the prose and now fires. That
  // surfaces in the calibration log as this guard firing on a correctly-armed turn —
  // the same signal that produced this change — and the fix is to add the tool, which
  // the membership pin makes a deliberate edit.
  //
  // The patterns below are NOT armed-watcher shapes and stay prose-keyed on purpose:
  // each names a DIFFERENT legitimate halt (a delegated report, an open wait, an
  // explicit instruction) whose evidence is not a tool call. The instruction shape in
  // particular is mt#4113's subject.
  /\bi'?ll\s+report\s+(?:back\s+)?when\b/i,
  /\bwaiting\s+(?:for|on)\s+/i,
  /\bno\s+action\s+needed\s+from\s+you\b/i,
  // mt#4113: `/\byou\s+asked\s+me\s+(?:to\s+stop|not\s+to)\b/i` is RETIRED from here, not merely
  // supplemented. It was the narrow, prose-only ancestor of the principal-instruction suppression,
  // and prose-only is exactly what mt#4063's SC2 rules out — a message could earn suppression by
  // quoting the phrase with no instruction behind it. `detectPrincipalInstructionHalt` replaces it
  // and corroborates against the opening prompt. Leaving both would re-create the
  // add-beside-rather-than-replace error PR #2972 R2 caught.
  // mt#3917: the watcher reports to the AGENT, not the agent to the principal.
  // The line above covers "I'll report back when …"; the 2026-08-09T04:18Z fire
  // was "Blocked only on CI now — I'll merge when the checks task reports back",
  // where the subject is the watcher. `work-completion.mdc §External
  // self-resolving waits` prescribes exactly that shape, so firing on it tells
  // the agent to override the rule it was following.
  //
  // Scoped to the DELEGATED-REPORT clause only. A first draft also carried
  // `blocked only on ci|checks|the build`, and PR #2784 R1 was right to reject
  // it: naming CI as the blocker says nothing about whether a watcher was ever
  // armed, so it silenced the exact turn this guard exists to catch — an agent
  // that announces a blocker and then stops. `work-completion.mdc` asks for the
  // watcher, not for the excuse, so the suppression has to key on evidence the
  // watcher exists. `when <subject> reports back` names one; "blocked on CI"
  // names none. The real 2026-08-09T04:18Z fire carries the report-back clause,
  // so nothing is lost by dropping the broader phrase.
  //
  // PR #2784 R3: the subject must be a MECHANISM, not a person. `when you
  // report back` is operator-delegation — the agent handing the principal the
  // wait — which is the failure `work-completion.mdc` names outright ("Ping me
  // when GitHub's back" is its stated anti-pattern). Suppressing it inverted
  // the rule this entry exists to serve, so second-person and
  // principal-referent subjects are excluded and still fire.
  // The exclusion sits immediately after `when`, and swallows the optional
  // `the` ITSELF, because placing it after `(?:the\s+)?` leaves a backtracking
  // hole: the engine retries with `the` unconsumed, the lookahead then inspects
  // "the operator" instead of "operator", and the person-check passes. Caught by
  // this entry's own test rather than by reading — worth keeping in mind for any
  // later edit here.
  /\bwhen\s+(?!(?:the\s+)?(?:you|your|i|we|operator|principal|user|eugene)\b)(?:the\s+)?[\w-]+(?:\s+[\w-]+)?\s+reports?\s+back\b/i,
];

/**
 * Suppression reason for a halt that NAMES a principal-reserved category (mt#3768).
 */
export const SUPPRESSION_RESERVED_CATEGORY_HALT = "reserved-category-halt";

/**
 * Categories the principal reserves, as named in closing prose.
 *
 * A turn that halts because the next step belongs to the principal is behaving
 * exactly as `principal-context.mdc §Decisions Eugene reserves` requires. Firing
 * on it tells the agent to override a halt the corpus mandates — training against
 * the corpus rather than with it, which is worse than staying silent.
 *
 * ## The discriminator is a NAMED category, not an offered choice
 *
 * `/plan-task` Step 4 makes this a positive citation test: a halt is legitimate
 * when it can NAME which reserved category applies, and a rationale that names
 * none is low confidence, missing information, or a decision that is simply the
 * agent's. So these patterns match category VOCABULARY, never the bare
 * "your call" / "up to you" / option-set shapes.
 *
 * That exclusion is load-bearing in both directions. "Your call" with no category
 * behind it is the signature of the confabulated halt (mem#823, mem#367 R5) — the
 * precise case this guard SHOULD keep catching. And an option set alone is not
 * evidence of a legitimate halt: mt#3801 recorded a true positive
 * ("Next step is `/plan-task mt#3799` unless you'd rather I go straight at it")
 * that an option-set discriminator would have silenced.
 *
 * ## Tuned against the three real instances in the log, not invented examples
 *
 * All 130 records of `.minsky/untaken-action-calibration.jsonl` were scanned; three
 * fires name a reserved category, and each is a false positive this suppresses:
 *
 *  - 2026-07-30 — "its deliverable is a user-facing *label* … Naming is yours, not
 *    mine." (naming)
 *  - 2026-07-31 — "blocked on you picking the user-facing name … or something from
 *    the locked brand vocabulary" (naming)
 *  - 2026-08-04 — "it's your product surface and the call to make it the phone
 *    default is the contestable part" (product surface)
 *
 * Three in 130 is rare, and rarity is not the argument: the cost of this false
 * positive is that the agent is told to override a correct halt, so it is a
 * correctness property rather than noise reduction. Do not re-justify it on
 * frequency — mt#3768's `## Planning Audit` records that it suppresses none of the
 * 12 most recent fires.
 */
const RESERVED_CATEGORY_PATTERNS: ReadonlyArray<RegExp> = [
  // Explicit citation of the rule itself.
  /\bprincipal[-\s]reserved\b/i,
  /\breserved\s+(?:category|decision)\b/i,
  // Naming — a customer-facing term, not an internal identifier the agent owns.
  /\bnaming\s+is\s+(?:yours|your\s+call|the\s+principal'?s)\b/i,
  /\b(?:user-facing|customer-facing)\s+(?:name|label|term|copy)\b/i,
  /\bbrand\s+vocabulary\b/i,
  /\bproduct\s+nam(?:e|ing)\b/i,
  // Architectural moves affecting customer experience or product surface.
  /\b(?:your|the)\s+product\s+surface\b/i,
  /\bcustomer\s+experience\b/i,
  // Authorization for shared / production state changes. Scoped to "state" so an
  // ordinary "shared source contract" or "shared module" does not qualify.
  /\b(?:production|shared)[-\s]state\s+(?:change|write|mutation)\b/i,
  // Scope changes to in-flight work.
  /\bscope\s+change\s+to\s+in-?flight\b/i,
  // Vendor commitments.
  /\bvendor\s+commitment\b/i,
  // Framework choices at principal-level stakes.
  /\bframework\s+choice\b/i,
];

/**
 * A preference is reserved ONLY once it establishes a durable default (ask#7587).
 *
 * The six categories above are the list `principal-context.mdc` carried, and a
 * preference is on none of them — so the 2026-08-09T00:09Z fire ("which model
 * becomes your default is your preference, not a capability gap") named no
 * category and was flagged. `humility.mdc` says the opposite for preference-bound
 * decisions, and the operator settled the conflict: **reserve a preference when it
 * becomes a durable default; decide a one-off inline.**
 *
 * That answer is a DISCRIMINATOR, not a phrase. Matching "your preference" alone
 * would suppress exactly the one-off case the operator kept with the agent, which
 * inverts the decision — so both halves are required: the message must frame the
 * choice as the principal's taste AND mark it as durable. "Which font do you want
 * for this one diagram?" carries the first and not the second, and still fires.
 */
const DURABLE_MARKER_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:becomes?|be|is)\s+(?:your|the)\s+default\b/i,
  /\byour\s+default\b/i,
  /\bstanding\s+(?:preference|default|choice)\b/i,
  /\b(?:from\s+now\s+on|going\s+forward)\b/i,
  /\bdefault\s+(?:for\s+)?(?:every|all)\b/i,
];

const PREFERENCE_MARKER_PATTERNS: ReadonlyArray<RegExp> = [
  /\byour\s+(?:preference|taste)\b/i,
  /\bpreference[-\s]bound\b/i,
  /\bnot\s+a\s+capability\s+gap\b/i,
  /\byours\s+to\s+set\b/i,
];

/** First matching phrase from `list`, or undefined. */
function firstMatch(list: ReadonlyArray<RegExp>, text: string): string | undefined {
  for (const re of list) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * Returns the reserved-category phrases the message names, in match order.
 *
 * Runs over the SAME elided text the commitment scan uses, so a category named
 * inside a quotation or code fence cannot suppress a real fire — this rule text
 * quoting "naming is yours" must not silence the guard for the turn that quotes it.
 * Unlike the commitment scan it reads the WHOLE message rather than the tail: the
 * halt basis is routinely stated where the reasoning is, several paragraphs above
 * the closing sentence that trips the commitment pattern.
 */
export function detectReservedCategoryHalt(finalMessage: string): string[] {
  if (!finalMessage) return [];
  const scanned = elideQuotedAndCodeContexts(finalMessage);
  const named: string[] = [];
  for (const re of RESERVED_CATEGORY_PATTERNS) {
    const m = re.exec(scanned);
    if (m) named.push(m[0]);
  }
  // A durable-default preference is reserved per ask#7587 — but only when BOTH
  // halves are present, so a one-off preference call still fires.
  const durable = firstMatch(DURABLE_MARKER_PATTERNS, scanned);
  const preference = firstMatch(PREFERENCE_MARKER_PATTERNS, scanned);
  if (durable !== undefined && preference !== undefined) {
    named.push(`${preference} / ${durable}`);
  }
  return named;
}

export const SUPPRESSION_ARMED_WATCHER_EVIDENCE = "armed-watcher-evidence";

/**
 * The armed-watcher predicate now lives in `./armed-watcher`, shared with
 * `stop-at-decision-scan.ts` (mt#4327). Re-exported here so every existing
 * consumer of this guard -- including the test that pins ARMED_WAIT_TOOLS to
 * an exact set -- keeps its import site unchanged.
 *
 * One import, one export (PR #3402 R1). `run()` below calls the predicate, so
 * the name has to be bound locally; re-exporting that same binding avoids
 * naming the module twice, which the first revision did.
 */
import {
  ARMED_WAIT_TOOLS,
  CONDITIONAL_WAIT_TOOL,
  detectArmedWatcherEvidence,
} from "./armed-watcher";

export { ARMED_WAIT_TOOLS, CONDITIONAL_WAIT_TOOL, detectArmedWatcherEvidence };
/**
 * Suppression reason for a halt whose named-but-untaken step is DESTRUCTIVE (mt#4116).
 */
export const SUPPRESSION_DESTRUCTIVE_ACTION_HALT = "destructive-action-halt";

/**
 * Suppression reason for a step the agent structurally CANNOT take (mt#4116).
 */
export const SUPPRESSION_HARNESS_COMMAND_HALT = "harness-command-halt";

/**
 * Suppression reason for the filed-for-later-by-design branch, corroborated (mt#4116).
 */
export const SUPPRESSION_FILED_BY_DESIGN_HALT = "filed-by-design-halt";

/**
 * Suppression reason for a scope bounded by the principal's own instruction (mt#4113).
 */
export const SUPPRESSION_PRINCIPAL_INSTRUCTION_HALT = "principal-instruction-halt";

/**
 * Destructive verbs, matched inside the NAMED ACTION rather than in a self-assessment.
 *
 * `user-preferences.mdc §Probe before deferring` names the stopping point as "an action that is
 * **destructive**, OR that falls under a nameable category" — destructive is a PEER of the
 * reserved-category list, not a member, which is why `RESERVED_CATEGORY_PATTERNS` never covered it
 * and why the 2026-08-13 pass measured it as a false positive ("Say the word and I'll SIGKILL
 * both").
 *
 * ## The verb is the evidence; "this is destructive" is not
 *
 * This deliberately does NOT match a self-assessment. Under mt#4063's bar a suppression must key on
 * evidence the condition holds rather than prose claiming it does, and "stopping because this is
 * destructive" is exactly the manufacturable claim. A destructive VERB is different in kind: to
 * earn suppression the message has to actually name the dangerous act, which a message inventing an
 * excuse has no reason to do.
 */
const DESTRUCTIVE_ACTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bSIGKILL\b/,
  /\bkill\s+(?:-9\s+)?(?:both|all|the\s+\w+|PID)/i,
  /\b(?:pkill|killall)\b/,
  /\brm\s+-rf\b/,
  /\bforce[-\s]push(?:ing)?\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bdrop\s+(?:the\s+)?(?:table|database|schema)\b/i,
];

/**
 * Harness commands the agent structurally cannot invoke (mt#4116).
 *
 * A closed list, deliberately. The GENERAL "the principal has to participate" case — "I need you to
 * reproduce the hang while I sample" — is NOT lexically separable from an excuse, and a pattern that
 * tried would silence real deferrals; mt#4116's planning scoped that out with the reason recorded.
 * These three are decidable because the agent has no way to issue them at all, so naming one as the
 * blocking step is a statement about the world rather than about the agent's willingness.
 */
const HARNESS_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\s)\/mcp\b/,
  /(?:^|\s)\/clear\b/,
  /(?:^|\s)\/config\b/,
];

/**
 * Match families that COMMIT to a concrete action, as opposed to offering one (mt#4139).
 *
 * The split is the whole mechanism, so it is worth stating precisely. `say-the-word` and
 * `give-go-ahead` hand the principal a choice and name no action of their own. Every family
 * below names a verb the agent said IT would perform.
 */
const COMMITMENT_FAMILIES: ReadonlySet<string> = new Set([
  "ill-action",
  "ill-start",
  "going-to",
  "proceed-to",
  "taking-forward",
  "moving-on",
  "next-step",
  "next-up",
]);

/**
 * The actions this message commits to BESIDES the harness command (mt#4139).
 *
 * ## Why the harness-command suppression needs this
 *
 * A harness-command halt rests on two claims, not one: *I cannot run `/mcp`* (true, decidable,
 * and all {@link detectHarnessCommandHalt} checks) and *therefore I cannot do the thing I was
 * doing* (unchecked, and frequently false). mt#4116 suppressed on the first and thereby made the
 * second unfalsifiable — the guard stopped at the token.
 *
 * The discriminator is already in the guard's own match data. When the harness command is the
 * TERMINAL named action ("I can't run `/clear` for you — say the word"), the two claims collapse
 * into one and the suppression is sound. When the message ALSO commits to a distinct action gated
 * behind it ("run `/mcp` to reconnect, then I'll merge the PR"), the second claim is load-bearing
 * and unexamined — and that is exactly `user-preferences.mdc §Probe before deferring`: an operator
 * step named as the precondition for something the agent could have done itself. In the
 * originating fixture the merge was reachable the whole time (`minsky session pr merge`).
 *
 * This keeps the fix at ADR-024's Rung 1: the proposition was repairable with a literal check, so
 * no move up the ladder is warranted (see mt#4139's Planning Audit for the ADR mapping).
 *
 * ## Consistency argument
 *
 * The guard ALREADY fires on this shape when the precondition is not a harness command —
 * "I need you to reproduce the hang, then I'll merge the fix" is a shipped mt#4116 test expecting
 * a fire. Gating on a committed action makes the harness case agree with its own sibling rather
 * than carving out an exception for three tokens.
 *
 * Cost, stated plainly: a turn whose named step GENUINELY required the harness command now gets an
 * advisory it did not get before. This guard is advisory, so that costs a nudge the agent can
 * answer in one line; the inverse — a swallowed probe-before-deferring failure — is silent and
 * costs the principal a round-trip.
 */
export function namesActionBeyondHarnessCommand(
  matches: ReadonlyArray<{ family: string; matchedPhrase: string }>
): string[] {
  return matches.filter((m) => COMMITMENT_FAMILIES.has(m.family)).map((m) => m.matchedPhrase);
}

/**
 * Prose naming the filed-for-later-by-design branch (mt#4116).
 *
 * Corroboration is required — see {@link detectFiledByDesignHalt}. On its own this is prose and
 * therefore manufacturable, which is precisely the confabulated-halt shape the sibling
 * `turn-end-unwalked-task` guard exists to catch. This must never become a way to talk past it.
 */
const FILED_BY_DESIGN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bfiled\s+for\s+later\s+by\s+design\b/i,
  /\bbackground\/?tracking\s+task\b/i,
  /\btracking\s+task\s+filed\s+for\s+later\b/i,
];

/**
 * Prose citing a principal instruction as the reason a step was not taken (mt#4113).
 *
 * Corroborated against the OPENING PROMPT — see {@link detectPrincipalInstructionHalt}.
 */
const PRINCIPAL_INSTRUCTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\byou\s+(?:said|asked\s+(?:me\s+)?(?:to|for))\b/i,
  /\bper\s+your\s+instruction\b/i,
  /\bas\s+you\s+(?:asked|instructed|requested)\b/i,
];

/**
 * Every suppression that keys on the closing message runs over the ELIDED text (PR #2976 R1).
 *
 * `detectUntakenAction` and `detectReservedCategoryHalt` already did this; the mt#4116 additions
 * did not, and the asymmetry is worse in the suppression direction than in the firing direction. A
 * fire manufactured by quoted text costs one advisory beat; a SUPPRESSION manufactured by quoted
 * text silences a real fire, and silence is the outcome nothing downstream notices.
 *
 * The failure was live, not hypothetical: a turn-end report that QUOTES a rule mentioning `SIGKILL`
 * or names `/mcp` in a code span is an ordinary shape in this repo — several were written in the
 * very session that added these suppressions — and each would have earned itself a suppression.
 */
function elideForSuppression(finalMessage: string): string {
  return finalMessage ? elideQuotedAndCodeContexts(finalMessage) : "";
}

/** Destructive verbs named in the closing message. Empty when none. */
export function detectDestructiveNamedAction(finalMessage: string): string[] {
  const scanned = elideForSuppression(finalMessage);
  const hits: string[] = [];
  for (const re of DESTRUCTIVE_ACTION_PATTERNS) {
    const m = re.exec(scanned);
    if (m) hits.push(m[0].trim());
  }
  return hits;
}

/** Harness commands named as the blocking step. Empty when none. */
export function detectHarnessCommandHalt(finalMessage: string): string[] {
  const scanned = elideForSuppression(finalMessage);
  const hits: string[] = [];
  for (const re of HARNESS_COMMAND_PATTERNS) {
    const m = re.exec(scanned);
    if (m) hits.push(m[0].trim());
  }
  return hits;
}

/**
 * The filed-for-later-by-design branch, CORROBORATED by the turn having actually minted a task.
 *
 * Both halves are required. The prose alone is manufacturable; the `tasks_create` call alone is the
 * ordinary case of filing a task mid-turn and then continuing, which says nothing about why the
 * turn ended. Their conjunction is the branch `/create-task` §6 defines and requires the agent to
 * state out loud — and which the 2026-08-13 pass measured firing on an agent that did exactly that.
 */
export function detectFiledByDesignHalt(
  finalMessage: string,
  turnLines: Parameters<typeof findToolUseInputs>[0]
): string[] {
  const named = FILED_BY_DESIGN_PATTERNS.some((re) => re.test(elideForSuppression(finalMessage)));
  if (!named) return [];
  const created = extractToolUseNames(turnLines).filter((n) => /tasks_create$/.test(n));
  return created.length > 0 ? created : [];
}

/**
 * A scope the PRINCIPAL's own instruction bounded (mt#4113).
 *
 * Keyed on the OPENING PROMPT, not on the agent's prose, and that is the whole design. mt#4113's
 * SC3 requires that "a message that merely ASSERTS an instruction without one having been given
 * still fires" — no pattern over the agent's closing text can satisfy that, because a real citation
 * and an invented one are the same words. The prompt that opened the turn is the falsifier, and
 * `extractFinalTurn` already returns it.
 *
 * The bar is deliberately coarse: the citation must be present in the closing message AND the
 * opening prompt must contain a scope-bounding directive. It does not attempt to verify that the
 * quoted instruction MATCHES the prompt's — that is a semantic comparison this rung cannot make, and
 * claiming it would overstate what the check does.
 */
/**
 * Text of the USER line that opened the turn.
 *
 * Deliberately NOT `extractAssistantText`, which filters to `role === "assistant"` and therefore
 * returns `""` for a prompt — reaching for it here would have made
 * {@link detectPrincipalInstructionHalt} permanently inert while typechecking and reading fine.
 * Caught before shipping by checking the extractor rather than assuming its name matched the use;
 * it is the mt#1071 / mt#2416 dead-wiring shape (`feedback_static_helper_completeness`).
 */
export function extractPromptText(line: { message?: { content?: unknown } } | undefined): string {
  const content = line?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
    }
  }
  return parts.join("\n");
}

export function detectPrincipalInstructionHalt(
  finalMessage: string,
  openingPromptText: string
): string[] {
  if (!openingPromptText) return [];
  // The CITATION is elided (it is the agent's own prose, and a quoted "you said file" must not
  // manufacture a suppression). The PROMPT deliberately is NOT: it is the principal speaking, and
  // an instruction they wrote inside a code span or a quote is still an instruction they gave.
  const cited = PRINCIPAL_INSTRUCTION_PATTERNS.some((re) =>
    re.test(elideForSuppression(finalMessage))
  );
  if (!cited) return [];
  const directive =
    /\b(?:just|only)\s+\w+/i.test(openingPromptText) ||
    /\bdon'?t\s+\w+/i.test(openingPromptText) ||
    /\bfile\s+(?:it|them)\b/i.test(openingPromptText) ||
    /\bstop\b/i.test(openingPromptText);
  return directive ? ["opening-prompt-directive"] : [];
}

export interface UntakenActionMatch {
  family: string;
  matchedPhrase: string;
}

/**
 * Longest quoted phrase an evidence line may carry (mt#3853).
 *
 * The evidence lines exist so the agent can recognize WHICH text tripped the
 * guard; 26 chars is enough to do that for every pattern here (the longest
 * pattern prefix is `I'm going to ` at 13), and the tail is elided rather than
 * dropped. Chosen by MEASUREMENT, not preference: 32 still rendered 451 against
 * the 450 ceiling on the worst-case canary; 26 renders 443.
 *
 * Why a cap at all: matched-phrase length is a function of the PATTERN SET, so
 * without one, every future verb or object added to `ACTION_VERB` /
 * `ACTION_OBJECT` silently grows the rendered worst case. mt#3853's own
 * widening pushed it from 430 to 457 against a 450 ceiling — measured on a
 * canary posed so the long families occupy all three capped slots. Bounding the
 * phrase makes the ceiling a property of the FORMAT rather than of the corpus,
 * so widening the patterns can no longer breach it.
 */
export const MAX_QUOTED_PHRASE_CHARS = 26;

/**
 * Scope note (PR #2724 R1): this cap applies to the ADVISORY text only. The
 * calibration record keeps the FULL matched phrase, deliberately.
 *
 * The two have different readers and different budgets. `additionalContext` is
 * charged against the merged injection budget and rendered into the principal's
 * scroll, so its size is the thing being bounded. The calibration JSONL is a
 * file that only `/calibration-review` reads, where a truncated phrase would
 * make false-positive classification harder for no saving. Truncating there
 * would degrade the measurement this guard's tuning depends on.
 */

function quotePhrase(phrase: string): string {
  return phrase.length <= MAX_QUOTED_PHRASE_CHARS
    ? phrase
    : `${phrase.slice(0, MAX_QUOTED_PHRASE_CHARS - 1).trimEnd()}…`;
}

/**
 * Pure detector — exported for tests. Returns matches found in the TAIL of the
 * final assistant message, unless a suppression signal is present anywhere in
 * that message.
 *
 * Matching runs over quoted-context-ELIDED text (mt#3336): code fences,
 * inline code, blockquotes, and double-quoted prose are blanked first, so a
 * commitment phrase the agent is QUOTING — detector data in a handoff's
 * blockquote (the mt#3303 self-demonstrating false positive), a rule excerpt,
 * a calibration record — cannot fire. Same posture, same rationale, as the
 * ask-routing-deferral sibling's mt#3271 fix; elision blanks with same-length
 * whitespace so tail-window offsets are unaffected.
 */
export function detectUntakenAction(finalMessage: string): UntakenActionMatch[] {
  if (!finalMessage) return [];

  const scanned = elideQuotedAndCodeContexts(finalMessage);

  for (const s of SUPPRESSION_PATTERNS) {
    if (s.test(scanned)) return [];
  }

  const tail =
    scanned.length > TAIL_WINDOW_CHARS
      ? scanned.slice(scanned.length - TAIL_WINDOW_CHARS)
      : scanned;

  // mt#3948: where `tail` starts inside `scanned`, so a match index in the tail can be mapped
  // back to the whole message. `isAttributedStep` deliberately reads a 40-char window and needs
  // no mapping; the handoff check below reads ALL preceding text and does.
  const tailOffset = scanned.length - tail.length;

  const matches: UntakenActionMatch[] = [];
  for (const { family, re } of COMMITMENT_PATTERNS) {
    const m = re.exec(tail);
    if (!m) continue;
    if (ATTRIBUTABLE_FAMILIES.has(family) && isAttributedStep(tail, m.index)) continue;
    // mt#3948: same per-family seam, different reason — inside a handoff/resume block, naming
    // the next step is the block's deliverable rather than a deferral.
    //
    // Checked against `scanned`, not `tail`: a handoff block opens with its heading and runs for
    // many lines, so in a real handoff message the heading is routinely ABOVE the 600-char tail
    // window while the next-step sentence sits inside it. Passing `tail` here would have made
    // the suppression work only on handoffs short enough to fit the window — which the attested
    // fixture happens to be, so the tests would have passed and the real case would not.
    if (
      HANDOFF_SUPPRESSED_FAMILIES.has(family) &&
      isInHandoffBlock(scanned, tailOffset + m.index)
    ) {
      continue;
    }
    matches.push({ family, matchedPhrase: m[0] });
  }
  return matches;
}

/**
 * Family for the present-progressive assertion arm (mt#4835). LOG-ONLY — see
 * {@link LOG_ONLY_FAMILIES}.
 */
export const PRESENT_PROGRESSIVE_FAMILY = "present-progressive-assertion";

/**
 * A first-person present-progressive assertion that an action is ALREADY
 * UNDERWAY — "Running the dry-run gate now", "Filing that", "Dispatching the
 * reviewer".
 *
 * Why this is a distinct family rather than another `COMMITMENT_PATTERNS` entry:
 * `I'll X` is a FUTURE commitment, and at Stop time position alone settles it —
 * the turn is over, so the promise is definitionally unkept. `Xing Y` asserts
 * the action is in flight, which is a HIGHER truth claim and one a reader is
 * LESS likely to re-check, because it does not read as a pending item.
 *
 * Group 1 is the phrase; group 2 is the clause remainder, which
 * {@link GERUND_SUBJECT_CONTINUATION} inspects.
 */
const PRESENT_PROGRESSIVE_RE = new RegExp(
  String.raw`(?:^|[.!?;—\n]\s*)((?:${ACTION_PARTICIPLE})\s+(?:${ACTION_OBJECT}))([^.!?\n]{0,60})`,
  "im"
);

/**
 * The discriminator, and the whole reason this arm ships log-only (mt#4835).
 *
 * A participial phrase can be the SUBJECT of a following finite verb — "Planning
 * it now **would** duplicate that work", "Running it **is** dogfooding the
 * principle" — in which case it asserts nothing about work in flight, and is
 * very often the agent explaining why it is deliberately NOT acting. Firing
 * there would tell the agent to do the thing it had just correctly declined,
 * which is the failure class already filed as mt#4634 and mt#4438.
 *
 * Measured on the 438 real turn-ending tails in
 * `.minsky/untaken-action-calibration.jsonl`: of 11 participle-shaped
 * occurrences, **9 were gerund subjects**. The tightest candidate WITHOUT this
 * check (participle + object + `now`) fired twice and was wrong both times.
 * The two constructions are identical at the match site and differ only in the
 * syntactic role of the phrase, so this lookahead is a heuristic over an open
 * axis, not a decision procedure — hence log-only until the evaluation stream
 * mt#4117 armed can measure it.
 *
 * Known cost: a genuine assertion trailed by one of these verbs ("Filing it
 * now, will report back") is suppressed. Acceptable while log-only.
 *
 * ## Contractions (PR #3537 R1, finding 3) — the negated half only
 *
 * `\b` does not close after the stem in `isn't` (the next char is a word char),
 * so `Planning it now isn't worth the churn` escaped and fired. Verified, then
 * fixed by the optional `n't` group: the participle IS the subject of `isn't`,
 * so that is a genuine gerund subject and a genuine false positive.
 *
 * **The `'s` half of that finding is deliberately NOT taken, and the counter-
 * example is this arm's own primary fixture.** In `Running the dry-run gate now
 * — it's the falsifier that decides A vs B`, the subject of `it's` is `it`, not
 * the participial phrase; the clause is an independent comment FOLLOWING a true
 * assertion. Adding `['’]s` here would suppress the exact incident tail this arm
 * exists to catch (AT1), and would also swallow ordinary possessives. `it's`
 * after the phrase is not a gerund-subject marker.
 */
const GERUND_SUBJECT_CONTINUATION =
  /\b(?:is|are|was|were|would|will|could|should|do|does|did|has|have|had|means?|makes?|risks?|costs?|gives?|produces?|turns?|turned|reproduc\w+|duplicat\w+|forks?|becomes?|remains?|seems?|feels?|looks?|beats?|helps?|requires?)(?:n['’]t)?\b/i;

/**
 * Pure detector for the present-progressive arm — exported for tests.
 *
 * Mirrors {@link detectUntakenAction}'s pipeline exactly: elide quoted and code
 * contexts first, honour {@link SUPPRESSION_PATTERNS}, then match the tail.
 */
export function detectPresentProgressiveAssertion(finalMessage: string): UntakenActionMatch[] {
  if (!finalMessage) return [];

  const scanned = elideQuotedAndCodeContexts(finalMessage);

  for (const s of SUPPRESSION_PATTERNS) {
    if (s.test(scanned)) return [];
  }

  const tail =
    scanned.length > TAIL_WINDOW_CHARS
      ? scanned.slice(scanned.length - TAIL_WINDOW_CHARS)
      : scanned;

  const m = PRESENT_PROGRESSIVE_RE.exec(tail);
  if (!m) return [];
  if (GERUND_SUBJECT_CONTINUATION.test(m[2] ?? "")) return [];

  return [{ family: PRESENT_PROGRESSIVE_FAMILY, matchedPhrase: (m[1] ?? "").trim() }];
}

/**
 * Families whose match can legitimately belong to a DOCUMENT rather than the
 * speaker (PR #2784 R2).
 *
 * `next step is` / `that's the next step` are impersonal: a runbook has a next
 * step, so naming one is as often description as commitment. Every other family
 * is first-person by construction — `I'll …`, `I'm going to …`, `moving on to`,
 * `say the word`. Nothing preceding those changes who is committing: "per the
 * plan, I'll implement the fix" is still the agent saying it will implement the
 * fix.
 *
 * The first draft applied the attribution filter to ALL families, which would
 * have silenced exactly that sentence. The bundled test did not catch it — its
 * attribution sat outside the 40-char lookback of the `ill-action` match, so the
 * check never ran on the case it was supposed to protect. A test can agree with
 * a bug when it accidentally avoids the condition.
 */
const ATTRIBUTABLE_FAMILIES: ReadonlySet<string> = new Set(["next-up", "next-step"]);

/**
 * Words that attribute a next step to a DOCUMENT or PROCEDURE rather than to the
 * speaker (mt#3917).
 *
 * The `next-up` family matches `next step is`, which is a commitment when the
 * agent says it and a description when a document does. The 2026-08-10T10:09Z
 * fire was "…every rung reported 'absent' while the service was actively 422ing,
 * and the documented next step is bypass merge" — narrating what a runbook
 * prescribes while diagnosing, committing to nothing.
 *
 * Checked against the text immediately BEFORE the match rather than the whole
 * message, and per-match rather than as a `SUPPRESSION_PATTERNS` entry: a global
 * suppression would silence a real commitment that happens to share a message
 * with a quoted procedure, which is the over-suppression this guard's own
 * doc comment warns against.
 *
 * This is one instance of a matcher weakness three detectors share — mt#3864
 * (`pre-narration` fires on historical and quoted statements) and mt#3865
 * (`operator-deferral` fires on rule text describing the detector itself). If a
 * fourth appears, the shared "asserted vs described" primitive is worth lifting
 * out rather than patched a fourth time.
 */
const ATTRIBUTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:documented|prescribed|recommended|official|canonical)\s*$/i,
  /\b(?:the\s+)?(?:docs?|runbook|skill|rule|procedure|playbook)\s+says?\s*$/i,
  /\baccording\s+to\s+[\w\s.'-]{0,30}$/i,
  /\bper\s+(?:the\s+)?[\w\s.'-]{0,30}$/i,
];

/**
 * Attribution to a PERSON is not attribution to a document (PR #2784 R3).
 *
 * `according to <X>` and `per <X>` were matching any object, so "According to
 * you, the next step is the migration" read as a runbook citation. It is the
 * opposite: a next step the PRINCIPAL named is still one the agent owes an
 * action or an ask on, and suppressing it hides a true positive. Only an
 * impersonal source moves the step off the speaker.
 */
const PERSONAL_ATTRIBUTION_PATTERN =
  /\b(?:you|your|yours|i|me|my|we|us|our|operator|principal|user|eugene)\b/i;

/** Chars of preceding context an attribution marker may occupy. */
const ATTRIBUTION_LOOKBACK_CHARS = 40;

/**
 * Does the text right before `index` attribute the step to something other than
 * the speaker?
 */
export function isAttributedStep(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - ATTRIBUTION_LOOKBACK_CHARS), index);
  if (PERSONAL_ATTRIBUTION_PATTERN.test(before)) return false;
  return ATTRIBUTION_PATTERNS.some((re) => re.test(before));
}

/**
 * A HANDOFF or RESUME block heading (mt#3948, absorbing CLOSED mt#3998).
 *
 * Inside a handoff, naming the next step IS the deliverable — the block exists to tell the next
 * agent where to start. The 2026-08-11 window fired on exactly that:
 *
 *   "### Resume — New session … two PRs, a retrospective, a 13-hour data operation, and the
 *    next step is a clean self-contained scope."
 *
 * Matched against a markdown HEADING rather than a bare mention of the word, because "handoff"
 * appears constantly in ordinary prose about handoffs — a bare-word match would suppress a real
 * commitment in any turn that discussed one. A heading is a structural claim about what the
 * following text IS.
 *
 * Per-family and per-match, for the same reason `isAttributedStep` is: a global
 * `SUPPRESSION_PATTERNS` entry would silence a genuine `ill-action` commitment that happens to
 * share a message with a handoff block, and a handoff-carrying turn is exactly the kind of long
 * closing message where a real commitment is most likely to also appear.
 */
const HANDOFF_BLOCK_HEADING = /^\s{0,3}#{1,6}\s*(?:\*\*)?\s*(?:resume|handoff)\b/im;

/**
 * Families the handoff suppression applies to — `next-up` ONLY (PR #2904 R1).
 *
 * Deliberately NOT `ATTRIBUTABLE_FAMILIES`, which also carries `next-step`
 * (`that's the next step`). The first version reused that set and so silently widened the
 * suppression past the evidence: every attested handoff fire is the `next step is` phrasing,
 * which is `next-up`. `next-step` inside a handoff is plausibly the same speech act, but
 * plausibly is not a fixture — and this guard's own doc comment warns that over-suppressing
 * re-opens the gap it exists to close. If a `next-step` handoff fire is ever filed, that is the
 * datum that widens this set.
 */
const HANDOFF_SUPPRESSED_FAMILIES: ReadonlySet<string> = new Set(["next-up"]);

/**
 * Does a handoff/resume block open before `index`?
 *
 * Scans ALL preceding text, not a fixed window: the heading opens the block and the next-step
 * sentence can sit many lines below it, which is why this cannot reuse
 * `ATTRIBUTION_LOOKBACK_CHARS`.
 */
export function isInHandoffBlock(text: string, index: number): boolean {
  // The slice below is not a display truncation: the prefix is fed straight to `.test()`, and
  // `index` is a regex match index, which is always a code-unit boundary. Even if it did strand
  // a lone surrogate at the prefix's tail, that cannot change whether a `^`-anchored heading
  // matched EARLIER in the prefix — the only question asked here.
  // eslint-disable-next-line custom/no-unsafe-string-truncation -- see the note above
  return HANDOFF_BLOCK_HEADING.test(text.slice(0, index));
}

/**
 * The directive for an ordinary commitment fire — the agent said it would do a
 * thing and then did not.
 */
const COMMITMENT_DIRECTIVE =
  "Take it now in this continuation, then report the result. If it genuinely cannot " +
  "proceed — you are blocked on a principal decision, a red check, or an external " +
  "condition you have already armed a watcher for — name which in one line and end.";

/**
 * The directive for a fire whose phrase ALSO matches the deferral corpus (mt#3767).
 *
 * mt#3620 made this guard win the overlap and silenced the prompt-time sibling,
 * because Stop is the earlier event and only an earlier warning can prevent the
 * round-trip. But the remedy for an OFFER lives in the sibling that was silenced:
 * a menu handed back to the principal is not an omission to correct by acting, it
 * is a sentence to retract. Emitting the commitment directive here tells the agent
 * to perform an action whose correct disposition is often to un-name it — and an
 * instruction that does not fit is what teaches a reader to dismiss a true
 * positive, which is exactly what happened in this task's originating occurrence.
 *
 * So the handoff now carries the TEXT as well as the speaking rights. mem#831
 * stated the rule for the speaking half — "a dedup between guards on DIFFERENT
 * events is not a dedup, it is a handoff, and it must hand off toward the EARLIER
 * event"; this is the other half of it.
 *
 * Kept to one classify-then-act sentence set rather than restating
 * `/classify-before-deferring` — the skill owns the taxonomy, this names the branch
 * the agent is most likely to have missed (that it already decided).
 *
 * ## Ceiling
 *
 * This branch is the guard's WORST CASE and the registry's `worstCaseCanary` is
 * posed at it. Measured with the evidence list at its cap of 3 plus the
 * "…and N more" line: 430 chars against a 450 ceiling. Any addition here has to
 * be paid for by a trim elsewhere, NOT by raising
 * `attentionCost.denialMessageSizeChars` — `dispatcher.ts` derives the whole
 * turn's merged-injection budget from the sum of those annotations, so raising
 * one taxes every turn in the repo (mem#865, learned on the mt#3699 sibling).
 */
const DEFERRAL_DIRECTIVE =
  "You OFFERED this rather than doing it. If you already decided against it, the " +
  "naming was the defect — drop the offer and state the decision. If a lookup or " +
  "standing default settles it, act. Ask only for a principal-reserved category.";

function buildReminder(matches: UntakenActionMatch[], deferralShaped: boolean): string {
  const lines: string[] = [
    // Trimmed by mt#3767 from "…and ended the turn without taking it." The guard
    // is Stop-keyed, so "ended the turn" was already implied by when it fires;
    // the 17 chars buy headroom the SATURATED case needs. Do not re-expand — see
    // the ceiling note on `DEFERRAL_DIRECTIVE`.
    "[turn-end-untaken-action] You named a next action and did not take it.",
    "",
  ];
  lines.push(
    ...cappedEvidenceLines(matches, (m) => `  - ${m.family}: "${quotePhrase(m.matchedPhrase)}"`)
  );
  lines.push("", deferralShaped ? DEFERRAL_DIRECTIVE : COMMITMENT_DIRECTIVE);
  return lines.join("\n");
}

/**
 * Dedup key for one turn, derived from the FINAL MESSAGE rather than from the
 * transcript's opening prompt (PR #2293 R1).
 *
 * The sibling retro-scan guard keys on the transcript's opening-prompt uuid via
 * `turnKeyFor`, which returns the literal `"session-start"` when no transcript
 * is available. For THIS guard that default is actively harmful: every turn in
 * the session would share one key, so the first fire of a given (family,
 * phrase) would suppress that phrase for the REST OF THE SESSION — silencing
 * exactly the repeat offenses the guard exists to catch. (`needsTranscript`
 * does not save us: the Stop payload is not guaranteed to carry a usable
 * transcript.)
 *
 * Keying on the final message is both safer and more faithful to this guard's
 * signal, which IS that message: the same turn re-entering Stop (the advisory
 * continuation) presents the same text and correctly dedups, while a different
 * turn presents different text and correctly fires.
 *
 * Residual, accepted: two DIFFERENT turns ending with byte-identical text
 * dedup to one warning. That is the right call — identical sign-off, identical
 * advice — and is bounded to a single suppressed beat rather than a session.
 */
function sha1Short(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/**
 * Exported as a test seam (PR #2994 R1), alongside `storeDir` below: seeding a PARTIALLY-flagged
 * dedup state is the only way to pin that a suppression DECISION does not read the dedup filter.
 */
export function turnKeyForMessage(finalMessage: string): string {
  return sha1Short(finalMessage);
}

/** The match family the tool-call-state arm reports under (mt#4697). */
export const STRANDED_TASK_FAMILY = "stranded-task-state";

/**
 * Families that reach the CALIBRATION RECORD but never `additionalContext`
 * (mt#4697 for the first member, mt#4835 for the second).
 *
 * Both arms are on ADR-024's calibration-first rung for the same reason and by
 * the same evidence standard: a replay/corpus measurement said an injecting
 * version would be wrong often enough to fail the ADR's `0 known-FP` sign-off
 * bar. Recording without injecting is what makes the fires classifiable, which
 * is the only thing that can later justify a flip.
 *
 * A family is added here by a DELIBERATE edit, so promoting an arm to injecting
 * is a one-line removal that shows up in review rather than an emergent effect.
 */
export const LOG_ONLY_FAMILIES: ReadonlySet<string> = new Set([
  STRANDED_TASK_FAMILY,
  PRESENT_PROGRESSIVE_FAMILY,
]);

/**
 * Project matches into the calibration record, DECLARING which of them could
 * never have injected (mt#4970).
 *
 * The sweep's `injectedFiresSinceLastReview` excludes what the operator never
 * saw, and it derived that from `suppressionReasons` alone. A log-only family
 * is the other way a fire fails to reach the operator, and it leaves no
 * suppression reason — nothing suppressed it; it was never eligible. So the
 * sweep counted 120 injected fires in a window where 23 reached the agent.
 *
 * The fact is declared HERE, by the writer, rather than inferred there. A
 * per-detector family table in the sweep is the drift hazard mt#4465 recorded
 * for `judgedText`: two places would have to agree about
 * {@link LOG_ONLY_FAMILIES} forever, and only one of them is edited when an arm
 * flips. Marking the match means promoting an arm to injecting stays the
 * one-line removal from that set which this module already documents.
 *
 * `logOnly` is written ONLY when true — never `false`. Absent means "this
 * writer does not declare the fact", which the sweep must treat as the status
 * quo (counted as injected), exactly as `deferralOverlap`'s docblock in
 * `calibration-sweep.ts` requires for the same reason: a projection that
 * defaulted the field would manufacture a measurement for every record written
 * before this change.
 */
function toCalibrationMatches(
  matches: readonly { family: string; matchedPhrase: string }[]
): Array<{ family: string; phrase: string; logOnly?: true }> {
  return matches.map((m) => ({
    family: m.family,
    phrase: m.matchedPhrase,
    ...(LOG_ONLY_FAMILIES.has(m.family) ? { logOnly: true as const } : {}),
  }));
}

/**
 * Calls whose RESULT carries a task's current status.
 *
 * `tasks_status_set` is deliberately IN this set. It is a write, but the state it leaves behind is
 * exactly as much evidence as a read returning the same value — a turn that moves a task to
 * PLANNING and then ends has established a non-terminal status just as surely as one that looked
 * it up. Occurrence 2 below is that case.
 *
 * `tasks_list` and `tasks_search` are deliberately OUT, and this is the single largest precision
 * lever in the arm. A BULK query returns every task matching a filter, so a turn that lists the
 * backlog has "read" a hundred non-terminal statuses without having looked at any one of them —
 * naming one in a status report would then fire. The conjunct is meant to establish that the turn
 * LOOKED AT this task, and only a targeted query does that.
 *
 * **Measured, and it is NOT the noise lever it was expected to be:** removing `tasks_list` moved
 * the arm's fire rate from 8.94% to 8.88% of replayed turns (1001 -> 994 of 11,196). The
 * exclusion is kept because the reasoning above is sound on its own, but the honest record is
 * that it bought almost nothing — a batch `refs_status` is the dominant read shape in this repo
 * and is nearly as weak a signal of "looked at THIS task". That is why the arm ships log-only;
 * see the PR body and `## SC6` in the spec.
 */
export const TASK_STATUS_READ_TOOLS = new Set([
  "mcp__minsky__refs_status",
  "mcp__minsky__tasks_status_get",
  "mcp__minsky__tasks_get",
  "mcp__minsky__tasks_status_set",
]);

/**
 * Calls that ADVANCE a task, so a non-terminal status on it is work in progress rather than work
 * left stranded. Matched against each call's INPUT (`task` / `taskId`), not its result.
 *
 * `tasks_status_set` is NOT here, per the note above: moving a task to a non-terminal status is
 * the stranding signal itself, not a defense against it.
 */
export const TASK_ADVANCING_TOOLS = new Set([
  "mcp__minsky__session_start",
  "mcp__minsky__session_commit",
  "mcp__minsky__session_pr_create",
  "mcp__minsky__session_pr_merge",
  "mcp__minsky__tasks_spec_patch",
  "mcp__minsky__tasks_spec_search_replace",
  "mcp__minsky__tasks_dispatch",
]);

/**
 * Input keys an advancing tool may carry its task id under (PR #3420 R1).
 *
 * Checked against every member of {@link TASK_ADVANCING_TOOLS} at the time of writing: the four
 * `session_*` tools take `task`, and `tasks_spec_patch` / `tasks_spec_search_replace` /
 * `tasks_dispatch` take `taskId`. So `id` and `parentTaskId` are not reached by today's set —
 * they are here because the FAILURE MODE is silent and asymmetric, which is what makes this
 * blocking rather than cosmetic. This set and `TASK_ADVANCING_TOOLS` are two hand-maintained
 * lists that must agree; adding a tool that names its id differently would not error, it would
 * quietly stop crediting that tool as advancing and turn every one of its turns into a fire.
 *
 * `advancing-tool-key-parity.test` pins the pairing, so drift is a deliberate edit with a visible
 * diff — the same defense `ARMED_WAIT_TOOLS` documents for its own hand-maintained set.
 */
export const TASK_ID_INPUT_KEYS = ["task", "taskId", "id", "parentTaskId"] as const;

/**
 * The non-terminal statuses, as an ALLOWLIST rather than "everything that is not DONE/CLOSED".
 *
 * The complement form looks equivalent and is not: the regex below matches an uppercase token in
 * a status-shaped position, and a tool result can carry one that is not a task status at all. The
 * first replay produced a `COMPLETED` — no such member exists in this state machine — which the
 * complement form would have accepted as non-terminal and fired on. An allowlist keyed to the real
 * enum cannot do that.
 */
const NON_TERMINAL_TASK_STATUSES = new Set([
  "TODO",
  "PLANNING",
  "READY",
  "IN-PROGRESS",
  "IN-REVIEW",
  "BLOCKED",
]);

/**
 * A task id joined to the status the same JSON object reports for it.
 *
 * `[^}]` bounds the join to ONE object, which is what makes this safe on a multi-row `refs_status`
 * payload: without it a lazy any-char span would happily pair row N's id with row N+1's status.
 * The id key varies by tool (`ref` / `id` / `taskId`) and so does the status key (`status` on a
 * read, `newStatus` on a set) — `previousStatus` is excluded by the leading quote in the class.
 */
const TASK_ID_WITH_STATUS =
  /"(?:ref|id|taskId)"\s*:\s*"(mt#\d+)"[^}]{0,2000}?"(?:status|newStatus)"\s*:\s*"([A-Z][A-Z-]*)"/g;

const TASK_ID_RE = /^mt#\d+$/;

/** Keys a result object may carry a task id / status under. */
const RESULT_ID_KEYS = ["ref", "id", "taskId"] as const;
const RESULT_STATUS_KEYS = ["status", "newStatus"] as const;

/**
 * Walk a parsed result for objects carrying BOTH a task id and a status, recording each pair.
 *
 * Structural, so there is no positional window to get wrong (PR #3420 R1). The regex fallback
 * below pairs an id with the next status inside the same `{...}`, which needs a length bound, and
 * any bound is a silent recall cliff: `tasks_get` with a spec attached puts kilobytes between the
 * id and the status, so a 400-char window quietly dropped exactly the largest results. Parsing
 * removes the question rather than re-tuning the number.
 */
function collectFromJson(value: unknown, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFromJson(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;

  const id = RESULT_ID_KEYS.map((k) => obj[k]).find(
    (v): v is string => typeof v === "string" && TASK_ID_RE.test(v)
  );
  const status = RESULT_STATUS_KEYS.map((k) => obj[k]).find(
    (v): v is string => typeof v === "string"
  );
  if (id && status && NON_TERMINAL_TASK_STATUSES.has(status)) out.set(id, status);

  for (const nested of Object.values(obj)) collectFromJson(nested, out);
}

/**
 * Task ids with a non-terminal status in one tool result.
 *
 * Parse first; fall back to the bounded regex only when the body is not JSON — a tool result is
 * usually a JSON document but is not guaranteed to be one, and a text result should degrade to
 * partial recall rather than to a throw.
 */
function collectTaskStatuses(resultText: string, out: Map<string, string>): void {
  try {
    collectFromJson(JSON.parse(resultText), out);
    return;
  } catch {
    // intentional-swallow: a non-JSON result body is expected, not exceptional — fall through to
    // the regex path below, which is what handles it.
  }
  TASK_ID_WITH_STATUS.lastIndex = 0; // `lastIndex` persists on a /g regex across calls
  let m: RegExpExecArray | null;
  while ((m = TASK_ID_WITH_STATUS.exec(resultText)) !== null) {
    const [, id, status] = m;
    if (id && status && NON_TERMINAL_TASK_STATUSES.has(status)) out.set(id, status);
  }
}

/** Task ids the closing message actually names. */
function taskIdsNamedIn(text: string): Set<string> {
  return new Set(text.match(/mt#\d+/g) ?? []);
}

/**
 * The tool-call-state match arm (mt#4697): a task this turn READ, whose status came back
 * NON-TERMINAL, which the closing message NAMES, and which the turn never ADVANCED.
 *
 * ## Why this is not another phrase family
 *
 * Every one of this guard's ten `COMMITMENT_PATTERNS` families needs a first-person subject or a
 * fixed idiom, so a turn that names its next action impersonally matches nothing. That axis is
 * measurably closed: `going-to`, the last family added, fired 0 times in the 252 calibration
 * records logged in the 19 days after it shipped, and five of the ten families have never fired at
 * all. ADR-024 §Context names serial regex-family additions as the arms race the ladder exists to
 * end, and `detectArmedWatcherEvidence` already made this exact move on the SUPPRESSION side
 * (mt#4063): drop the language axis, read the tool calls. This is that move on the MATCH side.
 *
 * It is NOT a Rung-2 climb. Whether a turn left work stranded is a fact about its tool calls, not
 * a language question, so reading it directly REMOVES the paraphrase axis rather than buying
 * recall along it.
 *
 * ## Why all three conjuncts
 *
 * The obvious predicate — "a non-terminal task named in the closing message" — is noisy by
 * construction, because a status report legitimately names tasks it is not working. Both other
 * conjuncts are what make this precise instead:
 *
 * - **READ this turn** excludes a message that merely mentions ids the turn never queried. The
 *   turn has to have LOOKED, which is what makes the non-terminal status something it knows.
 * - **Never ADVANCED** is the spec's own "on which the turn took no action", made decidable: a
 *   task this turn committed to, opened a PR for, or patched the spec of is work in progress.
 *
 * ## Coverage, against the three attested misses
 *
 * - 2026-08-21 (occurrence 3, the originating case): `refs_status` returned mt#4324 = `TODO`; the
 *   closing message named it (*"the unblocked successor but sits at TODO"*); the turn advanced
 *   mt#4323 instead. **Fires.**
 * - 2026-08-16 (occurrence 2): the turn SET mt#4183 to PLANNING and named PR #3039 at the close
 *   without advancing it. **Fires.**
 * - 2026-08-01 (occurrence 1): a first-person commitment with no task or PR state in the turn at
 *   all. **Does not fire, and is not meant to** — that is the phrase half.
 */
export function detectStrandedTaskState(
  finalMessage: string,
  turnLines: Parameters<typeof findToolUseInputs>[0]
): UntakenActionMatch[] {
  const named = taskIdsNamedIn(finalMessage);
  if (named.size === 0) return [];

  const calls = findToolCallsWithResults(turnLines);
  const advanced = new Set<string>();
  const nonTerminal = new Map<string, string>();

  for (const call of calls) {
    if (TASK_ADVANCING_TOOLS.has(call.toolName)) {
      for (const key of TASK_ID_INPUT_KEYS) {
        const value = call.input[key];
        if (typeof value === "string" && TASK_ID_RE.test(value)) advanced.add(value);
      }
    }

    if (!TASK_STATUS_READ_TOOLS.has(call.toolName) || !call.hasResult) continue;
    collectTaskStatuses(call.resultText, nonTerminal);
  }

  const stranded: UntakenActionMatch[] = [];
  for (const [id, status] of nonTerminal) {
    if (!named.has(id) || advanced.has(id)) continue;
    stranded.push({ family: STRANDED_TASK_FAMILY, matchedPhrase: `${id} (${status})` });
  }
  return stranded;
}

/**
 * Guard-dispatcher entry point (GuardModule contract). `storeDir` is a test
 * seam for the dedup store location; the dispatcher never passes it.
 */
export function run(
  input: StopHookInput,
  ctx: DispatchContext,
  storeDir?: string
): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[turn-end-untaken-action] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  // Deliberately NOT the transcript-union the retro-scan sibling uses: this
  // guard's whole signal is that the text sits at the END of the turn. Folding
  // in earlier assistant text would match announcements the turn then acted on.
  const finalMessage = input.last_assistant_message ?? "";
  if (!finalMessage) return null;

  // mt#4117: the evaluation stream, distinct from the calibration log below.
  // The calibration log records FIRES only (matches.length > 0, post-dedup).
  // This records every SCANNED turn-ending message — fired, not-fired, or
  // suppressed — so the miss rate is measurable rather than just the hit
  // count. `finalMessage` is non-empty at this point, so everything past this
  // line counts as "scanned"; the override branch above returns before this,
  // matching the sibling detectors' convention of not evaluating an acked turn.
  const evaluationSkipped = isEvaluationSkipped();
  const recordEvaluation = (fields: {
    fired: boolean;
    suppressed: boolean;
    suppressionReason?: string;
    suppressionEvidence?: string[];
    deduped?: boolean;
    injected: boolean;
    deferralOverlap?: boolean;
    matches: UntakenActionMatch[];
  }): void => {
    if (evaluationSkipped) return;
    appendEvaluationRecord(input.cwd ?? process.cwd(), {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      fired: fields.fired,
      suppressed: fields.suppressed,
      ...(fields.suppressionReason !== undefined
        ? { suppressionReason: fields.suppressionReason }
        : {}),
      ...(fields.suppressionEvidence !== undefined
        ? { suppressionEvidence: fields.suppressionEvidence }
        : {}),
      ...(fields.deduped !== undefined ? { deduped: fields.deduped } : {}),
      injected: fields.injected,
      ...(fields.deferralOverlap !== undefined ? { deferralOverlap: fields.deferralOverlap } : {}),
      matches: fields.matches.map((m) => ({ family: m.family, phrase: m.matchedPhrase })),
      final_message_tail: finalMessage.slice(-TAIL_WINDOW_CHARS),
    });
  };

  // mt#4697 SC2: the turn is resolved BEFORE the early return, and the tool-call-state arm is
  // unioned with the phrase matches. Both halves of that ordering are load-bearing — the arm's
  // whole purpose is to fire on a turn whose prose matches NOTHING, so computing it after
  // `matches.length === 0` would make it permanently unreachable on exactly its target case.
  // `extractFinalTurn` was already being called further down for the suppression predicates; it
  // is hoisted here rather than called twice.
  const { turnLines, openingPrompt } = extractFinalTurn(ctx.transcriptLines ?? []);
  const matches = [
    ...detectUntakenAction(finalMessage),
    // mt#4835: the present-progressive arm reads the same final message and needs no
    // transcript, so unlike the stranded-task arm it is unconditional.
    ...detectPresentProgressiveAssertion(finalMessage),
    ...(turnLines.length > 0 ? detectStrandedTaskState(finalMessage, turnLines) : []),
  ];
  if (matches.length === 0) {
    // A genuine non-fire: the matcher found nothing in this turn-ending message.
    // Silent — no additionalContext, no advisory — per this task's SC4.
    recordEvaluation({ fired: false, suppressed: false, injected: false, matches: [] });
    return null;
  }

  const sessionId = input.session_id ?? "unknown";
  const turnKey = turnKeyForMessage(finalMessage);
  const flagged = readFlagged(sessionId, storeDir);
  const newMatches = matches.filter(
    (m) => !flagged.has(flagKey(turnKey, m.family, m.matchedPhrase))
  );
  if (newMatches.length === 0) {
    // The matcher fired, but every match is a repeat of a phrase already
    // flagged for this turn (a Stop-continuation re-entry). Recorded as a
    // fire so the raw matcher signal is not lost, marked `deduped` so a
    // calibration pass does not double-count it against the same turn the
    // first pass already recorded.
    recordEvaluation({ fired: true, suppressed: false, deduped: true, injected: false, matches });
    return null;
  }

  // mt#4697 SC6: split the new matches by side. BOTH reach the calibration record — the arm is
  // being measured, and a fire that is not recorded cannot be classified — but only the phrase
  // side may reach `additionalContext`. See the note on `additionalContext` for the measurement
  // that put the arm on the log-only rung.
  const strandedNew = newMatches.filter((m) => m.family === STRANDED_TASK_FAMILY);
  const presentProgressiveNew = newMatches.filter((m) => m.family === PRESENT_PROGRESSIVE_FAMILY);
  const injectable = newMatches.filter((m) => !LOG_ONLY_FAMILIES.has(m.family));

  for (const m of newMatches) {
    flagged.add(flagKey(turnKey, m.family, m.matchedPhrase));
  }
  writeFlagged(sessionId, flagged, storeDir);

  // mt#3768: the turn named a category the principal reserves, so stopping was
  // what the corpus required. Suppress the injection — but RECORD it, per the
  // mt#3207 contract: a suppression that returns null is invisible, and the
  // failure mode worth catching here is this predicate silencing a TRUE positive.
  // An empty `suppressionReasons` means "recorded an outcome, did not suppress";
  // a populated one means the fire was swallowed and by what.
  //
  // ## Why this sits AFTER the dedup filter (PR #2731 R1)
  //
  // Review asked for it BEFORE the `newMatches.length === 0` early return, on the
  // grounds that a re-entered turn is then suppressed with no record — which is
  // accurate, and is the same thing that happens to an INJECTING fire on re-entry.
  // The ordering is deliberate: the dedup key is the final message's own hash, so
  // a second occurrence is byte-identical text reaching the same verdict. One
  // record per distinct turn is what a calibration pass wants; N records for one
  // repeated message would inflate the suppression rate and misstate exactly the
  // measurement this record exists to support.
  //
  // What review correctly caught is that the CLAIM was unqualified. The contract
  // is "a suppressed fire is recorded once per distinct turn, under the same dedup
  // as an injecting fire" — not "on every Stop." Reworded here, in the doc page,
  // and in the PR body rather than changed in behavior.
  // mt#4116: six suppressions now share one record shape, so it is built once. Each carries its
  // own reason plus one evidence field named for that reason — the calibration pass reads the
  // reason to know WHY a fire was swallowed and the evidence to check whether it should have been.
  const suppressed = (reason: string, evidenceKey: string, evidence: string[]): GuardOutcome => {
    // mt#4117: a suppressed fire is the class most likely to hide a
    // regression (SC5) — recorded as suppressed-with-reason, never folded
    // into a non-fire.
    recordEvaluation({
      fired: true,
      suppressed: true,
      suppressionReason: reason,
      suppressionEvidence: evidence,
      injected: false,
      matches: newMatches,
    });
    return {
      calibration: {
        source: "live",
        channel: "stop",
        timestamp: new Date().toISOString(),
        session_id: input.session_id,
        stop_hook_active: input.stop_hook_active === true,
        matches: toCalibrationMatches(newMatches),
        final_message_tail: finalMessage.slice(-TAIL_WINDOW_CHARS),
        deferralOverlap: detectDeferralPhrases(finalMessage).length > 0,
        suppressionReasons: [reason],
        [evidenceKey]: evidence,
      },
    };
  };

  const reservedCategory = detectReservedCategoryHalt(finalMessage);
  if (reservedCategory.length > 0) {
    return suppressed(
      SUPPRESSION_RESERVED_CATEGORY_HALT,
      "reservedCategoryPhrases",
      reservedCategory
    );
  }

  // mt#4116, shape 1: the named-but-untaken step is DESTRUCTIVE, which
  // `user-preferences.mdc §Probe before deferring` names as a stopping point in its own right —
  // a PEER of the reserved-category list above rather than a member of it, which is why the list
  // never covered it. Keyed on the destructive VERB, not on a claim of destructiveness.
  const destructive = detectDestructiveNamedAction(finalMessage);
  if (destructive.length > 0) {
    return suppressed(SUPPRESSION_DESTRUCTIVE_ACTION_HALT, "destructiveActionPhrases", destructive);
  }

  // mt#4116, shape 3: the named step is a HARNESS command the agent cannot issue at all. A closed
  // list; the general participation-required case is deliberately out of scope (see the pattern
  // set's own comment for why it is not lexically decidable).
  //
  // mt#4139: the command being un-issuable is only HALF the halt. Suppress when the harness
  // command is the terminal named action; decline when the message also commits to a distinct
  // action gated behind it, because that second claim — "therefore I cannot do <goal>" — is the
  // unexamined one, and it is false whenever the goal has a non-harness path. See
  // `namesActionBeyondHarnessCommand`.
  //
  // PR #2994 R1: this reads `matches`, NOT `newMatches`. Whether the message commits to an action
  // beyond the harness command is a property of the MESSAGE; `newMatches` is the dedup bookkeeping
  // filter, and a commitment already flagged for this turn would drop out of it and silently flip
  // the decision to suppress. On a first pass the two sets are equal, so this costs nothing and
  // removes the coupling. It is also the only DECISION site that reads the match list at all — the
  // other reads (the two calibration records, `buildReminder`) want the new-only set by design.
  const harnessCommand = detectHarnessCommandHalt(finalMessage);
  const harnessCommandDeclined =
    harnessCommand.length > 0 ? namesActionBeyondHarnessCommand(matches) : [];
  if (harnessCommand.length > 0 && harnessCommandDeclined.length === 0) {
    return suppressed(SUPPRESSION_HARNESS_COMMAND_HALT, "harnessCommandPhrases", harnessCommand);
  }

  // mt#4063: the turn ARMED a wait that outlives it, so a closing sentence
  // naming what happens when that wait fires is the behavior
  // `work-completion.mdc §External self-resolving waits` prescribes, not the
  // defect this guard exists to catch. Keyed on the turn's tool calls rather
  // than its prose — see `detectArmedWatcherEvidence` for why this replaces
  // widening the phrase patterns a third time.
  //
  // Recorded, not silent, per the same mt#3207 contract as the suppression
  // above: the failure worth catching is this predicate swallowing a TRUE
  // positive, and a suppression that returns null cannot be measured.
  // `turnLines` / `openingPrompt` are resolved above the early return (mt#4697), so the arm can be
  // unioned into `matches`. This suppression is unchanged and still runs AFTER the match
  // computation — which is what makes SC3 hold without a duplicate armed-wait check inside the arm.
  const armedWatcher = turnLines.length > 0 ? detectArmedWatcherEvidence(turnLines) : [];
  if (armedWatcher.length > 0) {
    return suppressed(SUPPRESSION_ARMED_WATCHER_EVIDENCE, "armedWatcherEvidence", armedWatcher);
  }

  // mt#4116, shape 2: the turn named the filed-for-later-by-design branch AND actually minted a
  // task. Both halves required — the prose alone is the confabulated-halt shape the sibling
  // `turn-end-unwalked-task` guard exists to catch, and this must not become a way past it.
  const filedByDesign =
    turnLines.length > 0 ? detectFiledByDesignHalt(finalMessage, turnLines) : [];
  if (filedByDesign.length > 0) {
    return suppressed(SUPPRESSION_FILED_BY_DESIGN_HALT, "filedByDesignEvidence", filedByDesign);
  }

  // mt#4113: the PRINCIPAL's own instruction bounded the scope. Keyed on the opening prompt rather
  // than the agent's prose — a real citation and an invented one are the same words, so only the
  // prompt can tell them apart. `extractFinalTurn` already returned it; it was being discarded.
  const openingPromptText = extractPromptText(openingPrompt);
  const principalInstruction = detectPrincipalInstructionHalt(finalMessage, openingPromptText);
  if (principalInstruction.length > 0) {
    return suppressed(
      SUPPRESSION_PRINCIPAL_INSTRUCTION_HALT,
      "principalInstructionEvidence",
      principalInstruction
    );
  }

  // mt#3620: when the same final message ALSO matches the ask-routing-deferral
  // patterns ("say the word" sits in BOTH pattern sets), exactly one of the two
  // guards should speak. THIS one does.
  //
  // mt#3336 originally made this guard yield instead, on the reasoning that the
  // deferral guidance is the more specific of the two. The reasoning holds; the
  // direction did not. The sibling runs on `UserPromptSubmit`, an event that by
  // construction occurs only AFTER the principal has read the closing sentence
  // and typed a reply — so yielding to it traded a warning that could prevent
  // the round-trip for one that can only comment on it afterwards. A dedup
  // between guards on DIFFERENT events is a handoff, and it has to hand toward
  // the EARLIER event.
  //
  // The overlap is recorded in the store instead, and the prompt-time sibling
  // reads it and stays quiet — one closing sentence, one injection, as intended.
  const deferralOverlap = detectDeferralPhrases(finalMessage);
  if (deferralOverlap.length > 0) {
    const overlapKey = overlapTurnKey(finalMessage, sha1Short);
    for (const m of deferralOverlap) {
      flagged.add(flagKey(overlapKey, STOP_INJECTED_OVERLAP_FAMILY, m.matchedPhrase));
    }
    writeFlagged(sessionId, flagged, storeDir);
  }

  // mt#4117: the un-suppressed path — the raw matcher signal reaches here
  // whether or not `injectable` ends up empty (the strandedTaskArm-only,
  // log-only case). `injected` distinguishes the two: an agent actually saw
  // `additionalContext` only when it is true.
  recordEvaluation({
    fired: true,
    suppressed: false,
    injected: injectable.length > 0,
    deferralOverlap: deferralOverlap.length > 0,
    matches: newMatches,
  });

  return {
    calibration: {
      source: "live",
      channel: "stop",
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      stop_hook_active: input.stop_hook_active === true,
      matches: toCalibrationMatches(newMatches),
      final_message_tail: finalMessage.slice(-TAIL_WINDOW_CHARS),
      // Retained (mt#3620) so the overlap rate stays measurable across the
      // direction change — but it no longer suppresses, so it is reported
      // under its own name and NOT as a suppression reason.
      deferralOverlap: deferralOverlap.length > 0,
      // mt#3207: the shared contract the sweep actually reads. This guard now
      // always injects when it has new matches, so the list is always empty —
      // empty (not absent) still means "recorded an outcome, did not suppress".
      suppressionReasons: [] as string[],
      // mt#4139: a harness command WAS named and the suppression was declined
      // because the message committed to a distinct action behind it. Present
      // only on that path, so the next calibration pass can measure this
      // decision separately from an ordinary fire rather than inferring it.
      ...(harnessCommandDeclined.length > 0 ? { harnessCommandDeclined } : {}),
      // mt#4697 SC6: the tool-call-state arm's own fires, named so a calibration pass can classify
      // them without having to separate them from the phrase side by hand.
      ...(strandedNew.length > 0
        ? { strandedTaskArm: strandedNew.map((m) => m.matchedPhrase), strandedArmLogOnly: true }
        : {}),
      // mt#4835: the present-progressive arm's own fires, named for the same reason as the
      // stranded-task arm above — a calibration pass classifying this arm needs to find it
      // without separating it from the phrase side by hand. The classification question here is
      // specifically "was the participial phrase an assertion, or a gerund subject the
      // discriminator let through?"
      ...(presentProgressiveNew.length > 0
        ? {
            presentProgressiveArm: presentProgressiveNew.map((m) => m.matchedPhrase),
            presentProgressiveArmLogOnly: true,
          }
        : {}),
    },
    // The overlap flag selects the DIRECTIVE, not just the calibration field
    // above (mt#3767) — see `DEFERRAL_DIRECTIVE` for why the winning guard owes
    // the silenced sibling's remedy and not only its speaking slot.
    //
    // mt#4697 SC6: the arm ships LOG-ONLY, so its matches reach the calibration record above but
    // NOT the injection. Measured over 11,196 replayed turns: the arm fires on 994 (8.88%) against
    // the shipped phrase side's 345 (3.08%) — nearly TRIPLE the volume, on a detector that is
    // already live. mt#3560's tail-window safety argument does not transfer to a state-keyed arm,
    // which is exactly what SC6 exists to establish, and ADR-024's ladder wants a calibration pass
    // to classify those 994 before any of them interrupt an agent. `injectable` is empty when the
    // arm was the ONLY thing that matched, and then this whole call yields undefined — a recorded
    // fire with no injection, which is what log-only means here.
    additionalContext:
      injectable.length > 0 ? buildReminder(injectable, deferralOverlap.length > 0) : undefined,
  };
}
