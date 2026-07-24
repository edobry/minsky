#!/usr/bin/env bun
// Operator-deferral detector (mt#2459) — two calibration-first, LOG-ONLY
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
// double-count in two calibration logs. This detector owns the two surfaces
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
//
// Both surfaces are LOG-ONLY in v1 (`INJECTION_ENABLED = false`), per the
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
  parseTranscript,
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
import { elideQuotedContexts } from "./elision";
// Surrogate-pair-safe truncation — the matched text is arbitrary assistant
// prose / operator-authored option labels, so a raw `.slice(0, N)` can split
// an emoji. Same cross-tree import the standalone parallel-work guard uses.
import { safeTruncate } from "../../src/utils/safe-truncate";

/** Max chars of matched text carried into a calibration record. */
const MATCH_EXCERPT_MAX_CHARS = 200;

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

export type DeferralSurface = "capability-deferral-prose" | "ask-option-label";

export interface DeferralMatch {
  surface: DeferralSurface;
  matchedPhrase: string;
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
 */
export function detectCapabilityDeferral(turnLines: TranscriptLine[]): DeferralMatch[] {
  const text = extractAssistantText(turnLines);
  if (!text) return [];
  if (hasProbeEvidence(turnLines)) return [];

  const scanned = elideQuotedContexts(text);
  for (const pattern of CAPABILITY_DEFERRAL_PATTERNS) {
    const m = pattern.exec(scanned);
    if (m) {
      const idx = m.index ?? 0;
      const snippet = scanned.slice(Math.max(0, idx - 20), idx + m[0].length + 60).trim();
      return [
        {
          surface: "capability-deferral-prose",
          matchedPhrase: safeTruncate(snippet, MATCH_EXCERPT_MAX_CHARS, "head"),
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
    for (const pattern of ASK_PRINCIPAL_ACTION_PATTERNS) {
      const m = pattern.exec(text);
      if (m) {
        return [
          {
            surface: "ask-option-label",
            matchedPhrase: safeTruncate(text, MATCH_EXCERPT_MAX_CHARS, "head"),
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
    matches: matches.map((m) => ({ category: m.surface, phrase: m.matchedPhrase })),
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
    lines.push(`  - (${m.surface}) "${m.matchedPhrase}"`);
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
    const turnLines = extractLastAssistantTurn(lines);
    if (turnLines.length === 0) return null;
    return toOutcome(detectCapabilityDeferral(turnLines), input.session_id);
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
    return toOutcome(detectAskDeferral(input.tool_input, turnLines), input.session_id);
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
    lines = parseTranscript(transcriptPath);
  } catch {
    process.exit(0);
  }
  if (lines.length === 0) process.exit(0);

  let matches: DeferralMatch[] = [];
  try {
    if (input.tool_name === "AskUserQuestion") {
      matches = detectAskDeferral(input.tool_input, extractFinalTurn(lines).turnLines);
    } else {
      const turnLines = extractLastAssistantTurn(lines);
      if (turnLines.length > 0) matches = detectCapabilityDeferral(turnLines);
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
