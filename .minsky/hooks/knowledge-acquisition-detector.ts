#!/usr/bin/env bun
// Stop hook: detect in-task research (WebSearch / WebFetch / knowledge
// tools) that surfaces knowledge relevant to a currently-loaded skill, with no
// propagation action (memory_create / `/learn` / tasks_create targeting the
// artifact) ANYWHERE in the session — the (B) proactive-trigger half of the
// learn-capture primitive designed in mt#2707.
//
// SESSION-GRAIN (mt#3720): v1 (mt#2708) judged each research call in isolation
// on UserPromptSubmit, with a `TRAILING_WINDOW_TURNS`-turn grace period before
// judging a miss. That design produced 13 of the 17 fires reviewed at ask#6891
// from ONE session (`aecd65f4`) whose research DID propagate — just far later
// than the 5-turn grace covered, so the per-occurrence dedupe locked in a miss
// verdict before the eventual save existed in the visible transcript. The
// propagation SCAN was never the problem (`hasPropagationAfter` was already
// unbounded — it scans to the end of whatever transcript is visible); the
// problem was WHEN evaluation happened: as soon as grace elapsed, using only
// the transcript visible AT THAT MOMENT. v2 evaluates the whole session's
// research as ONE aggregate verdict, gated on a SINGLE session-level dedupe key
// (`SESSION_VERDICT_DEDUPE_KEY`) instead of a per-occurrence key — so a session
// can fire at most once, ever, rather than once per unresolved research call.
//
// Why Stop, not SessionEnd: SessionEnd has zero guards wired through this
// dispatcher framework (`registry.ts`'s `GUARD_REGISTRY`) — the repo's one
// SessionEnd hook (`transcript-ingest-on-session-end.ts`) is wired directly in
// `.claude/settings.json`, bypassing the calibration/canary/override plumbing
// this detector depends on, so building a SessionEnd dispatcher entrypoint is
// out of scope for a re-grain. Per ADR-017, `/exit` and `/clear` do not fire
// SessionEnd at all, so its absence proves nothing there either. Stop already
// hosts five guards on the same dispatcher, including a directly-analogous
// calibration-first, log-only sibling (`stop-at-decision-scan`, mt#3653), and
// firing once per TURN means at least one Stop invocation sees a killed session
// where SessionEnd would see none. The tradeoff this accepts: per-session
// dedupe is now load-bearing, because Stop — unlike SessionEnd — fires
// repeatedly across one session, so a session that goes quiet for
// `TRAILING_WINDOW_TURNS` turns and only then propagates can have a miss
// verdict recorded first, and the dedupe key makes that verdict permanent.
// mt#3740 owns that residual; the once-per-session BOUND holds regardless,
// which is what retires the 13-records-from-one-session shape.
//
// CALIBRATION-ONLY (mt#2263 ladder): still ships with INJECTION_ENABLED=false — logs
// a calibration JSONL record and injects NOTHING, mirroring
// build-claim-injection-detector.ts / causal-premise-detector.ts. Graduation
// contract: `CALIBRATION_LOG_REGISTRY`'s `knowledge-acquisition` entry
// (`src/domain/calibration/calibration-sweep.ts`) declares `kind:
// "knowledge-acquisition"`, `reviewByDays: 14`, and a diversity axis of distinct
// `loadedSkills` (wired into `extractDistinctPhrases`) so the log cannot sit
// `lowDiversity` forever (the mt#2896 under-threshold-forever trap, reopened on
// the diversity axis rather than the count axis).
//
// Detection mechanism (mt#2263 ladder — cheapest-sufficient-first): rung 1
// ("a research tool ran, filtered to sessions where a skill was loaded") FUSED
// WITH a rung-2-lite skill-keyword overlap gate. Bare rung 1 is close to a
// no-op — skill bodies load into session context on first invocation and stay
// cached for the WHOLE session (skill-staleness-detector.ts), and nearly every
// non-trivial session invokes at least one management skill — so rung 1 alone
// cannot discriminate "this research is relevant to the loaded skill's domain"
// from "this research is about anything at all." The gate: match
// fetched-content/URL/prior-turn text against the SPECIFIC loaded skill's own
// name + frontmatter-description keywords (read from
// `.claude/skills/<name>/SKILL.md`). This stays rung-1-cheap — no LLM call.
//
// Session verdict: every research occurrence passing the rung-1+2-lite gate is
// collected, and the session becomes eligible for a verdict once at least
// `TRAILING_WINDOW_TURNS` turns have elapsed since the MOST RECENT matched
// occurrence — a deferral if not yet due, not a suppression (the mt#2671
// grace-period pattern shipped for pre-narration-detector.ts, applied once per
// session instead of once per occurrence). An agent that says "I'll capture
// this after finishing the current edit," then does so later, is a TRUE
// NEGATIVE, and under session grain it stays one no matter how much later.
// Once eligible, the session's verdict is `hadPropagation: true` iff a
// propagation call appears after the session's LAST matched occurrence in the
// currently visible transcript. So a miss means "the session ended with research
// that was never followed by any capture."
//
// This sentence used to claim EVERY occurrence needed its own propagation call —
// "one uncaptured piece of research is enough to make the verdict a miss." The
// code never did that (mt#3901): `hasPropagationAfter` is unbounded and therefore
// monotone in position, so the `every` collapsed to the single last-occurrence
// check now written at the verdict site. The strict per-occurrence reading needs
// topical relation between a capture and a research call, which ADR-024 puts at
// rung 3 and mt#3783 owns.
//
// The whole-session-scan widening (loaded skills + research occurrences,
// rather than just the last turn) mirrors build-claim-injection-detector.ts's
// `findDeploySurfaceEditPaths` widening of substrate-bypass-detector.ts's
// turn-scoped `extractSkillToolInvocations` — this file duplicates and widens
// that same helper (the sibling-detector duplication practice: duplicate small
// helpers across detector files rather than cross-import between sibling
// detectors, per build-claim-injection-detector.ts's own `collectStrings`
// comment). That practice is about DETECTOR-TO-DETECTOR imports and is
// unaffected by mt#4373, which retired the separate hooks-tree convention
// against importing `packages/domain`. Naming both "the hooks-tree convention"
// is what made them easy to confuse; they were always two different rules.
//
// Tool-result lines carry role "user" (memory a3e60471) — this detector's
// whole signal is tool calls interleaved with text, so it is maximally exposed
// to that trap. Uses the SHARED `.minsky/hooks/transcript.ts` helpers
// (`findRealPromptIndices`, `isRealUserPrompt`, `extractAssistantText`,
// `extractToolUseNames`, `readLogTailText`) exclusively — never a local copy.
//
// INJECTION_ENABLED must be false — this is calibration-only. Fail posture is
// open: silent on any transcript read/parse error, never blocks.
//
// @see mt#3720 — the session-grain re-grain (this revision)
// @see mt#2708 — the originating per-call v1
// @see mt#2707 — the originating RFC (Notion 3a0937f0-3cb4-81a6-8699-e419a5ce4da0)
// @see mt#2671 — the trailing-window suppression pattern (pre-narration-detector.ts)
// @see mt#3207 — the census semantics this revision preserves (both miss and
//   propagation-found records still emit)
// @see mt#2357 — the Stop-event dispatcher this revision now registers against
// @see mt#2896 — the never-reviewed-aging cadence leg the graduation contract depends on
// @see mt#3078 — the proven-alive liveSinceDate re-anchoring precedent
// @see .minsky/hooks/stop-at-decision-scan.ts — calibration-first Stop-guard precedent
// @see .minsky/hooks/substrate-bypass-detector.ts — `extractSkillToolInvocations` origin (turn-scoped)
// @see .minsky/hooks/build-claim-injection-detector.ts — whole-session-widening precedent + calibration-first shape
// @see .minsky/hooks/pre-narration-detector.ts — trailing-window suppression precedent
// @see .minsky/hooks/transcript.ts — shared turn-boundary + tool-use helpers

import { readInput, readHostCap, deriveBudgets, findRepoRoot } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  resolveParentTranscriptLinesForPath,
  extractAssistantText,
  extractToolUseNames,
  findRealPromptIndices,
  isRealUserPrompt,
  readLogTailText,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";
import { ensureHookDomainBootstrap } from "./domain-bootstrap";
import { nominate } from "../../packages/domain/src/detectors/embedding-nomination";
import type {
  ExemplarSet,
  Nomination,
  NominationDeps,
} from "../../packages/domain/src/detectors/embedding-nomination";
import { resolveNominationDeps } from "../../packages/domain/src/detectors/embedding-nomination-factory";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection
// ---------------------------------------------------------------------------

/**
 * When false (v1/calibration mode), the hook logs matches to JSONL and
 * injects NO additionalContext. Flip to true only after a `/calibration-review`
 * pass on the accumulated log (mt#2263 ladder) — the graduation contract is
 * declared via `reviewByDays: 14` on this detector's `CALIBRATION_LOG_REGISTRY`
 * entry (`src/domain/calibration/calibration-sweep.ts`).
 */
export const INJECTION_ENABLED = false;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_KNOWLEDGE_ACQUISITION";

/**
 * Calibration log path (repo-root relative). Named after the detector/guard
 * module (`knowledge-acquisition-detector.ts`, per this task's Scope
 * Constraints) rather than the "learn-capture" label used in the task's
 * Summary prose — the dispatcher's D4 `calibrationLogPath()` derives the
 * on-disk filename from the registry's `calibrationLog` name
 * (`.minsky/${name}-calibration.jsonl`), so this constant MUST match the
 * `calibrationLog: "knowledge-acquisition"` registration in `./registry.ts`
 * and the `CALIBRATION_LOG_REGISTRY` entry's `path` in
 * `src/domain/calibration/calibration-sweep.ts` exactly.
 */
export const CALIBRATION_LOG = ".minsky/knowledge-acquisition-calibration.jsonl";

/**
 * Reason string for this detector's ONE recorded suppression gate — research
 * whose knowledge WAS propagated somewhere in the session (mt#3207; scope
 * widened from "trailing window" to "whole session" by mt#3720, which is why
 * the value's `-in-window` suffix now reads as historical: it is kept verbatim
 * so the accumulated calibration corpus stays parseable across the re-grain).
 *
 * The detection path has three other skip legs, none of which is a suppression
 * of a completed detection and none of which records: the already-recorded
 * session ({@link SESSION_VERDICT_DEDUPE_KEY}), the missing loaded-skill
 * keyword overlap (part of the rung-2-lite DETECTION criterion), and the grace
 * period before the session is eligible for a verdict (a deferral —
 * non-terminal, re-evaluated next invocation; recording it would fire every
 * turn AND burn the dedupe key that the eventual real fire needs). See
 * mt#3207's `## Design decisions` §D2.
 */
export const SUPPRESSION_PROPAGATION_IN_WINDOW = "propagation-in-window";

/**
 * Research-tool names whose invocation is rung 1's candidate signal —
 * in-task research per the mt#2707 RFC's scope (WebSearch / WebFetch /
 * knowledge tools).
 */
export const RESEARCH_TOOL_NAMES: readonly string[] = [
  "WebSearch",
  "WebFetch",
  "mcp__minsky__knowledge_fetch",
  "mcp__minsky__knowledge_search",
  "mcp__minsky__knowledge_sync",
];

/**
 * Propagation tool names — a call to any of these after a matched research
 * event suppresses the fire (the acquisition WAS captured). `tasks_create`
 * covers "a filed task targeting the artifact" per the spec; a Skill
 * invocation whose name contains "learn" (the mt#2709 `/learn` routing skill)
 * is checked separately in {@link hasPropagationAfter} since Skill
 * invocations aren't named by tool name alone.
 *
 * **The channel set is an OR across destinations, not a ranking (mt#3272).**
 * The test for membership is "does a call to this tool mean the research
 * landed somewhere durable that a future reader will find?" — not "is this the
 * BEST place for it." Two dispositions (ask#6136 `tune-both`, ask#6817
 * "approve both tunes") directed widening it beyond the memory/task pair,
 * because research that lands in the artifact it was FOR was reading as
 * "never written down."
 *
 * The spec-writing entries are that widening. A `/plan-task` session's research
 * goes into the task spec; a `/draft-rfc` session's goes into the RFC. Both are
 * durable, both are the canonical destination for that work, and neither calls
 * `memory_create`. Measured on the 2026-08-03 sweep: 11 fires across two
 * sessions, and BOTH sessions had written their findings into task specs —
 * `aecd65f4` via four spec edits, `0e0d6b66` via thirteen.
 *
 * **What is deliberately NOT here:** `session_write_file` / `session_edit_file`
 * and the other source-editing tools. Writing code is not capturing research
 * about it, and admitting them would make the detector fire on approximately
 * nothing — the same over-widening that would follow from treating every write
 * as propagation.
 *
 * Recording an artifact does not make writing a memory unnecessary — mt#3272's
 * spec preserves that distinction explicitly ("an RFC is a propagation
 * destination for the *argument*, not necessarily for every reusable mechanism
 * discovered while writing it"). This set answers the narrower question the
 * detector asks.
 */
export const PROPAGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mcp__minsky__memory_create",
  "mcp__minsky__tasks_create",
  // Spec-writing: the destination for research done inside /plan-task and
  // /create-task, which is where this detector's own fires concentrate.
  "mcp__minsky__tasks_spec_patch",
  "mcp__minsky__tasks_spec_search_replace",
  // Memory revision — updating an existing entry captures an acquisition
  // exactly as creating one does.
  "mcp__minsky__memory_update",
]);

/**
 * Grace period in TURNS (mt#2671 pattern, pre-narration-detector.ts) before the
 * SESSION becomes eligible for a verdict. mt#3720 applies it ONCE, against the
 * most recent matched research occurrence, rather than once per occurrence as
 * v1 did. Smaller than pre-narration's 12-turn back-reference window:
 * propagation here is a single atomic call (`memory_create` / `/learn` /
 * `tasks_create`), not a multi-step external convergence process
 * (wait-for-review -> fix -> push -> back-reference), so a shorter grace period
 * is sufficient to distinguish "will capture after finishing the current edit"
 * (true negative) from "never captured" (a miss).
 *
 * This bounds only WHEN evaluation happens, never how far the propagation scan
 * looks: {@link hasPropagationAfter} is unbounded, scanning to the end of
 * whatever transcript is currently visible. A session with continuing matched
 * research keeps re-extending its own eligibility clock; a genuinely idle
 * session becomes eligible after this many turns of silence.
 */
export const TRAILING_WINDOW_TURNS = 5;

/**
 * Fixed session-level dedupe key (mt#3720). v1 deduped per RESEARCH OCCURRENCE
 * (`${lineIdx}:${toolName}`), which is exactly what let one session fire 13
 * times: each occurrence carried its own key, so grace elapsing on occurrence N
 * did not stop occurrence N+1 from independently re-firing. v2 dedupes per
 * SESSION — this one key is checked against the calibration log's own tail via
 * {@link loadLoggedSessionState}, which filters by `session_id`, so the
 * constant is safe to share across sessions and a session produces at most one
 * record regardless of how many research occurrences it contains or how many
 * times the Stop hook fires.
 */
export const SESSION_VERDICT_DEDUPE_KEY = "session-verdict";

// ---------------------------------------------------------------------------
// Small duplicated helpers (the sibling-detector duplication practice — see
// header; NOT the packages/domain self-containment convention, retired mt#4373)
// ---------------------------------------------------------------------------

/** Recursively collect every string value reachable from `value` into `out`. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract `Skill` tool invocation names ANYWHERE in `lines` — the whole-
 * session widening of `substrate-bypass-detector.ts`'s turn-scoped
 * `extractSkillToolInvocations` (that file's own, non-exported, turn-scoped
 * helper), mirroring `build-claim-injection-detector.ts`'s
 * `findDeploySurfaceEditPaths` widening. Duplicated rather than imported.
 *
 * mt#4373: the convention this cited — a self-contained hooks tree — is retired,
 * and this module already imports `packages/domain` elsewhere, so the stated
 * reason did not describe the file even before that. The duplication is now an
 * ordinary judgment call, and a candidate to collapse: a copy that drifts from
 * its origin is the mt#4330 hazard, and this one tracks a domain function that
 * is already reachable from here.
 */
function extractSkillInvocationsWholeSession(lines: TranscriptLine[]): string[] {
  const skillNames: string[] = [];
  const checkBlock = (block: Record<string, unknown>): void => {
    if (block["type"] !== "tool_use") return;
    if (block["name"] !== "Skill") return;
    const input = block["input"] as Record<string, unknown> | undefined;
    if (!input) return;
    const skill = input["skill"];
    if (typeof skill === "string") skillNames.push(skill);
  };
  for (const line of lines) {
    if (line.type === "tool_use" && (line.name === "Skill" || line.tool_name === "Skill")) {
      const skill = line.input?.["skill"];
      if (typeof skill === "string") skillNames.push(skill);
    }
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        checkBlock(block);
      }
    }
  }
  return skillNames;
}

// ---------------------------------------------------------------------------
// Frontmatter-description keyword extraction (rung-2-lite gate)
// ---------------------------------------------------------------------------

/** Generic words excluded from description-derived keywords (too weak a discriminator on their own). */
const SKILL_KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "again",
  "against",
  "because",
  "before",
  "being",
  "between",
  "could",
  "doing",
  "during",
  "every",
  "first",
  "having",
  "itself",
  "other",
  "should",
  "their",
  "there",
  "these",
  "those",
  "through",
  "under",
  "until",
  "using",
  "where",
  "which",
  "while",
  "would",
  "skill",
  "skills",
  "provides",
  "structural",
  "patterns",
  "reading",
  "writing",
  "working",
  "intended",
]);

/**
 * Parse a Minsky skill's compiled SKILL.md frontmatter and extract the
 * `description:` field's text — handles both an inline scalar
 * (`description: foo`) and a YAML block scalar (`description: >-` /
 * `description: |` followed by indented continuation lines, the shape
 * `bun run minsky compile` actually emits). Pure (no I/O) — exported for
 * independent testing.
 */
export function extractFrontmatterDescription(content: string): string {
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return "";
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return "";
  const fm = lines.slice(1, endIdx);
  const descIdx = fm.findIndex((l) => /^description:\s*/i.test(l));
  if (descIdx === -1) return "";
  const descLine = fm[descIdx] ?? "";
  const inline = descLine.replace(/^description:\s*/i, "").trim();
  const isBlockScalar = inline === "" || /^[>|][-+]?$/.test(inline);
  if (!isBlockScalar) {
    return inline.replace(/^["']|["']$/g, "");
  }
  const collected: string[] = [];
  for (let i = descIdx + 1; i < fm.length; i++) {
    const raw = fm[i] ?? "";
    if (raw.trim().length === 0) continue;
    if (/^\s/.test(raw)) {
      collected.push(raw.trim());
    } else {
      break;
    }
  }
  return collected.join(" ");
}

/**
 * Derive the significant keyword set for a loaded skill: its own name
 * (hyphen/underscore-split, tokens >= 4 chars) plus distinctive words (>= 5
 * chars, not a stopword) from its frontmatter description. Pure — exported
 * for independent testing (the impure disk read lives in
 * {@link readSkillDescription}, kept separate per `custom/no-real-fs-in-tests`).
 */
export function extractSkillKeywords(skillName: string, description: string): string[] {
  const words = new Set<string>();
  for (const part of skillName.split(/[-_]/)) {
    const clean = part.toLowerCase();
    if (clean.length >= 4) words.add(clean);
  }
  const tokens = description.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
  for (const raw of tokens) {
    const clean = raw.replace(/^[-']+|[-']+$/g, "");
    if (clean.length >= 5 && !SKILL_KEYWORD_STOPWORDS.has(clean)) {
      words.add(clean);
    }
  }
  return [...words];
}

/** Return the first keyword found (whole-word, case-insensitive) in `texts`, or undefined. */
function findKeywordOverlap(texts: string[], keywords: string[]): string | undefined {
  const haystack = texts.join(" \n ").toLowerCase();
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (re.test(haystack)) return kw;
  }
  return undefined;
}

/** Width of the candidate-text window recorded alongside a match. */
const MATCH_EXCERPT_CHARS = 400;

/**
 * Where a matched keyword came from. `"name"` means the token is one of the
 * skill NAME's `[-_]`-split segments; anything else came from the frontmatter
 * description. A token present in BOTH is labeled `"name"`: the name is the
 * more distinctive provenance, and knowing the description repeats it does not
 * change what a reader would conclude.
 */
export type KeywordSource = "name" | "description";

export interface KeywordHit {
  skill: string;
  keyword: string;
  source: KeywordSource;
}

/** True when `keyword` is one of `skillName`'s hyphen/underscore-split tokens. */
export function isNameDerivedKeyword(skillName: string, keyword: string): boolean {
  const target = keyword.toLowerCase();
  return skillName.split(/[-_]/).some((part) => {
    const clean = part.toLowerCase();
    return clean.length >= 4 && clean === target;
  });
}

/**
 * EVERY keyword of `keywords` present in `texts`, with its provenance — not
 * just the first.
 *
 * Deliberately separate from {@link findKeywordOverlap}, which returns the
 * FIRST hit and is what selects `matchedSkill` / `matchedKeyword`. Keeping the
 * two apart is the point: this function is instrumentation, and nomination
 * behavior must not drift when it changes (mt#3617).
 *
 * Why it exists: the record used to carry only the first hit, so no
 * alternative nomination mechanism — multi-hit agreement, name-vs-description
 * provenance, per-token specificity — could be evaluated against the logged
 * corpus at all. A measured corpus-document-frequency filter was falsified
 * during mt#3617's planning precisely because the log could not distinguish
 * these cases.
 */
export function findAllKeywordOverlaps(
  skill: string,
  texts: string[],
  keywords: string[]
): KeywordHit[] {
  const haystack = texts.join(" \n ").toLowerCase();
  const hits: KeywordHit[] = [];
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (re.test(haystack)) {
      hits.push({
        skill,
        keyword: kw,
        source: isNameDerivedKeyword(skill, kw) ? "name" : "description",
      });
    }
  }
  return hits;
}

/**
 * The outcome of asking Rung 2 which loaded skill a research turn is about.
 *
 * `none` and `degraded` are deliberately distinct: `none` means the nominator
 * RAN and nothing cleared the threshold (a real negative — this research is not
 * about any loaded skill), while `degraded` means it could not run at all. Only
 * the second falls back to lexical matching, per ADR-024's "fail to Rung 1,
 * never silent-skip" invariant. Collapsing them would silently convert a real
 * negative into a lexical fire, which is the noise this task exists to remove.
 */
/**
 * Total wall-clock a session verdict may spend on Rung-2 nomination.
 *
 * Derived, not chosen: this guard registers `timeoutMs: 10000` on `Stop`
 * (`registry.ts`), and the detector still has to finish its propagation scan
 * and write its record after nomination returns. 6000ms leaves 4000ms of
 * headroom for that tail, and admits three worst-case 2000ms nominations —
 * comfortably above the observed per-session occurrence count, while bounding
 * the degenerate long-research session that would otherwise blow the budget.
 *
 * Do NOT raise this to accommodate more occurrences. The fix for a session that
 * needs more nominations than this affords is a cheaper nomination (batching,
 * one aggregated call), not a larger slice of a budget the dispatcher enforces.
 */
export const NOMINATION_SESSION_BUDGET_MS = 6000;

/**
 * Whether the session's nomination budget is spent. Pure and injected-clock so
 * the bound is testable without burning six real seconds — observing it
 * otherwise would mean patching the global clock, which is the design smell the
 * testable-design checkpoint names.
 */
export function isNominationBudgetExhausted(deadlineMs: number, nowMs: number): boolean {
  return nowMs >= deadlineMs;
}

export type SkillNominationOutcome =
  | { kind: "nominated"; skill: string; score: number; segment: string }
  | { kind: "none" }
  | { kind: "degraded"; reason: string };

/**
 * Injected Rung-2 nominator: scores the research text against each loaded
 * skill's description and returns the best match above threshold.
 *
 * Injected rather than imported so the detector stays testable without a live
 * embedding provider — the same functional-core/imperative-shell split the
 * module already uses for `skillKeywordsByName`, whose disk read lives in the
 * caller. The impure resolution (`ensureHookDomainBootstrap` +
 * `resolveNominationDeps`) belongs to `run()` / `main()`.
 */
export type SkillNominator = (
  candidateTexts: string[],
  loadedSkills: string[]
) => Promise<SkillNominationOutcome>;

/**
 * A bounded window of candidate text centered on `keyword`'s first occurrence,
 * so a reviewer can judge whether the research was topically related to the
 * skill instead of inferring it from the bare token. Bounded like
 * `turn-end-untaken-action-scan`'s `final_message_tail`, for the same reason.
 */
export function buildMatchExcerpt(
  texts: string[],
  keyword: string | undefined
): string | undefined {
  if (!keyword) return undefined;
  const haystack = texts.join(" \n ");
  const at = haystack.toLowerCase().indexOf(keyword.toLowerCase());
  if (at === -1) return undefined;
  const start = Math.max(0, at - Math.floor(MATCH_EXCERPT_CHARS / 2));
  return haystack.slice(start, start + MATCH_EXCERPT_CHARS);
}

/**
 * Read a loaded skill's compiled SKILL.md frontmatter description from disk.
 * Impure (fs read) — never throws; returns "" on any error (missing skill
 * dir, unreadable file, malformed frontmatter). Resolves relative to the
 * repo root (`findRepoRoot(cwd)`), matching every sibling calibration log's
 * path-resolution convention.
 */
function readSkillDescription(cwd: string, skillName: string): string {
  try {
    const root = findRepoRoot(cwd);
    const skillPath = resolve(root, ".claude", "skills", skillName, "SKILL.md");
    if (!existsSync(skillPath)) return "";
    return extractFrontmatterDescription(readFileSync(skillPath, "utf-8"));
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Grace-period helpers (pure) — session-grain since mt#3720
// ---------------------------------------------------------------------------

interface ResearchOccurrence {
  /** Index into the FULL `lines` array of the line carrying this tool_use. */
  idx: number;
  toolName: string;
  /** Every string value reachable from the tool_use's own `input` object. */
  texts: string[];
}

/**
 * A research occurrence that cleared the rung-1+2-lite keyword gate, carrying
 * the skill it matched and the texts the match was found in (mt#3720). The
 * session verdict aggregates over a list of these; v1 had no equivalent because
 * it returned on the first match instead of collecting them.
 */
interface MatchedResearchOccurrence {
  occ: ResearchOccurrence;
  matchedSkill: string;
  /**
   * On the lexical path this is the matched KEYWORD; on the Rung-2 path it is
   * the matched candidate SEGMENT. One field because both answer "what text
   * tied this occurrence to that skill?" — `detectionRung` on the record says
   * which kind it is, so a reader is never left guessing.
   */
  matchedKeyword: string;
  candidateTexts: string[];
  /** Rung-2 similarity; absent on the lexical path (mt#3772). */
  score?: number;
}

/** Find every research-tool tool_use occurrence ANYWHERE in `lines` (whole-session scan). */
function findResearchOccurrences(lines: TranscriptLine[]): ResearchOccurrence[] {
  const occurrences: ResearchOccurrence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (n && RESEARCH_TOOL_NAMES.includes(n)) {
        const texts: string[] = [];
        collectStrings(line.input, texts);
        occurrences.push({ idx: i, toolName: n, texts });
      }
    }
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (
          block &&
          block["type"] === "tool_use" &&
          typeof block["name"] === "string" &&
          RESEARCH_TOOL_NAMES.includes(block["name"] as string)
        ) {
          const texts: string[] = [];
          collectStrings(block["input"], texts);
          occurrences.push({ idx: i, toolName: block["name"] as string, texts });
        }
      }
    }
  }
  return occurrences;
}

/** Count real-user-prompt boundaries strictly AFTER `fromIdx` — "turns elapsed since". */
function countPromptBoundariesAfter(lines: TranscriptLine[], fromIdx: number): number {
  let count = 0;
  for (let i = fromIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && isRealUserPrompt(line)) count++;
  }
  return count;
}

/**
 * True iff a propagation tool call (memory_create / tasks_create / a `/learn`
 * Skill invocation) appears ANYWHERE after `fromIdx`.
 */
function hasPropagationAfter(lines: TranscriptLine[], fromIdx: number): boolean {
  const after = lines.slice(fromIdx + 1);
  if (extractToolUseNames(after).some((n) => PROPAGATION_TOOL_NAMES.has(n))) return true;
  const skills = extractSkillInvocationsWholeSession(after);
  return skills.some((s) => s.toLowerCase().includes("learn"));
}

/** Extract the assistant text of the logical turn ENCLOSING line index `idx`. */
function extractEnclosingTurnText(
  lines: TranscriptLine[],
  promptIndices: number[],
  idx: number
): string {
  let start = 0;
  let end = lines.length;
  for (const p of promptIndices) {
    if (p <= idx) {
      start = p + 1;
    } else {
      end = p;
      break;
    }
  }
  return extractAssistantText(lines.slice(start, end));
}

// ---------------------------------------------------------------------------
// Core detector (pure, exported for testing)
// ---------------------------------------------------------------------------

export interface KnowledgeAcquisitionResult {
  matched: boolean;
  /**
   * Which rung ACTUALLY produced this verdict (mt#3772): `"2-embedding"` when
   * Rung-2 nomination ran and decided, `"1-lexical"` when the keyword gate did
   * — either because no nominator was supplied or because Rung 2 degraded.
   *
   * Was the hardcoded literal `"1+2-lite"` until mt#3772; mt#3199 criterion 5
   * flagged it as a constant that could not vary, which made it a restatement
   * of the code path rather than a measurement of it.
   */
  detectionRung: string;
  researchTools: string[];
  loadedSkills: string[];
  matchedSkill?: string;
  matchedKeyword?: string;
  /**
   * EVERY keyword hit across EVERY loaded skill (mt#3617). `matchedSkill` /
   * `matchedKeyword` remain the nomination — the first hit — and this is the
   * full evidence set behind it, so a candidate nomination mechanism can be
   * measured against the logged corpus rather than guessed at.
   */
  keywordHits: KeywordHit[];
  /** Bounded candidate-text window around the matched keyword (mt#3617). */
  matchedTextExcerpt?: string;
  /**
   * Rung-2 similarity for the nominating occurrence (mt#3772). Absent when the
   * verdict came from the lexical fallback, which is how a reader tells the two
   * apart without parsing `detectionRung`.
   */
  nominationScore?: number;
  /**
   * Why Rung 2 could not run, when it could not (mt#3772). Present ONLY on the
   * fallback path — its presence is the ADR-024 "degraded marker", and its
   * absence on a `rung-1-lexical` record would mean the fallback happened
   * silently, which the invariant forbids.
   */
  degradedReason?: string;
  hadPropagation: boolean;
}

/**
 * The verdict this session already has in the calibration log, if any (mt#3740).
 *
 * `timestamp` identifies the record being revised; it is what a superseding
 * record points at, and what the sweep matches on to drop the stale one.
 */
export interface PriorSessionVerdict {
  hadPropagation: boolean;
  timestamp: string;
}

export interface KnowledgeAcquisitionDetection {
  result: KnowledgeAcquisitionResult;
  /** Session-grain dedupe key (mt#3720: always {@link SESSION_VERDICT_DEDUPE_KEY}) so a session is logged at most once PER VERDICT (mt#3740 relaxed "ever"). */
  dedupeKey: string;
  /**
   * Timestamp of the record this one revises (mt#3740). Set only when the
   * session already had a verdict and the new one DIFFERS; absent on a first
   * record. Its presence is what lets a reader — and the calibration sweep —
   * see a revision instead of inferring one from ordering.
   */
  supersedes?: string;
  /**
   * Empty when this detection injects; `[SUPPRESSION_PROPAGATION_IN_WINDOW]`
   * when a gate swallowed it (mt#3207).
   */
  suppressionReasons: string[];
}

/**
 * Detect in-task research relevant to a loaded skill, with no propagation
 * anywhere in the session, as ONE session-grain verdict (mt#3720).
 *
 * @param lines - the FULL session transcript (whole-session scan, not
 *   turn-scoped — mirrors build-claim-injection-detector.ts's widening).
 * @param loadedSkills - distinct skill names loaded anywhere in the session
 *   (rung 1's session-level filter).
 * @param skillKeywordsByName - pre-resolved keyword set per loaded skill
 *   (impure disk read happens in the caller; this function stays pure).
 * @param alreadyLoggedDedupeKeys - dedupe keys already written to the
 *   calibration log THIS session; checked against the single
 *   {@link SESSION_VERDICT_DEDUPE_KEY} so a session records at most once.
 * @param windowTurns - grace period in turns, applied once against the most
 *   recent matched occurrence (mt#2671 pattern, re-scoped to session grain).
 */
export async function detectKnowledgeAcquisition(
  lines: TranscriptLine[],
  loadedSkills: string[],
  skillKeywordsByName: ReadonlyMap<string, string[]>,
  alreadyLoggedDedupeKeys: ReadonlySet<string>,
  windowTurns: number = TRAILING_WINDOW_TURNS,
  nominateSkill?: SkillNominator,
  priorVerdict?: PriorSessionVerdict | null
): Promise<KnowledgeAcquisitionDetection | null> {
  // mt#3720 bounded a session to one record; mt#3740 relaxes that from "ever"
  // to "per verdict". Stop fires per TURN against a GROWING transcript, so the
  // first verdict is formed on a partial session: a miss recorded at turn 8 was
  // simply the truth at turn 8, and a memory_create at turn 19 makes it stale
  // rather than wrong. The old gate returned here, which froze that stale answer
  // in the log forever.
  //
  // The decision therefore cannot be made before the verdict exists — it is a
  // comparison, not a presence check — so it moved below, next to
  // `hadPropagation`. Cost of moving it: an already-recorded session now runs
  // the matching pass on every Stop instead of returning immediately. The
  // transcript read is the caller's and was paid either way; what is added is
  // the in-memory scan, which is the irreducible price of being able to notice
  // that the verdict changed.
  const alreadyRecorded = alreadyLoggedDedupeKeys.has(SESSION_VERDICT_DEDUPE_KEY);
  // No prior verdict to compare against — a caller that does not supply one
  // keeps mt#3720's exact behavior rather than silently recording twice.
  if (alreadyRecorded && !priorVerdict) return null;

  if (loadedSkills.length === 0) return null;

  const occurrences = findResearchOccurrences(lines);
  if (occurrences.length === 0) return null;

  const researchTools = [...new Set(occurrences.map((o) => o.toolName))];
  const promptIndices = findRealPromptIndices(lines);

  // Candidate text per occurrence, computed once: both rungs score the same
  // text, so a rung comparison is never confounded by a different input.
  const candidates = occurrences.map((occ) => ({
    occ,
    candidateTexts: [...occ.texts, extractEnclosingTurnText(lines, promptIndices, occ.idx)],
  }));

  // mt#3720 collects EVERY matching occurrence rather than returning on the
  // first, because the session verdict below is an aggregate over all of them.
  let matchedOccurrences: MatchedResearchOccurrence[] = [];
  let degradedReason: string | undefined;

  // Rung 2 (mt#3772). ADR-024 stops at Rung 1 by default, but this detector's
  // Rung-1 gate is measured non-discriminating: `research`/`plan`/`task` are
  // process vocabulary describing the activity the detector already keyed on,
  // so the lexical match is tautological rather than evidence of topical
  // relevance. Rung 2 asks the question the gate is actually for — is this
  // research ABOUT the skill's domain?
  if (nominateSkill) {
    const nominated: MatchedResearchOccurrence[] = [];
    // Session-wide wall-clock bound. Each nomination is individually race-bound
    // at DEFAULT_NOMINATION_TIMEOUT_MS (2000ms), but this loop is serial and
    // runs once per research occurrence — so without a TOTAL bound the cost
    // grows linearly with occurrences and crosses this guard's 10s registry
    // budget at five of them. Sessions with far more research calls than that
    // exist in the corpus, so this is a reachable state, not a theoretical one.
    //
    // Crossing the deadline degrades rather than truncating: a partial
    // nomination set would silently change `hadPropagation`, which is computed
    // over EVERY matched occurrence. Degrading re-runs the whole session
    // lexically, which is the one fallback whose semantics are already defined.
    const deadline = Date.now() + NOMINATION_SESSION_BUDGET_MS;
    for (const { occ, candidateTexts } of candidates) {
      if (isNominationBudgetExhausted(deadline, Date.now())) {
        degradedReason = "session-nomination-budget-exceeded";
        break;
      }
      const outcome = await nominateSkill(candidateTexts, loadedSkills);
      if (outcome.kind === "degraded") {
        degradedReason = outcome.reason;
        break;
      }
      if (outcome.kind === "nominated") {
        nominated.push({
          occ,
          matchedSkill: outcome.skill,
          matchedKeyword: outcome.segment,
          candidateTexts,
          score: outcome.score,
        });
      }
      // "none" — the nominator ran and this research is about no loaded skill.
      // A real negative, NOT a reason to consult the lexical gate.
    }
    if (degradedReason === undefined) matchedOccurrences = nominated;
  }

  // Fail to Rung 1, never silent-skip (ADR-024 invariant). All-or-nothing per
  // verdict: a degradation part-way through discards the rung-2 results and
  // re-runs every occurrence lexically, so one session's verdict is never half
  // embedding-nominated and half keyword-matched — which would make the
  // recorded `detectionRung` a lie about how the verdict was reached.
  if (nominateSkill === undefined || degradedReason !== undefined) {
    matchedOccurrences = [];
    for (const { occ, candidateTexts } of candidates) {
      let matchedSkill: string | undefined;
      let matchedKeyword: string | undefined;
      for (const skill of loadedSkills) {
        const keywords = skillKeywordsByName.get(skill);
        if (!keywords || keywords.length === 0) continue;
        const hit = findKeywordOverlap(candidateTexts, keywords);
        if (hit) {
          matchedSkill = skill;
          matchedKeyword = hit;
          break;
        }
      }
      if (!matchedSkill || !matchedKeyword) continue;
      matchedOccurrences.push({ occ, matchedSkill, matchedKeyword, candidateTexts });
    }
  }

  const firstMatch = matchedOccurrences[0];
  if (!firstMatch) return null;

  /**
   * Transcript index of the session's MOST RECENT matched occurrence.
   *
   * Computed by max rather than by taking the array's last element, and computed
   * ONCE because two consumers depend on it — the eligibility gate immediately
   * below and the session verdict further down. PR #2751 R1 caught them
   * disagreeing: the verdict had been made order-invariant while the gate still
   * read `matchedOccurrences[length - 1]`, so an unordered array would have let
   * the two pick different occurrences and mis-time the grace period.
   *
   * Both construction paths (rung-2 `nominated` and the lexical fallback) push in
   * `candidates` iteration order today, so the array IS ordered in practice and
   * the two forms agree. That is an invariant held at a distance, in a different
   * branch, which is exactly the kind that breaks quietly later — deriving the
   * value once removes the coupling instead of restating the assumption twice.
   */
  const lastOccurrenceIdx = matchedOccurrences.reduce(
    (max, { occ }) => (occ.idx > max ? occ.idx : max),
    -1
  );

  // Session eligibility: the grace period runs against the MOST RECENT matched
  // occurrence, not each one individually (mt#3720), so a session with
  // continuing matched research keeps re-extending its own clock. A deferral,
  // not a suppression — nothing is recorded, and it is re-evaluated on the next
  // Stop invocation.
  if (countPromptBoundariesAfter(lines, lastOccurrenceIdx) < windowTurns) return null;

  // mt#3617 instrumentation, aggregated across every matched occurrence
  // (mt#3720). Collected after the nomination loop — so it cannot influence
  // which skill is nominated — and after the eligibility gate, so it runs only
  // when a record is actually emitted. The first matched occurrence remains the
  // NOMINATION, unchanged from v1's convention.
  const keywordHits = matchedOccurrences.flatMap(({ candidateTexts }) =>
    loadedSkills.flatMap((skill) =>
      findAllKeywordOverlaps(skill, candidateTexts, skillKeywordsByName.get(skill) ?? [])
    )
  );
  const matchedTextExcerpt = buildMatchExcerpt(
    firstMatch.candidateTexts,
    firstMatch.matchedKeyword
  );

  // The session verdict: did a propagation call happen after the session's LAST
  // matched research occurrence?
  //
  // ## This used to be an `every`, and the `every` was redundant (mt#3901)
  //
  // The prior form was `matchedOccurrences.every(occ => hasPropagationAfter(occ.idx))`,
  // commented as "one uncaptured piece of research is enough to make the verdict
  // a miss." It did not do that. `hasPropagationAfter` is unbounded — it scans
  // from the occurrence to the end of the visible transcript — which makes it
  // MONOTONE IN POSITION: a propagation call after the last occurrence is
  // necessarily also after every earlier one. So the conjunction was
  // mathematically equivalent to this single check, and the strictness the
  // comment claimed was never implemented. Measured corroboration at the time:
  // 15 of 15 post-mt#3720 records scored propagated, none a miss.
  //
  // Written explicitly so the code states what it computes. This is a clarity
  // fix with an equivalence proof, NOT a behavior change — if the live
  // propagation rate moves after this ships, the equivalence argument is wrong
  // and that is the signal to reopen mt#3901.
  //
  // ## Why the strict reading is not implemented here
  //
  // "One UNCAPTURED piece of research" requires knowing whether a given capture
  // COVERS a given research occurrence — topical relation, which ADR-024 places
  // at rung 3. A rung-1 proxy (require one distinct propagation call per
  // occurrence) was considered and rejected: an agent who researches three
  // related things and writes one well-scoped memory has captured the knowledge
  // correctly, so the proxy would flag good consolidation as a miss. The strict
  // semantic is assigned to mt#3783, this detector's rung-3 task.
  //
  // `lastOccurrenceIdx` is derived ONCE above and deliberately shared with the
  // eligibility gate — see its doc comment for why the two must not compute
  // "the most recent occurrence" independently (PR #2751 R1).
  const hadPropagation = lastOccurrenceIdx >= 0 && hasPropagationAfter(lines, lastOccurrenceIdx);

  // mt#3740's dedupe decision, made here because it needs the verdict.
  //
  // The bound this replaces "at most one record, ever" with: **at most one
  // record per verdict CHANGE.** An unchanged verdict writes nothing, so a
  // quiet session that keeps hitting Stop still produces exactly one record —
  // the 13-records-from-one-session shape mt#3720 killed cannot return. The
  // count is bounded by the number of genuine research↔propagation
  // alternations in the transcript, each of which requires real tool calls;
  // it is not a turn-count. Measured on the live log at 2026-08-11: 232
  // records, no session holding more than one.
  //
  // Revision runs in BOTH directions. miss→propagated is the case this task was
  // filed for; propagated→miss is equally real, because the verdict is "was
  // there a capture after the LAST research occurrence" and researching again
  // after a capture legitimately re-opens the question (mt#3901's equivalence
  // note). A scheme keyed on the verdict VALUE could not express the second
  // flip back; this one has no such ceiling.
  if (alreadyRecorded) {
    if (!priorVerdict || priorVerdict.hadPropagation === hadPropagation) return null;
  }

  return {
    result: {
      matched: true,
      // mt#3772: no longer a hardcoded constant. It now records which rung
      // ACTUALLY produced the verdict, which is what mt#3199's criterion 5
      // flagged as unreachable-by-construction on the old literal.
      detectionRung: degradedReason === undefined && nominateSkill ? "2-embedding" : "1-lexical",
      researchTools,
      loadedSkills,
      matchedSkill: firstMatch.matchedSkill,
      matchedKeyword: firstMatch.matchedKeyword,
      keywordHits,
      matchedTextExcerpt,
      ...(firstMatch.score !== undefined ? { nominationScore: firstMatch.score } : {}),
      ...(degradedReason !== undefined ? { degradedReason } : {}),
      hadPropagation,
    },
    dedupeKey: SESSION_VERDICT_DEDUPE_KEY,
    ...(alreadyRecorded && priorVerdict ? { supersedes: priorVerdict.timestamp } : {}),
    // mt#3207 census semantics preserved: a propagated verdict still emits a
    // record (carrying the suppression reason) rather than being dropped, so
    // the propagation RATE stays measurable from the log alone. Safe to record
    // — and so to burn the dedupe key — because propagation is in the past and
    // cannot un-happen.
    suppressionReasons: hadPropagation ? [SUPPRESSION_PROPAGATION_IN_WINDOW] : [],
  };
}

// ---------------------------------------------------------------------------
// Calibration logging + dedupe
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  try {
    const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[knowledge-acquisition-detector] calibration log write failed: ${msg}\n`);
  }
}

/** What this session already has in the calibration log (mt#3740). */
export interface LoggedSessionState {
  /** Every `dedupeKey` already logged THIS session. */
  keys: Set<string>;
  /** The session's most recent recorded verdict, or null if it has none. */
  priorVerdict: PriorSessionVerdict | null;
}

/**
 * Load this session's logged state from a bounded tail read of the calibration
 * log (mt#3003 shared dedupe primitive, `readLogTailText`) — never a full-file
 * read, and never throws.
 *
 * mt#3740: returns the keys AND the prior verdict from ONE pass. They are
 * deliberately not separate loaders — the revision decision needs both, and a
 * caller that could fetch the keys alone would silently get mt#3720's
 * freeze-the-first-answer behavior back.
 */
function loadLoggedSessionState(cwd: string, sessionId: string | undefined): LoggedSessionState {
  if (!sessionId) return { keys: new Set<string>(), priorVerdict: null };
  try {
    const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
    const text = readLogTailText(logPath);
    if (!text) return { keys: new Set<string>(), priorVerdict: null };
    return parseLoggedSessionState(text, sessionId);
  } catch {
    // ignore — fail-open, treat as "nothing logged yet"
    return { keys: new Set<string>(), priorVerdict: null };
  }
}

/**
 * The pure half of {@link loadLoggedSessionState}: parse log-tail TEXT into
 * this session's logged state.
 *
 * Split out (PR #2873 R1) so the loader seam — the thing that actually wires
 * revision into production — is testable without touching disk. Testing it via
 * the disk-reading wrapper would need a real temp file, which
 * `custom/no-real-fs-in-tests` forbids; the wrapper is now thin enough that
 * reading it IS the review.
 */
export function parseLoggedSessionState(text: string, sessionId: string): LoggedSessionState {
  const keys = new Set<string>();
  let priorVerdict: PriorSessionVerdict | null = null;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>;
      if (rec["session_id"] !== sessionId) continue;
      if (typeof rec["dedupeKey"] === "string") {
        keys.add(rec["dedupeKey"] as string);
      }
      // Last one wins: the tail is append-ordered, so the final matching
      // record is this session's CURRENT verdict — including one that already
      // superseded an earlier record. Comparing against anything else would
      // let a session oscillate against a stale baseline.
      if (
        rec["dedupeKey"] === SESSION_VERDICT_DEDUPE_KEY &&
        typeof rec["hadPropagation"] === "boolean" &&
        typeof rec["timestamp"] === "string"
      ) {
        priorVerdict = {
          hadPropagation: rec["hadPropagation"] as boolean,
          timestamp: rec["timestamp"] as string,
        };
      }
    } catch {
      // A malformed line is skipped, never fatal — the log is append-only
      // and a partial write must not blind the whole read.
      continue;
    }
  }
  return { keys, priorVerdict };
}

/**
 * Resolve the keyword map for every loaded skill (impure — reads from disk,
 * never throws). ALWAYS populates an entry for every loaded skill, even when
 * its SKILL.md is missing/unparsable/transiently unreadable
 * (`readSkillDescription` returns `""` in that case) — `extractSkillKeywords`
 * derives name tokens from `skillName` independently of `description`, so a
 * skill with no readable description still gets its own name-token keywords
 * (e.g. "engineering", "writing" for `engineering-writing`). Gating the
 * `map.set` on a truthy `description` (as an earlier revision did) silently
 * dropped the name-token keywords for exactly the unreadable-file case, a
 * false-negative path the rung-2-lite gate must not have (PR #2239 R1/R2).
 */
function resolveSkillKeywords(cwd: string, loadedSkills: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const skill of loadedSkills) {
    const description = readSkillDescription(cwd, skill);
    map.set(skill, extractSkillKeywords(skill, description));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Injection text (gated by INJECTION_ENABLED — dormant in v1)
// ---------------------------------------------------------------------------

/**
 * The one record shape both entry points write (mt#3207).
 *
 * Previously duplicated field-by-field in `run()` and `main()`, which is how a
 * new shared-contract field gets added to one path and forgotten on the other.
 */
export function buildCalibrationRecord(
  input: ClaudeHookInput,
  detection: KnowledgeAcquisitionDetection
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    detectionRung: detection.result.detectionRung,
    researchTools: detection.result.researchTools,
    loadedSkills: detection.result.loadedSkills,
    hadPropagation: detection.result.hadPropagation,
    matchedSkill: detection.result.matchedSkill,
    matchedKeyword: detection.result.matchedKeyword,
    keywordHits: detection.result.keywordHits,
    matchedTextExcerpt: detection.result.matchedTextExcerpt,
    nominationScore: detection.result.nominationScore,
    degradedReason: detection.result.degradedReason,
    dedupeKey: detection.dedupeKey,
    // mt#3740: present ONLY on a revision. A reader (and the calibration sweep)
    // uses it to drop the record it names, so a revised session contributes one
    // outcome rather than two.
    ...(detection.supersedes !== undefined ? { supersedes: detection.supersedes } : {}),
    suppressionReasons: detection.suppressionReasons,
  };
}

// Exported (mt#4002) — see `renderProbe` in the registry. Calibration-first
// guards emit no `additionalContext`, so the shape test had nothing to measure.
export function buildInjectionReminder(result: KnowledgeAcquisitionResult): string {
  return [
    "[knowledge-acquisition-detector] Research surfaced knowledge relevant to a",
    `loaded skill (\`${result.matchedSkill}\`, keyword "${result.matchedKeyword}"),`,
    "with no propagation anywhere in this session (mt#2708, mt#3720).",
    `Research tools: ${result.researchTools.join(", ")}.`,
    "If this should update the skill/rule, capture it now: memory_create, the",
    "/learn routing skill, or a filed task targeting the artifact.",
    // Override advertisement removed (mt#4002) — see `guard-feedback-authoring.mdc`.
  ].join("\n");
}

/**
 * Worst-case render for the registry's `renderProbe` (mt#4002).
 *
 * The template is fixed and interpolates three values. `researchTools` is joined
 * with no count cap — growth-shaped, though bounded in practice by the number of
 * distinct research tools a turn can call — so this is posed at a saturated
 * sample rather than a proved ceiling; `matchedSkill` and `matchedKeyword` come
 * from the loaded-skill list and this module's keyword corpus.
 */
export function renderWorstCase(): string {
  // Every required field supplied rather than cast through `unknown`: a cast
  // would let the probe keep compiling after the result type gains a field the
  // renderer reads, which is the drift this measurement exists to prevent.
  const result: KnowledgeAcquisitionResult = {
    matched: true,
    detectionRung: "rung-2",
    researchTools: Array.from({ length: 6 }, (_, i) => `mcp__research__tool_number_${i}`),
    loadedSkills: [],
    matchedSkill: "x".repeat(40),
    matchedKeyword: "y".repeat(40),
    keywordHits: [],
    hadPropagation: false,
  };
  return buildInjectionReminder(result);
}

/**
 * Build the Rung-2 nominator: one exemplar set per loaded skill, whose
 * exemplar IS that skill's frontmatter description.
 *
 * The mapping is the whole idea. `nominate` scores a candidate text against
 * every family and returns per-family similarity; "family" = skill and
 * "exemplar" = what that skill is FOR, so the score answers "is this research
 * about that skill's domain?" — the question the lexical gate only proxied.
 *
 * Deps resolve lazily and are cached across occurrences within one session
 * verdict, and a failure latches: once degraded, every later call returns
 * degraded without re-attempting. Re-attempting per occurrence would spend a
 * provider round-trip per research call to re-learn the same answer, and would
 * let one verdict mix rungs — which the caller explicitly forbids.
 */
/**
 * Opt-in for the Rung-2 nomination path (mt#3772).
 *
 * Rung 2 ships DISABLED by default, matching mt#3408's precedent for the
 * sibling family: the mechanism lands, and the threshold that decides it is
 * measured offline before it is allowed to change any verdict. Two concrete
 * reasons here, not caution-in-general:
 *
 * 1. `DEFAULT_SIMILARITY_THRESHOLD` (0.455) was derived from the
 *    retrospective-trigger exemplar band. Nothing has measured where
 *    research-text-vs-skill-description cosines actually live, so enabling it
 *    by default would ship an unmeasured threshold into every session verdict.
 * 2. Enabled, every research occurrence costs a provider round-trip. That is a
 *    real cost to impose before the precision it buys is known.
 *
 * Registered in `HOOK_ONLY_ENV_VARS`.
 */
export const RUNG2_NOMINATION_ENV_VAR = "MINSKY_KA_RUNG2_NOMINATION";

/** True when the operator has opted into the Rung-2 nomination path. */
export function isRung2NominationEnabled(): boolean {
  const raw = process.env[RUNG2_NOMINATION_ENV_VAR];
  return raw === "1" || raw?.toLowerCase() === "true" || raw?.toLowerCase() === "yes";
}

export function createSkillNominator(cwd: string): SkillNominator {
  let deps: NominationDeps | null | undefined;
  let latchedFailure: string | undefined;

  return async (candidateTexts, loadedSkills) => {
    if (latchedFailure !== undefined) return { kind: "degraded", reason: latchedFailure };

    if (deps === undefined) {
      // A hook is its own entry point: it inherits neither the reflect polyfill
      // nor the process-global configuration the CLI and MCP server set up at
      // boot, and `resolveNominationDeps` reaches the embedding factory which
      // needs both. Without this the resolver throws, returns null, and Rung 2
      // degrades on EVERY turn in production while every test passes — the
      // mt#3019 dead-path shape mt#3408 hit on this exact call.
      //
      // The try/catch is load-bearing, not defensive habit: BOTH calls can
      // throw, the caller runs inside `run()`'s catch-all, and an escaping
      // throw there turns the whole verdict into `null` — no record, no
      // degraded marker, nothing. That is precisely the silent-skip ADR-024
      // forbids, and it is what this guard converts back into a visible
      // degradation. Caught by the real-`run()` tests, which have no provider.
      try {
        const bootstrap = await ensureHookDomainBootstrap();
        if (!bootstrap.ok) {
          latchedFailure = "bootstrap-failed";
          return { kind: "degraded", reason: latchedFailure };
        }
        deps = await resolveNominationDeps();
      } catch (err) {
        latchedFailure = `resolve-threw: ${err instanceof Error ? err.message : String(err)}`;
        return { kind: "degraded", reason: latchedFailure };
      }
    }
    if (deps === null) {
      latchedFailure = "provider-unconfigured";
      return { kind: "degraded", reason: latchedFailure };
    }

    const exemplarSets: ExemplarSet[] = [];
    for (const skill of loadedSkills) {
      const description = readSkillDescription(cwd, skill);
      // A skill with no readable description contributes no exemplar. Unlike
      // the lexical path — which falls back to name tokens — there is nothing
      // meaningful to embed for it, and embedding the bare name would score
      // every research turn against a single word.
      if (description.trim().length > 0) {
        exemplarSets.push({ family: skill, exemplars: [description] });
      }
    }
    // No embeddable description for ANY loaded skill is "Rung 2 cannot answer",
    // NOT "this research is about no skill" — so it degrades to the lexical
    // gate, which still has name tokens to work with. Returning `none` here
    // would silence the detector on exactly the unreadable-SKILL.md case the
    // lexical path was given a name-token fallback for (PR #2239 R1/R2).
    if (exemplarSets.length === 0) {
      return { kind: "degraded", reason: "no-embeddable-skill-descriptions" };
    }

    const result = await nominate(candidateTexts.join("\n"), exemplarSets, deps);
    if (result.degraded) {
      latchedFailure = result.degradedReason ?? "unknown";
      return { kind: "degraded", reason: latchedFailure };
    }

    let best: Nomination | undefined;
    for (const nomination of result.nominations) {
      if (best === undefined || nomination.score > best.score) best = nomination;
    }
    if (best === undefined) return { kind: "none" };
    return { kind: "nominated", skill: best.family, score: best.score, segment: best.segment };
  };
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Reuses `ctx.transcriptLines` (D6) instead of
 * re-parsing the transcript itself. Only calibration logging happens while
 * `INJECTION_ENABLED` is false — `additionalContext` is never set until the
 * flag flips post-graduation.
 */
export async function run(
  input: ClaudeHookInput,
  ctx: DispatchContext
): Promise<GuardOutcome | null> {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  if (isOverride) {
    return {
      auditLines: [
        `[knowledge-acquisition-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;
  // Silent on first turn — no completed turn exists yet.
  if (findRealPromptIndices(lines).length < 2) return null;

  let detection: KnowledgeAcquisitionDetection | null;
  try {
    const loadedSkills = [...new Set(extractSkillInvocationsWholeSession(lines))];
    if (loadedSkills.length === 0) return null;

    const skillKeywordsByName = resolveSkillKeywords(input.cwd, loadedSkills);
    const loggedState = loadLoggedSessionState(input.cwd, input.session_id);
    detection = await detectKnowledgeAcquisition(
      lines,
      loadedSkills,
      skillKeywordsByName,
      loggedState.keys,
      TRAILING_WINDOW_TURNS,
      isRung2NominationEnabled() ? createSkillNominator(input.cwd) : undefined,
      loggedState.priorVerdict
    );
  } catch (err) {
    process.stderr.write(
      `[knowledge-acquisition-detector] detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  if (!detection) return null;

  const outcome: GuardOutcome = { calibration: buildCalibrationRecord(input, detection) };
  if (INJECTION_ENABLED && detection.suppressionReasons.length === 0) {
    outcome.additionalContext = buildInjectionReminder(detection.result);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Standalone CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const capInfo = readHostCap("knowledge-acquisition-detector.ts", undefined, {
    events: ["Stop"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[knowledge-acquisition-detector] ${capInfo.warning}\n`);
  }
  const budgets = deriveBudgets(capInfo.hostCapSec);
  const overallDeadline = Date.now() + budgets.overallBudgetMs;

  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    process.exit(0);
  }

  if (isOverride) {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[knowledge-acquisition-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  if (Date.now() >= overallDeadline) {
    process.stderr.write(`[knowledge-acquisition-detector] budget exhausted — skipping\n`);
    process.exit(0);
  }

  const lines = resolveParentTranscriptLinesForPath(transcriptPath, input.agent_id);
  if (lines.length === 0) process.exit(0);
  if (findRealPromptIndices(lines).length < 2) process.exit(0);

  let detection: KnowledgeAcquisitionDetection | null;
  try {
    const loadedSkills = [...new Set(extractSkillInvocationsWholeSession(lines))];
    if (loadedSkills.length === 0) process.exit(0);

    const skillKeywordsByName = resolveSkillKeywords(input.cwd, loadedSkills);
    const loggedState = loadLoggedSessionState(input.cwd, input.session_id);
    detection = await detectKnowledgeAcquisition(
      lines,
      loadedSkills,
      skillKeywordsByName,
      loggedState.keys,
      TRAILING_WINDOW_TURNS,
      isRung2NominationEnabled() ? createSkillNominator(input.cwd) : undefined,
      loggedState.priorVerdict
    );
  } catch (err) {
    console.error(
      `[knowledge-acquisition-detector] detection error: ${getLoggableErrorSummary(err)}`
    );
    process.exit(0);
  }

  if (!detection) process.exit(0);

  if (Date.now() < overallDeadline) {
    appendCalibrationRecord(input.cwd, buildCalibrationRecord(input, detection));
  }

  // mt#3207: a suppressed detection records but never injects (mirrors `run()`).
  if (!INJECTION_ENABLED || detection.suppressionReasons.length > 0) process.exit(0);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: buildInjectionReminder(detection.result),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Entrypoint guard: only run main() when this file is invoked as a script —
// the dispatcher's dynamic `import("./knowledge-acquisition-detector")` must
// NOT trigger it (mt#2835 class — see auto-session-title.ts's header comment).
if (import.meta.main) {
  await main();
}
