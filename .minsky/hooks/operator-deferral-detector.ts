#!/usr/bin/env bun
// Operator-deferral detector (mt#2459) — three calibration-first, LOG-ONLY
// surfaces for the probe-before-defer / operator-must-do-X family.
//
// The family: the agent hands the principal an action it could have performed
// itself, without first running the capability probe `user-preferences.mdc
// §Probe before deferring` requires. Five recorded recurrences (R1 2026-05-13
// mt#1811, R2 2026-05-20, R3 2026-06-02, R4 2026-06-04, R5 2026-06-18) across
// two rule-tier fixes (mt#1819, mt#1988) — the corpus text is not consulted at
// action-execution time, which is why this family needs a detector surface.
//
// SCOPE BOUNDARY — what this detector deliberately does NOT cover.
// `substrate-bypass-detector.ts`'s `OPERATOR_INSTRUCTION_PATTERNS` (mt#2303,
// shipped) already owns the ACTIVATION-instruction half of the family: "after
// your next rebuild, hard-refresh to see it", "you'll need to edit
// cockpit.json". Do NOT add those phrasings here — they would double-fire and
// double-count in two calibration logs. This detector owns the three surfaces
// mt#2303 cannot reach:
//
//   A. CAPABILITY-deferral prose ("requires Railway access", "deferred to
//      operator", "outside agent context") WITHOUT same-turn probe evidence.
//      mt#2303 has no probe-evidence axis at all — its only suppression is
//      "the agent did it itself", which is a different question.
//   B. `AskUserQuestion` OPTION LABELS that offer the principal a fixable
//      infra/credential action. mt#2303 scans assistant TEXT only, so an ask
//      whose deferral lives entirely in structured option labels is invisible
//      to every existing detector (this is exactly how R5 escaped).
//   C. PERMISSION-deferral prose (mt#3463) — "say the word and I'll do it",
//      "want me to?". The opposite claim from A: the agent concedes it CAN act
//      and asks anyway. Worse to miss than A, because A's claim is falsifiable
//      by the probe and a permission offer never engages that check at all.
//      Excludes genuinely destructive / principal-reserved actions, where the
//      ask is CORRECT — see PERMISSION_ESCALATION_EXCLUSIONS.
//
// All three surfaces are LOG-ONLY in v1 (`INJECTION_ENABLED = false`), per the
// calibration-first ladder every sibling detector followed (mt#2057 → mt#2216
// → mt#2694). Surface B is registered on PreToolUse and COULD deny the ask
// before it reaches the principal (vendor docs confirm PreToolUse fires on
// every tool call except EndConversation and supports `permissionDecision:
// "deny"`), but v1 declares `denyCapable: false` — the calibration log decides
// whether that power is warranted.
//
// @see mt#2459 — this task
// @see mt#2303 / substrate-bypass-detector.ts — the activation-instruction half
// @see ask-routing-deferral-detector.ts — sibling structure (a DECISION being
//      deferred; this detector is about an ACTION being deferred)
// @see mem#582 — R5 incident (the AskUserQuestion option labels replayed below)
// @see mem#535 — R2/R4 incident (owned by mt#2303, pinned here as a
//      non-duplication regression test)

import { readInput, findRepoRoot } from "./types";
import type { ClaudeHookInput, ToolHookInput, HookOutput } from "./types";
import {
  resolveParentTranscriptLinesForPath,
  extractLastAssistantTurn,
  extractFinalTurn,
  extractAssistantText,
  extractToolUseNames,
  findToolUseInputs,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";
import { logEvaluationRecord } from "./dispatcher";
import { elideQuotedContexts, elideDoubleQuotedSpans } from "./elision";
import {
  CAPTURE_SCHEMA_FIELD,
  CAPTURE_SCHEMA_VERSION,
  extractMatchContext,
} from "./judged-input-capture";
// Surrogate-pair-safe truncation — the matched text is arbitrary assistant
// prose / operator-authored option labels, so a raw `.slice(0, N)` can split
// an emoji. Same cross-tree import the standalone parallel-work guard uses.
import { safeTruncate } from "../../src/utils/safe-truncate";

// The former `MATCH_EXCERPT_MAX_CHARS = 200` is gone (PR #2687 R1): the bound on
// captured text is now `MATCH_CONTEXT_MAX_CHARS` inside the shared
// `judged-input-capture` module, which is where the truncation happens. Keeping
// a second, unused cap here would be exactly the divergence that consolidation
// removed.

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/**
 * Calibration-first gate. v1 ships FALSE (log only, inject nothing) per the
 * mt#2057/mt#2216/mt#2694 ladder and this task's SC#2. Flip only after a
 * calibration review classifies ~10 real fires.
 */
export const INJECTION_ENABLED = false;

/**
 * LOG-ONLY surfaces use `MINSKY_SKIP_*` (skip detection + the calibration
 * write) rather than an injecting hook's `MINSKY_ACK_*` — matching the sibling
 * calibration detectors (silent-stretch, wall-of-text, and mt#2303's own
 * operator-instruction surface). Registered in `HOOK_ONLY_ENV_VARS`.
 */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_OPERATOR_DEFERRAL";

const CALIBRATION_LOG = ".minsky/operator-deferral-calibration.jsonl";

export type DeferralSurface =
  | "capability-deferral-prose"
  | "permission-deferral-prose"
  | "ask-option-label";

export interface DeferralMatch {
  surface: DeferralSurface;
  /**
   * The PATTERN text that matched — `m[0]`, not the window around it (mt#3781).
   *
   * This field is written to the calibration record as `phrase`, and `phrase`
   * is what `extractDistinctPhrases` (`src/domain/calibration/calibration-sweep.ts`)
   * uses as this log's diversity axis. `computeLogResult` gates review-due on
   * that axis with an explicit purpose — *"Ten identical fires are NOT a review
   * signal, they're a uniform pattern; keep collecting until diversity
   * arrives."*
   *
   * Until mt#3781 this field held a ±window SNIPPET of surrounding prose. No
   * two fires are ever byte-equal under that shape, so the diversity bar was
   * satisfied by construction and the gate was INERT — it could never hold back
   * the uniform pattern it exists to hold back. The pattern text restores the
   * intended meaning: two fires on the same trigger phrase count once.
   */
  matchedPhrase: string;
  /**
   * The surrounding prose the pattern was found in — what `matchedPhrase` used
   * to hold (mt#3781).
   *
   * Kept because it is what makes a fire CLASSIFIABLE by a human reviewer — a
   * bare pattern hit cannot distinguish a real deferral from a quotation of one
   * — and because it is what the guard's advisory line renders.
   *
   * Extracted by the SHARED `extractMatchContext` (mt#3607), not this module's
   * former ±20/+60 window (PR #2687 R1) — so this detector does not carry its
   * own copy of a problem three others already solved, and the window reads as
   * prose instead of clipping mid-word.
   *
   * `leadSentences: 1` on the prose surfaces, and the reason is the same one
   * mt#3607 measured for `ask-routing-deferral`: this corpus's triggers are
   * frequently WHOLE SENTENCES (`Deferred to operator: requires Railway
   * access.`), and for those the containing sentence alone is byte-identical
   * across two fires — it would carry no more information than `matchedPhrase`
   * already does. The old ±20 window happened to include a fragment of the
   * preceding clause; one lead sentence is that property, done deliberately.
   * The ask-option-label surface takes the default: a label is the unit, and
   * there is no preceding sentence to reach for.
   *
   * The 240-char cap is wider than the old 200, so the guard's rendered
   * advisory was re-measured against its declared `attentionCost` ceiling
   * rather than assumed to still fit.
   */
  context: string;
}

// ---------------------------------------------------------------------------
// Surface A — capability-deferral prose
// ---------------------------------------------------------------------------

/**
 * Capability-deferral phrasings: the agent claims it CANNOT do the thing, or
 * assigns the doing to the principal. Distinct from mt#2303's
 * activation-instruction list (rebuild / reinstall / edit-config / refresh),
 * which describes work that follows a change rather than a capability the
 * agent claims to lack. Deliberately broad for calibration; false positives
 * are tuned from the log, per mt#2303's precedent.
 */
export const CAPABILITY_DEFERRAL_PATTERNS: RegExp[] = [
  /\bdeferred?\s+to\s+(the\s+)?(operator|user|principal|you)\b/i,
  /\brequires?\s+(?:\w+[\s-]){0,3}(access|credentials?|permissions?|token|secret)\b/i,
  /\b(you|the\s+operator|the\s+user)(?:'?ll|\s+will)?\s+(need|have)\s+to\s+(provide|grant|supply|set|add)\b/i,
  /\b(provide|give|paste|share)\s+(me\s+)?(the|your|a)\s+(?:[\w-]+\s+){0,3}(token|credential|key|secret|password)\b/i,
  /\b(outside|not\s+available\s+(from|in|to))\s+(the\s+)?agent\s+context\b/i,
  /\boperator\s+follow-?up\b/i,
  /\b(user|operator|you)\s+must\s+(do|run|handle|perform|fix|restart|deploy)\b/i,
  /\bI\s+(don'?t|do\s+not|cannot|can'?t)\s+have\s+(access|permission|credentials?)\b/i,
  /\b(this|that|it)\s+(is|'s)\s+(on|for)\s+(you|the\s+operator|the\s+principal)\s+to\s+(do|run|fix)\b/i,
];

// ---------------------------------------------------------------------------
// Surface C — permission-deferral prose (mt#3463)
// ---------------------------------------------------------------------------

/**
 * Permission-deferral phrasings: the agent concedes it CAN do the thing and
 * asks anyway. The opposite claim from Surface A — "I can, shall I?" rather
 * than "I can't" — and the same cost to the principal: a round-trip for work
 * that was already in-authority.
 *
 * **Why this needs its own surface rather than a wider Surface A.** Surface A's
 * patterns are uniformly capability/credential/ownership-shaped, so none of
 * these match (verified 2026-08-04; the probe and its positive controls are in
 * mt#3463's spec). The shapes are also differently falsifiable: a capability
 * claim can be checked by running the probe `§Probe before deferring` demands,
 * whereas a permission offer concedes capability, so that probe never engages —
 * there is nothing for it to check. That asymmetry is why the permission shape
 * is the more expensive of the two to miss.
 *
 * LOG-ONLY, like the rest of this detector. Deliberately broad for calibration;
 * {@link PERMISSION_ESCALATION_EXCLUSIONS} carries the one narrowing that is
 * NOT tuning — see there.
 */
export const PERMISSION_DEFERRAL_PATTERNS: RegExp[] = [
  /\bsay\s+the\s+word\s+and\s+(I|we)('?ll|\s+will|\s+can)\b/i,
  /\b(want|would\s+you\s+like)\s+me\s+to\b/i,
  /\b(shall|should)\s+I\b/i,
  /\bdo\s+you\s+want\s+me\s+to\b/i,
  /\blet\s+me\s+know\s+if\s+you('?d|\s+would)?\s*(like|want)\s+(me\s+to|that)\b/i,
  /\bI\s+can\s+(?:\w+[\s-]){0,6}if\s+you('?d|\s+would)?\s*(like|want|prefer)\b/i,
  /\b(happy|glad)\s+to\s+(?:\w+[\s-]){0,6}if\s+you\b/i,
  /\bjust\s+say\s+(the\s+word|so)\b/i,
];

/**
 * Escalations that SHOULD be routed to the principal — the permission-ask is
 * correct here and must not fire.
 *
 * This is not false-positive tuning, and it is the load-bearing half of this
 * surface: the patterns above match the SHAPE of a permission-ask, which is
 * identical whether the underlying action is in-authority or genuinely
 * reserved. Only the action discriminates. Firing on a legitimate escalation
 * would train exactly the wrong behaviour — it would push the agent to act
 * unilaterally on destructive or principal-reserved work, which is a far worse
 * failure than the round-trip this surface exists to prevent.
 *
 * Two classes, both drawn from existing corpus rules rather than invented here:
 *   - **Destructive / irreversible** — `git-safety.mdc`'s operation list plus
 *     shared/production state changes.
 *   - **Principal-reserved** — the closed category list in
 *     `principal-context.mdc §Decisions Eugene reserves`.
 */
export const PERMISSION_ESCALATION_EXCLUSIONS: RegExp[] = [
  // Destructive / irreversible (git-safety.mdc + shared/prod state)
  // `drop` takes an optional article — "drop the table" is the natural phrasing
  // and an adjacency-only pattern misses it (caught by the drop-table fixture).
  /\b(force[\s-]?push|--force|reset\s+--hard|rm\s+-rf|truncate|revert|rollback|delete|destroy|wipe|purge)\b/i,
  /\bdrop\s+(the\s+|a\s+|this\s+)?(table|database|schema|column|index)\b/i,
  /\b(deploy|push|ship|release|merge)\b[^.!?]{0,40}\b(to\s+)?(prod|production|main|master|live)\b/i,
  /\bproduction\b/i,
  // Principal-reserved categories (principal-context.mdc)
  /\b(name|naming|call\s+it|rename)\b[^.!?]{0,30}\?/i,
  /\b(vendor|pricing|paid\s+plan|upgrade\s+the\s+plan|sign\s+up)\b/i,
  /\b(scope|architecture|framework)\b[^.!?]{0,30}\b(change|choice|decision)\b/i,
];

/**
 * Inline probe REPORTS in the prose itself — the exact form
 * `user-preferences.mdc §Probe before deferring` prescribes for a justified
 * deferral ("Probed: which gh -> not on PATH; ... Deferred."). A deferral that
 * shows its probe results is the CORRECT shape and must not fire.
 */
export const PROBE_PROSE_PATTERNS: RegExp[] = [
  /\bprobed:/i,
  /\bprobe\s+(results?|sequence)\b/i,
  /\bprobes?\s+(returned|failed|show(s|ed)?|came\s+back)\b/i,
  /\bran\s+the\s+probe\b/i,
];

/**
 * Shell probes: capability checks an agent runs before concluding it lacks a
 * tool. Matched against a `Bash`/`session_exec` tool_use `command` input.
 *
 * Deliberately NARROW (PR #2263 R1). Two earlier members were removed because
 * they suppressed on commands that are not probes at all:
 *   - `config_get` — an MCP tool name, not a shell command; already covered by
 *     {@link PROBE_TOOL_NAME_PATTERN}. Keeping it here meant a `Bash` command
 *     that merely echoed the string counted as a capability probe.
 *   - a bare trailing `-v` — matched ordinary verbose/invert flags
 *     (`git log -v`, and any command ending in `-v`). `--version` is kept; it
 *     is unambiguous.
 * A false suppression here is the expensive direction: it silently hides a
 * real deferral, which is the exact failure this detector exists to catch.
 */
export const PROBE_COMMAND_PATTERN =
  /\b(which|command\s+-v|type\s+-p|whoami|--version|auth\s+status)\b/i;

/**
 * MCP tools whose invocation IS a capability probe — config/credential reads,
 * memory lookups, and the hosted-service clients whose presence answers "do I
 * have access?". Matched as a name pattern so a whole service family counts
 * without enumerating every method.
 */
export const PROBE_TOOL_NAME_PATTERN =
  /^(mcp__minsky__(config_(get|list|doctor|credentials_list)|memory_search)|mcp__plugin_(railway|cloudflare)_|mcp__supabase__|mcp__github__get_me)/;

/**
 * Loading a HOSTED-INFRA skill is the skill probe `user-preferences.mdc
 * §Probe before deferring` step 2 prescribes — the agent went looking for its
 * own capability against the named service.
 *
 * An explicit prefix allowlist, NOT a generic `namespace:` shape (PR #2263
 * R1). Namespacing is a convention across the whole skill catalog —
 * `Notion:search`, `chrome-devtools-mcp:troubleshooting`, `plugin:skill` — so
 * matching any `word:` prefix would let an unrelated skill load silently
 * suppress a real deferral. Only services whose skill answers "do I have
 * access to this infra?" belong here; add a prefix when a new hosted-infra
 * skill family ships.
 */
export const PROBE_SKILL_PREFIXES: ReadonlySet<string> = new Set([
  "railway",
  "cloudflare",
  "supabase",
  "github",
  "gh",
  "vercel",
  "aws",
  "gcloud",
  "fly",
  "heroku",
  "docker",
  "kubectl",
]);

/** True iff `skill` names a hosted-infra service skill (`railway:use-railway`). */
export function isProbeSkill(skill: string): boolean {
  const colon = skill.indexOf(":");
  if (colon <= 0) return false;
  return PROBE_SKILL_PREFIXES.has(skill.slice(0, colon).toLowerCase());
}

/**
 * True when the turn contains evidence the agent actually probed its own
 * capability before deferring — any of: a probe-shaped MCP tool call, a
 * service-scoped skill load, a probe-shaped shell command, or an inline probe
 * report in the prose. This is the axis mt#2303's surface entirely lacks and
 * the reason this detector is not a duplicate of it.
 */
export function hasProbeEvidence(turnLines: TranscriptLine[]): boolean {
  for (const name of extractToolUseNames(turnLines)) {
    if (PROBE_TOOL_NAME_PATTERN.test(name)) return true;
  }

  for (const input of findToolUseInputs(turnLines, "Skill")) {
    const skill = input["skill"];
    if (typeof skill === "string" && isProbeSkill(skill)) return true;
  }

  for (const toolName of ["Bash", "mcp__minsky__session_exec"]) {
    for (const input of findToolUseInputs(turnLines, toolName)) {
      const command = input["command"];
      if (typeof command === "string" && PROBE_COMMAND_PATTERN.test(command)) return true;
    }
  }

  const text = extractAssistantText(turnLines);
  return text ? PROBE_PROSE_PATTERNS.some((re) => re.test(text)) : false;
}

/**
 * Scan a turn's assistant prose for capability-deferral phrasing. Returns at
 * most one match (first hit) — the calibration record needs an exemplar, not
 * an exhaustive list. Quoted/code contexts are elided first so a rule quoting
 * its own trigger phrases (this file's own doc comment included) never fires.
 *
 * BOTH elision helpers are applied (mt#3273). `elideQuotedContexts` covers
 * fenced blocks, inline backticks, and blockquotes; `elideDoubleQuotedSpans`
 * covers straight/curly double-quoted prose, which the first one deliberately
 * does not touch. The self-referential case is this family's highest-frequency
 * false positive — every calibration review, retrospective, and PR body quotes
 * trigger phrases by construction — and it is exactly what this detector's
 * FIRST live fire was: `"requires Railway access"` quoted inside a report
 * describing the detector. That class had already been diagnosed and solved for
 * the sibling detectors (see `elideDoubleQuotedSpans`'s own doc comment, written
 * after 5 identical FPs in the 2026-07-08 review window); this detector shipped
 * calling only the narrower helper and re-introduced it.
 */
export function detectCapabilityDeferral(turnLines: TranscriptLine[]): DeferralMatch[] {
  const text = extractAssistantText(turnLines);
  if (!text) return [];
  if (hasProbeEvidence(turnLines)) return [];

  const scanned = elideDoubleQuotedSpans(elideQuotedContexts(text));
  for (const pattern of CAPABILITY_DEFERRAL_PATTERNS) {
    const m = pattern.exec(scanned);
    if (m) {
      const idx = m.index ?? 0;
      return [
        {
          surface: "capability-deferral-prose",
          matchedPhrase: m[0].trim(),
          context: extractMatchContext(scanned, idx, m[0].length, { leadSentences: 1 }),
        },
      ];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Surface B — AskUserQuestion option labels
// ---------------------------------------------------------------------------

/**
 * Option labels that hand the principal a FIXABLE infra/credential action.
 * These are the R5 shapes verbatim ("you recover the reviewer service",
 * "provide me the MCP auth token") plus their near neighbors.
 */
export const ASK_PRINCIPAL_ACTION_PATTERNS: RegExp[] = [
  /\byou\s+(restart|recover|redeploy|reprovision|provision|fix|run|re-?run|rebuild|reinstall|restore|deploy|grant)\b/i,
  /\b(provide|give|paste|share|hand)\s+(me\s+)?(the|your|a)\s+(?:[\w-]+\s+){0,3}(token|credential|key|secret|password)\b/i,
  /\b(recover|restart|redeploy|reprovision)\s+(the\s+)?[\w-]+\s+(service|server|deployment|container)\b/i,
  /\b(operator|principal|you)\s+(handles?|takes?\s+care\s+of|does)\s+(the\s+)?(deploy|restart|recovery|provisioning|fix)\b/i,
];

/**
 * Genuine principal-reserved decisions — preference, taste, architecture,
 * naming, scope. `principal-context.mdc` reserves these for Eugene, so asking
 * is CORRECT and must never fire. Same carve-out mt#1833 names
 * (`feedback_stakes_filter_on_humility`).
 */
export const PRINCIPAL_DECISION_PATTERNS: RegExp[] = [
  /\b(naming|name\s+it|what\s+(should|do)\s+(we|I)\s+call)\b/i,
  /\b(architecture|architectural|design\s+(direction|approach)|trade-?off)\b/i,
  /\b(scope|prioriti[sz]e|priority|which\s+(approach|option|direction))\b/i,
  /\b(prefer|preference|taste|style)\b/i,
];

/**
 * Remove DOUBLE quote characters (straight and curly), leaving the words they
 * wrap intact (mt#3273). Used only on `AskUserQuestion` option labels — NOT on
 * prose, where quoted spans are elided wholesale instead.
 *
 * Apostrophes and single quotes are deliberately excluded (PR #2355 R1). They
 * occur INSIDE words in ordinary English — `you'll`, `don't`, `operator's` —
 * so removing them rewrites word content and shifts the `\b` boundaries every
 * pattern in this module depends on, rather than just unwrapping a decoration.
 * That is a side effect well beyond the intent, and it would make the matcher's
 * behavior depend on contraction spelling.
 *
 * This mirrors the decision `elideDoubleQuotedSpans` already documents for the
 * prose surface — "Deliberately NOT covering single quotes: apostrophes ... make
 * single-quote pairing unreliable" — so both surfaces now draw the
 * double-vs-single line in the same place, for the same reason.
 */
export function stripQuoteChars(text: string): string {
  return text.replace(/["“”]/g, "");
}

/**
 * Flatten an `AskUserQuestion` tool_input into the strings worth scanning:
 * every question's text/header plus every option's label and description.
 * Shape-tolerant — a malformed or partial input contributes nothing rather
 * than throwing (this runs inside a PreToolUse guard; it must never block a
 * legitimate ask because the payload shape drifted).
 */
export function extractAskTexts(toolInput: Record<string, unknown> | undefined): {
  questionTexts: string[];
  optionTexts: string[];
} {
  const questionTexts: string[] = [];
  const optionTexts: string[] = [];
  const questions = toolInput?.["questions"];
  if (!Array.isArray(questions)) return { questionTexts, optionTexts };

  for (const raw of questions) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    for (const field of ["question", "header"]) {
      const v = q[field];
      if (typeof v === "string" && v.trim()) questionTexts.push(v);
    }
    const options = q["options"];
    if (!Array.isArray(options)) continue;
    for (const rawOpt of options) {
      if (!rawOpt || typeof rawOpt !== "object") continue;
      const opt = rawOpt as Record<string, unknown>;
      for (const field of ["label", "description"]) {
        const v = opt[field];
        if (typeof v === "string" && v.trim()) optionTexts.push(v);
      }
    }
  }
  return { questionTexts, optionTexts };
}

/**
 * Detect an ask that offers the principal a fixable infra/credential action
 * with no capability probe in the current turn. Suppressed when the question
 * reads as a genuine principal-reserved decision.
 *
 * Quote handling here is the OPPOSITE of the prose surface's (mt#3273 audit).
 * Prose ELIDES quoted spans, because prose can quote a trigger phrase while
 * merely discussing it. An option label cannot: it is the agent's own
 * structured proposal to the principal — it does not quote a deferral, it IS
 * one — so quotes inside a label decorate the thing being handed over. Eliding
 * them would delete signal.
 *
 * Worse, leaving them in place also deleted signal: the quote CHARACTER broke
 * matching outright. `Provide me the "MCP auth token"` did not fire, because
 * ASK_PRINCIPAL_ACTION_PATTERNS' filler group is `[\w-]+` and `"MCP` opens with
 * a non-word character — a silent false NEGATIVE on a verbatim R5-shaped label.
 * Found by the audit test this task's SC#4 required. So quote characters are
 * STRIPPED from option text before matching, leaving the words intact.
 */
export function detectAskDeferral(
  toolInput: Record<string, unknown> | undefined,
  turnLines: TranscriptLine[]
): DeferralMatch[] {
  const { questionTexts, optionTexts } = extractAskTexts(toolInput);
  if (optionTexts.length === 0) return [];

  const questionBlob = questionTexts.join("\n");
  if (PRINCIPAL_DECISION_PATTERNS.some((re) => re.test(questionBlob))) return [];
  if (hasProbeEvidence(turnLines)) return [];

  for (const text of optionTexts) {
    // Match against the quote-STRIPPED form (see the doc comment above), but
    // report the ORIGINAL label — the calibration record should show what the
    // agent actually wrote, not a normalized rewrite of it. That intent is
    // preserved by `context` (mt#3781); `matchedPhrase` carries the pattern hit
    // so the log's diversity axis counts trigger phrases rather than labels,
    // which are near-unique per fire.
    const matchable = stripQuoteChars(text);
    for (const pattern of ASK_PRINCIPAL_ACTION_PATTERNS) {
      const m = pattern.exec(matchable);
      if (m) {
        return [
          {
            surface: "ask-option-label",
            matchedPhrase: m[0].trim(),
            // The option label IS the surrounding text here, so the shared
            // helper is handed the label and the match's offset within it.
            context: extractMatchContext(text, m.index ?? 0, m[0].length),
          },
        ];
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Calibration logging
// ---------------------------------------------------------------------------

function isOverridden(): boolean {
  const v = process.env[OVERRIDE_ENV_VAR];
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/**
 * Detect a permission-ask for an action the agent could have just taken
 * (mt#3463, Surface C).
 *
 * Same suppression as Surface A: a turn that ran the capability probe and then
 * asked is not this failure. Sentence-scoped exclusion — the destructive /
 * principal-reserved check runs against the SENTENCE the match sits in, not the
 * whole turn, so an unrelated mention of "production" three paragraphs away
 * cannot mask a real permission-ask about something else.
 */
export function detectPermissionDeferral(turnLines: TranscriptLine[]): DeferralMatch[] {
  const text = extractAssistantText(turnLines);
  if (!text) return [];
  if (hasProbeEvidence(turnLines)) return [];

  const scanned = elideDoubleQuotedSpans(elideQuotedContexts(text));
  for (const pattern of PERMISSION_DEFERRAL_PATTERNS) {
    const m = pattern.exec(scanned);
    if (!m) continue;
    const idx = m.index ?? 0;
    const sentence = sentenceAround(scanned, idx);
    if (PERMISSION_ESCALATION_EXCLUSIONS.some((x) => x.test(sentence))) continue;
    return [
      {
        surface: "permission-deferral-prose",
        matchedPhrase: m[0].trim(),
        context: extractMatchContext(scanned, idx, m[0].length, { leadSentences: 1 }),
      },
    ];
  }
  return [];
}

/** The sentence containing `idx`, bounded by terminal punctuation or newline. */
function sentenceAround(text: string, idx: number): string {
  // Not a display truncation: this slice is only scanned for punctuation
  // indices and is never emitted, so a split surrogate pair cannot affect the
  // boundary it computes.
  // eslint-disable-next-line custom/no-unsafe-string-truncation
  const before = text.slice(0, idx);
  const start = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n")
  );
  const rest = text.slice(idx);
  const endRel = rest.search(/[.!?\n]/);
  return text.slice(start + 1, endRel === -1 ? text.length : idx + endRel + 1);
}

/**
 * Per-turn evaluation stream (mt#3463, per ask#6982's disposition).
 *
 * The calibration log records FIRES. A fire-only log can measure precision and
 * cannot measure RECALL — the misses leave no trace, so "how often does this
 * detector miss?" is unanswerable from it, and the next rung decision under
 * ADR-024 would rest on a task count rather than a rate. This records every
 * evaluated turn, fired or not, which is the substrate that question needs.
 * Mirrors the retrospective-trigger evaluation stream ADR-024's 2026-08-03
 * amendment added for exactly this reason.
 *
 * A bounded tail of the scanned text is stored deliberately: classifying a MISS
 * later requires seeing what was not matched.
 *
 * mt#3782: the logical stream NAME, not a path — `logEvaluationRecord` derives
 * `.minsky/<name>-evaluations.jsonl` from it, the same name/path split the
 * registry's `calibrationLog` uses. This detector was the fourth writer, and
 * the one mt#3745 missed: it enumerated the streams by listing
 * `.minsky/*-evaluations.jsonl` in the repo, which is the artifact a
 * cwd-rooting writer prevents from existing.
 */
const EVALUATION_LOG_NAME = "operator-deferral";
const EVALUATION_TAIL_CHARS = 400;

/**
 * The ask's scanned text, flattened for the evaluation record.
 * {@link extractAskTexts} returns `{ questionTexts, optionTexts }`, not an
 * array — flattening it here keeps that shape in one place.
 */
function askEvaluationText(toolInput: Record<string, unknown> | undefined): string {
  const { questionTexts, optionTexts } = extractAskTexts(toolInput);
  return [...questionTexts, ...optionTexts].join(" | ");
}

/**
 * The unit that was evaluated. The two are NOT the same grain and the stream
 * says so rather than conflating them (PR #2659 R1): the prose surfaces
 * evaluate once per completed TURN at `UserPromptSubmit`, while the ask surface
 * evaluates once per `AskUserQuestion` TOOL CALL at `PreToolUse`. A miss rate
 * computed over a mixed denominator would be meaningless, so anything reading
 * this log must group by `evaluated`.
 */
export type EvaluatedUnit = "prose-turn" | "ask-tool-call";

export function buildEvaluationRecord(
  sessionId: string | undefined,
  matches: DeferralMatch[],
  scannedText: string,
  evaluated: EvaluatedUnit = "prose-turn"
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    evaluated,
    fired: matches.length > 0,
    surfaces: matches.map((m) => m.surface),
    text_tail: safeTruncate(scannedText, EVALUATION_TAIL_CHARS, "tail"),
  };
}

export function appendEvaluationRecord(
  cwd: string | undefined,
  record: Record<string, unknown>
): void {
  // mt#3782: `cwd` is the guard's raw input cwd — a FALLBACK, never a root.
  // This used to be `resolve(findRepoRoot(cwd ?? process.cwd()), EVALUATION_LOG)`,
  // which scattered the stream into session workspaces. `logEvaluationRecord`
  // keeps the fail-open-and-report posture this had.
  logEvaluationRecord(EVALUATION_LOG_NAME, record, { fallbackCwd: cwd });
}

/**
 * Build the calibration record. `matches`-shape family (mirrors
 * ask-routing-deferral / constructed-identifier-batch) so the shared sweep
 * parser in `src/domain/calibration/calibration-sweep.ts` reads it without a
 * per-detector branch. `source: "live"` is the mt#2554 coverage-receipt field
 * — it distinguishes a real runtime fire from a replayed fixture, which is how
 * the coverage gate tells a working detector from a dead one.
 */
export function buildCalibrationRecord(
  sessionId: string | undefined,
  matches: DeferralMatch[]
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    injection_enabled: INJECTION_ENABLED,
    source: "live",
    // mt#3781: `phrase` is the sweep's diversity axis, so it carries the PATTERN
    // hit; `context` carries the surrounding prose that used to occupy `phrase`.
    // Both, because the axis needs the first to be meaningful and a human
    // reviewer needs the second to classify the fire at all.
    [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,
    matches: matches.map((m) => ({
      category: m.surface,
      phrase: m.matchedPhrase,
      context: m.context,
    })),
  };
}

function appendCalibrationRecord(cwd: string | undefined, record: Record<string, unknown>): void {
  try {
    const logPath = resolve(findRepoRoot(cwd ?? process.cwd()), CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    process.stderr.write(
      `[operator-deferral-detector] Failed to write calibration log: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

export function buildReminder(matches: DeferralMatch[]): string {
  const lines = ["[operator-deferral-detector] You deferred an action to the principal.", ""];
  for (const m of matches) {
    // Renders `context`, not `matchedPhrase` (mt#3781). Per
    // `guard-feedback-authoring.md`, the quoted-evidence line exists so the
    // agent can recognize a FALSE positive — the surrounding prose does that
    // and a bare pattern hit does not. This is the same text the line rendered
    // before the fix, so the guard's measured `attentionCost` is unchanged.
    lines.push(`  - (${m.surface}) "${m.context}"`);
  }
  lines.push(
    "",
    "Run the capability probe BEFORE deferring, per `user-preferences.mdc §Probe before " +
      "deferring`: `which <cli> && <cli> whoami`; a `<service>:*` skill; `config_get` for the " +
      "named credential; `memory_search` for the service. If any probe returns available, DO " +
      "THE WORK. If all fail, state the probe results inline so the deferral is justified.",
    `Override: set ${OVERRIDE_ENV_VAR}=1 if this is genuinely not a deferral case.`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible entry points (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

function toOutcome(matches: DeferralMatch[], sessionId: string | undefined): GuardOutcome | null {
  if (matches.length === 0) return null;
  const outcome: GuardOutcome = { calibration: buildCalibrationRecord(sessionId, matches) };
  if (INJECTION_ENABLED) outcome.additionalContext = buildReminder(matches);
  return outcome;
}

/** Surface A — UserPromptSubmit: scan the just-completed turn's prose. */
export function run(input: ClaudeHookInput, ctx: DispatchContext): GuardOutcome | null {
  if (isOverridden()) return null;
  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  try {
    const turnLines = extractLastAssistantTurn(lines, ctx.recordedAnchor);
    if (turnLines.length === 0) return null;
    // Surface A then Surface C (mt#3463). Both are prose surfaces over the same
    // turn; each returns at most one match, and a turn that trips both is
    // reported as both — they are different failures, not two names for one.
    const matches = [
      ...detectCapabilityDeferral(turnLines),
      ...detectPermissionDeferral(turnLines),
    ];
    // Recorded for EVERY evaluated turn, including the no-match case — that is
    // the half the calibration log cannot provide (see buildEvaluationRecord).
    appendEvaluationRecord(
      input.cwd,
      buildEvaluationRecord(input.session_id, matches, extractAssistantText(turnLines) ?? "")
    );
    return toOutcome(matches, input.session_id);
  } catch (err) {
    process.stderr.write(
      `[operator-deferral-detector] Detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/**
 * Surface B — PreToolUse on `AskUserQuestion`: inspect the ask being opened.
 *
 * Scans the IN-FLIGHT turn (`extractFinalTurn`) rather than the previous one:
 * the question is "did the agent probe before opening this ask", and the probe
 * (if any) is in the turn currently executing, which has no closing user
 * prompt yet.
 */
export function runAskSurface(input: ToolHookInput, ctx: DispatchContext): GuardOutcome | null {
  if (isOverridden()) return null;

  try {
    const { turnLines } = extractFinalTurn(ctx.transcriptLines ?? []);
    const matches = detectAskDeferral(input.tool_input, turnLines);
    // Recorded here too (PR #2659 R1). A miss on this surface is exactly as
    // invisible as a miss on the prose ones, and the rung question covers the
    // detector as a whole — so leaving it out would have made "every evaluated
    // unit" false, and the recall denominator silently prose-only.
    appendEvaluationRecord(
      input.cwd,
      buildEvaluationRecord(
        input.session_id,
        matches,
        askEvaluationText(input.tool_input),
        "ask-tool-call"
      )
    );
    return toOutcome(matches, input.session_id);
  } catch (err) {
    process.stderr.write(
      `[operator-deferral-detector] Ask-surface detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Standalone entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  let input: ToolHookInput;
  try {
    input = await readInput<ToolHookInput>();
  } catch {
    process.exit(0);
  }

  if (isOverridden()) {
    process.stdout.write(
      `[operator-deferral-detector] OVERRIDE: skip=1 session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  let lines: TranscriptLine[];
  try {
    lines = resolveParentTranscriptLinesForPath(transcriptPath, input.agent_id);
  } catch {
    process.exit(0);
  }
  if (lines.length === 0) process.exit(0);

  let matches: DeferralMatch[] = [];
  try {
    if (input.tool_name === "AskUserQuestion") {
      matches = detectAskDeferral(input.tool_input, extractFinalTurn(lines).turnLines);
      // Mirrors `runAskSurface` (PR #2659 R1) — both entrypoints render this
      // surface, and recording in only one leaves the denominator wrong.
      appendEvaluationRecord(
        input.cwd,
        buildEvaluationRecord(
          input.session_id,
          matches,
          askEvaluationText(input.tool_input),
          "ask-tool-call"
        )
      );
    } else {
      const turnLines = extractLastAssistantTurn(lines);
      if (turnLines.length > 0) {
        // Same two prose surfaces as `run()` (mt#3463). Wiring one entrypoint
        // and not the other is the mt#3270 R1 shape.
        matches = [...detectCapabilityDeferral(turnLines), ...detectPermissionDeferral(turnLines)];
        appendEvaluationRecord(
          input.cwd,
          buildEvaluationRecord(input.session_id, matches, extractAssistantText(turnLines) ?? "")
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `[operator-deferral-detector] Detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }

  if (matches.length === 0) process.exit(0);

  appendCalibrationRecord(input.cwd, buildCalibrationRecord(input.session_id, matches));

  if (!INJECTION_ENABLED) process.exit(0);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildReminder(matches),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
