#!/usr/bin/env bun
// UserPromptSubmit hook: detect code-mechanism assertions made WITHOUT a
// same-turn read of the named symbol. Per mt#2486 (tier-2 of mt#2485).
//
// The narrow, high-precision slice of the "assertion frozen as fact without
// verification" family (root memory 3772c77d): the agent asserts what a NAMED
// code symbol DOES — "executeCommand clamps maxBuffer to 10MB", "the 1MB default
// maxBuffer", "X returns null when Y" — without having read that symbol this
// turn. The R9 maxBuffer incident (PR #1694, 2026-06-13) is the canonical case:
// claimed executeCommand's buffer default without reading exec.ts (it was 10MB,
// not 1MB; payload was 850KB, so the buffer was never the cause).
//
// Narrowness IS the precision lever. Unlike the broad causal-premise detector
// (mt#2366), which must judge ANY causal claim and so cannot reach subtle cases
// without unacceptable false positives, this fires ONLY on code-symbol-behavior
// claims, where high precision is achievable.
//
// CALIBRATION-FIRST: v1 shipped with INJECTION_ENABLED = false — logging
// matches to a calibration JSONL and injecting NOTHING — until the FP rate
// was reviewed (mt#2483 calibration-review sweep). The 2026-07-21 review
// (ask 089320f7, operator-confirmed) disposed the residual FP as concentrated
// in two nameable symbol classes (rule/doc-file names; bare hex-id tokens);
// mt#3002 excludes both classes and flips INJECTION_ENABLED to true in the
// same PR — this is the graduation from calibration-only to live reminders.
//
// mt#3050 (R13) widened the claim SHAPE, not the symbol extraction: a named
// tool/seam CAPABILITY claim ("the router suggestion is sourced from the
// existing `tasks_route` seam") uses sourcing/provenance verbs, not behavior
// verbs — see the trailing entries in PREDICATE_PATTERNS below.
//
// Detector contract:
//   FIRES when the prior assistant turn asserts a named code symbol's BEHAVIOR
//   OR CAPABILITY/PROVENANCE (a predicate — clamps/defaults to/overrides/
//   returns/.../sourced from/backed by/... — within proximity of a
//   symbol-shaped token) AND the symbol does NOT appear in any
//   same-turn tool_result content OR read-class tool input. A same-turn read of
//   the symbol's file backs the claim because the file source (containing the
//   symbol) lands in the tool_result.
//   DOES NOT FIRE when:
//   - the symbol appears in a same-turn tool_result / read-class tool input,
//   - no symbol-shaped token sits near a behavioral predicate,
//   - the predicate+symbol is inside a fenced code block or blockquote (pasted
//     output / a quote, not a fresh assertion).
//
// Known v1 limitation (measured by calibration, addressed in a v2 if warranted):
//   backing is symbol-token presence in the turn's tool corpus. A read whose
//   result does not literally contain the symbol token (e.g. the symbol is
//   computed/aliased) will not register as backing → possible FP. The
//   calibration log's hadSameTurnRead field records the determination so the
//   FP rate is reviewable.
//
// mt#3113 tunes FOUR live-FP shapes surfaced by the 2026-07-23 calibration
// review (ask#5425, operator-confirmed), all at the INJECTION layer — none
// change `detectCodeMechanismAssertion`'s core claim-detection contract:
//
//   1. Same-turn-read suppression: 7 of 14 recent records carried
//      `hadSameTurnRead: true` (a DIFFERENT symbol in the same turn was
//      backed) and still injected. `run()`/`main()` now suppress
//      `additionalContext` when `hadSameTurnRead` is true, WITHOUT touching
//      the pure detector's claims/hadSameTurnRead/backedClaimCount contract
//      (mt#2673's turn-level semantics — see the `ask#5343 tune-1
//      correction` test below — are unchanged; this is an injection-layer
//      gate stacked on top, not a reversal of that decision).
//   2. Symbol plausibility: generic English/tech-term words (`since`,
//      `description`, `macOS`, `CommonJS`) and bare directory references
//      (`target/`) were extracted as "symbols" because BACKTICK_SYMBOL_RE
//      accepts any backtick-quoted span with no requirement that it read as
//      a genuine project identifier. Extends (does not replace) mt#3002's
//      SYMBOL_STOPLIST + a new bare-directory-reference exclusion — see
//      `isPlausibleSymbol` below.
//   3. Relay context: the detector fired on claims RELAYED from a dispatched
//      subagent's own report — the subagent performed the read, the parent
//      turn quotes/paraphrases its findings. `buildRelayCorpus` +
//      `detectRelayContext` detect (a) ANY same-turn subagent-dispatch
//      tool_result (deliberately NOT gated on the tool_result containing the
//      claimed symbol — that case is already excluded upstream as
//      `hadSameTurnRead`, so such a gate would be dead code), or (b) a
//      relay-preamble phrase ("the subagent reports...") near the claim.
//      mt#3113 SUPPRESSED injection on either signal; **mt#3152 reversed
//      that** — relay is now SURFACED with relay-specific guidance
//      (check-premise cue (g)) and reported separately as `relayReasons`,
//      because a second-hand claim is the reason to check, not to stay quiet
//      (mem#706). See `computeSuppressionReasons` for the full rationale.
//   4. Per-claim dedup: an identical claim set re-fired (re-injected) on
//      nearly every turn for ~10 hours in one session. A new per-session
//      cooldown store (`code-mechanism-assertion-dedup-store.ts`, mirroring
//      `guard-health-escalation-notify-store.ts`'s mt#3072 pattern)
//      suppresses re-injection of an unchanged (claim-set signature, session)
//      pair within a 1h cooldown.
//
// All four suppressions are recorded in the calibration record's
// `suppressionReasons: string[]` field (empty when nothing suppressed) so
// calibration review can grade the suppressions themselves, not just the
// underlying detection — per this task's explicit success criterion.
//
// @see mt#2486 — this task; mt#2485 — strategic reframe (tier-2)
// @see mt#3050 — R13 sourcing/provenance predicate widening (this file's
//      PREDICATE_PATTERNS trailing entries); symbol extraction was NOT the
//      gap, only the claim-shape coverage.
// @see mt#3113 — same-turn-read/relay/dedup injection-layer suppression +
//      symbol-plausibility extension (this comment's four legs above)
// @see .claude/hooks/causal-premise-detector.ts — sibling pattern (mt#2216)
// @see .claude/hooks/transcript.ts — shared turn-boundary helper
// @see .claude/hooks/code-mechanism-assertion-dedup-store.ts — leg 4's cooldown store
// @see mt#2652 — ADR-028 Phase 2a: this file's exported `run()` is the
//      dispatcher-compatible entry point invoked in-process by
//      `./dispatch-userpromptsubmit.ts`; `main()` / the CLI entrypoint below
//      is unchanged.

import { readInput, readHostCap, deriveBudgets, findRepoRoot } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  resolveParentTranscriptLinesForPath,
  extractLastAssistantTurn,
  extractAssistantText,
  type TranscriptLine,
} from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";
import { claimSetSignature, shouldInjectClaimSet } from "./code-mechanism-assertion-dedup-store";
import { readAuthoredSpecText } from "./authored-spec-text";
import { GENERATION_BANNER_PATTERNS } from "../../packages/domain/src/rules/compile/banner-constants";
import {
  CAPTURE_SCHEMA_FIELD,
  CAPTURE_SCHEMA_VERSION,
  captureArtifact,
} from "./judged-input-capture";
import { ensureHookDomainBootstrap } from "./domain-bootstrap";
import { nominate } from "../../packages/domain/src/detectors/embedding-nomination";
import type {
  ExemplarSet,
  NominationDeps,
} from "../../packages/domain/src/detectors/embedding-nomination";
import { resolveNominationDeps } from "../../packages/domain/src/detectors/embedding-nomination-factory";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection
// ---------------------------------------------------------------------------

/**
 * When false (calibration mode), the hook logs matches to JSONL and injects
 * NO additionalContext. Flipped to true by mt#3002 (2026-07-21) after the
 * mt#2483 calibration-review sweep disposed the residual FP rate as
 * TUNE+FLIP — see the FILE_EXTENSION_RE / HEX_ID_RE exclusions below, added
 * in the same change, which close the two nameable FP classes the review
 * found.
 */
export const INJECTION_ENABLED = true;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_CODE_MECHANISM_ASSERTION";

const CALIBRATION_LOG = ".minsky/code-mechanism-assertion-calibration.jsonl";

// ---------------------------------------------------------------------------
// Behavioral-predicate patterns — the claim asserts what a symbol DOES
// ---------------------------------------------------------------------------

/**
 * Verbs/phrases asserting a code symbol's runtime behavior. Each is matched in
 * the assistant prose; a symbol-shaped token must sit within
 * SYMBOL_PROXIMITY_CHARS of the match for the pair to count as a claim.
 *
 * The last two patterns (`the <N><unit> default…` and `<noun> is/of/=`) are the
 * highest FP risk: "the default is fine" near an identifier is not a behavioral
 * assertion (PR #1697 R2). They are kept because they catch the R9 canonical
 * phrasing ("the 1MB default maxBuffer"); the SYMBOL_PROXIMITY_CHARS guard plus
 * the calibration-first rollout (INJECTION_ENABLED=false, FP measured via
 * mt#2483) are what keep this acceptable until graduation.
 */
export const PREDICATE_PATTERNS: RegExp[] = [
  /\b(clamps?|caps?|limits?)\b/i,
  /\bdefaults?\s+to\b/i,
  /\b(is|are|was|were)\s+set\s+to\b/i,
  /\b(overrides?|overwrites?|shadows?)\b/i,
  /\b(returns?|yields?|resolves?\s+to)\b/i,
  /\b(throws?|raises?|rejects?|aborts?)\b/i,
  /\b(enforces?|validates?|requires?)\b/i,
  // `guard` is split out of the alternation above because it is the only member
  // whose bare form is a common NOUN in this corpus — "the `tasks_create`
  // guard", "a guard that denies", "guard-health", "the deny-tier sibling
  // guard". Its siblings have distinct noun forms (enforcement, validation,
  // requirement), so none of them collides this way. Matching `guards?` read
  // "the X guard" as the mechanism claim "X guards", and that drove 6 of the 10
  // injected fires in the 2026-08-09 calibration pass (mt#3876).
  //
  // Two changes, both verb-morphology requirements (SC1's third option):
  //
  //   1. The bare `guard` is gone. A behavioral claim about a single named
  //      symbol takes the third-person singular — "`X` guards against Y" — so
  //      bare `guard` in this corpus is a noun essentially without exception.
  //      This alone kills all four observed noun forms.
  //   2. `guards` survives only OUTSIDE noun position. The lookbehind rejects a
  //      preceding determiner, possessive, quantifier or the adjectives this
  //      corpus actually uses, which is what separates the plural noun ("the
  //      two guards", "sibling guards") from the verb ("`X` guards against Y",
  //      "the parallel-work hook guards the merge"). In the verb case the token
  //      before `guards` is the SUBJECT, not a determiner — which is why a
  //      lookbehind discriminates here and a following-context test does not.
  //
  // NOT widened to the other noun-ambiguous predicates above (`caps?`,
  // `limits?`, `drops?`) — mt#3876 SC2 requires each non-`guard` fire to be
  // re-examined on its own evidence first, and none of those appeared in the
  // injected set. Recorded in that task rather than fixed on suspicion.
  /(?<!\b(?:the|a|an|this|that|these|those|its|their|our|his|her|two|three|several|many|sibling|deny-tier|per-detector)\s)\bguards\b/i,
  /\b(ignores?|drops?|swallows?|discards?|skips?)\b/i,
  /\b(truncates?|trims?|strips?)\b/i,
  /\b(falls?\s+back|short[- ]circuits?|no-?ops?)\b/i,
  /\b(retries?|backs?\s+off)\b/i,
  /\bat\s+its\s+limit\b/i,
  /\b(maxes?\s+out|caps?\s+out)\b/i,
  /\bthe\s+\d[\d.,]*\s*(b|kb|mb|gb|ms|s|m|h)\b\s+(default|limit|cap|timeout|buffer|max)/i,
  /\b(default|limit|cap|timeout|buffer|threshold)\s+(is|of|=)\b/i,
  // Sourcing/provenance predicates (mt#3050, R13 of the assertion-without-
  // verification family). R13's actual gap was NOT symbol extraction —
  // `tasks_route`/`tasks_estimate` were already extractable snake_case/
  // backticked tokens — it was that all 15 patterns above are BEHAVIOR verbs
  // ("X clamps/returns/throws Y"), while the R13 sentence ("the router
  // suggestion is sourced from the existing `tasks_route` / `tasks_estimate`
  // seam") is a CAPABILITY/PROVENANCE claim: a different surface form of the
  // same "asserted a named component's affordance without reading it" defect.
  // These five phrasings are high-precision (low prose-collision) sourcing
  // verbs. Deliberately EXCLUDED: bare `provides`/`exposes` — both are common
  // in ordinary PR/summary prose ("this PR provides…"), and with
  // INJECTION_ENABLED=true (this file, above) a false positive here is
  // recurring operator-facing noise, not a silent log line. Add them only on
  // calibration evidence showing acceptable precision, per the mt#3050 spec's
  // "Revised fix" section.
  /\bsourced\s+from\b/i,
  /\bcomes?\s+from\b/i,
  /\b(supplies|supplied\s+by)\b/i,
  /\bbacked\s+by\b/i,
  /\b(reads?|pulls?|derives?)\s+from\b/i,
];

// ---------------------------------------------------------------------------
// Symbol-token extraction
// ---------------------------------------------------------------------------

const SYMBOL_PROXIMITY_CHARS = 100;

/**
 * Symbol-shaped token forms (high-precision subset — backticked spans plus
 * CamelCase and snake_case identifiers). Dotted prose ("e.g.") is excluded;
 * a dotted symbol only counts when backticked.
 */
const BACKTICK_SYMBOL_RE = /`([A-Za-z_$][\w.$/-]*)`/g;
const CAMEL_CASE_RE = /\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi;

/**
 * Common camelCase/snake_case tokens that are prose, not code symbols. Keeps
 * the precision high; the calibration log surfaces any that slip through.
 */
const SYMBOL_STOPLIST: ReadonlySet<string> = new Set([
  "javascript",
  "typescript",
  "github",
  "gitlab",
  "postgresql",
  "postgres",
  "stdin",
  "stdout",
  "stderr",
  // mt#3113 leg 2: generic English words / common tech-proper-nouns that
  // slip through the existing shape-based checks. "since"/"description" are
  // plain lowercase prose words with no camelCase/snake_case/path structure
  // (only reach extraction via BACKTICK_SYMBOL_RE's permissive character
  // class); "macos"/"commonjs" DO match CAMEL_CASE_RE's shape (mac+OS,
  // Common+JS) but are common platform/ecosystem proper nouns, not symbols
  // defined by this project — the exact same "camelCase-shaped but not a
  // project symbol" class the pre-existing "github"/"gitlab"/"postgresql"
  // entries above already cover. Comparison is case-insensitive (the
  // isPlausibleSymbol call site lowercases before this lookup).
  "since",
  "description",
  "macos",
  "commonjs",
]);

/**
 * Bare-directory-reference exclusion (mt#3113 leg 2). A token that is a
 * single path segment followed by exactly one trailing slash (`target/`,
 * `dist/`, `build/`, `node_modules/`) reads as a generic build-artifact or
 * output-directory mention — the 2026-07-23 calibration data's `target/`
 * false positive — not a project-specific symbol or a genuine multi-segment
 * path reference. Deliberately does NOT reject multi-segment paths
 * (`src/exec.ts`, `scripts/verify-foo.ts`) or a bare filename with no
 * trailing slash: those remain plausible under the "path-like" acceptance
 * path (mt#3113 spec: "backtick-quoted with a path-like ... shape").
 */
const BARE_DIR_REF_RE = /^[A-Za-z_][\w-]*\/$/;

/**
 * File-name-shaped exclusion (mt#3002). A token ending in a known doc/config
 * extension — `hook-files.mdc`, `src/cockpit/CLAUDE.md` — cited next to a
 * mechanism verb ("override", "trim", "Guard") is a rule/doc-file reference:
 * the mt#2619 echo-of-injected-rule-text class, not an unverified
 * code-mechanism claim (2026-07-20T20:31 and 2026-07-21T08:13 calibration
 * records — the 2026-07-21 calibration review's FP class #1).
 *
 * Deliberately does NOT extend to code-file extensions (`.ts`, `.js`, `.py`,
 * ...): no calibration record shows a code-extension FP, and every genuine
 * symbol in the regression set (`session_pr_merge`, `execWithPath`,
 * `MINSKY_SKIP_SIZE_BUDGET`-style env vars, camel/snake identifiers) carries
 * no file extension at all — so restricting the exclusion to doc/config
 * extensions closes the observed FP class with zero risk of losing a real
 * claim. Revisit only if a future calibration record shows a code-extension
 * FP.
 */
const FILE_EXTENSION_RE = /\.(?:md|mdc|json|ya?ml|txt)$/i;

/**
 * Bare hex-id token exclusion (mt#3002). A commit-hash-like token (e.g.
 * `a30378971` — the 2026-07-21T00:26 calibration record, FP class #2) reads
 * as a "symbol" only because it starts with a hex letter (a-f) and is
 * backticked; it is not a code identifier. Genuine identifiers do not
 * consist ENTIRELY of hex digits with no case-mixing or separators — the
 * regression set (`MINSKY_SKIP_SIZE_BUDGET`, `session_pr_merge`,
 * `execWithPath`) all fail this test, so the exclusion is safe.
 */
const HEX_ID_RE = /^[0-9a-f]{8,40}$/i;

/**
 * Slash-separated non-identifier exclusion (mt#3540). An IANA timezone
 * (`America/New_York`) reaches extraction backticked, and the window slice can
 * cut it so the surviving token is a bare `New_York` — which then reads as
 * symbol+predicate next to a nearby verb. The 2026-08-01 calibration pass
 * logged `New_York/limit` FOUR times in a single day.
 *
 * The shape that distinguishes it: Capitalized_Words joined by underscores,
 * with no lowercase-leading camel hump and no path separator. Genuine all-caps
 * env vars (`MINSKY_SKIP_SIZE_JUSTIFICATION`) are fully upper; genuine snake
 * identifiers (`session_pr_merge`) are fully lower; a Title_Case_Underscore
 * token is neither, and no symbol in the regression set has that shape.
 */
const TITLE_CASE_UNDERSCORE_RE = /^[A-Z][a-z0-9]+(?:_[A-Z][a-z0-9]+)+$/;

/**
 * The same timezone in its UNCUT form (mt#3540, PR #2527 R1). The window slice
 * only sometimes severs `America/`; when it does not, the whole
 * `America/New_York` arrives as one backticked token, which
 * TITLE_CASE_UNDERSCORE_RE does not match because of the slash. Both forms are
 * the same false positive and both must be excluded.
 *
 * Shape: every slash-separated segment is a Title-case word, optionally
 * underscore-joined Title-case words — `America/New_York`, `Europe/London`,
 * `America/Argentina/Buenos_Aires`. Requiring EVERY segment to be Title-case
 * keeps genuine path references out of the exclusion: `src/exec.ts`,
 * `packages/domain/detectors` and `scripts/verify-foo.ts` all have
 * lowercase segments and are unaffected.
 */
const TITLE_CASE_PATH_RE =
  /^[A-Z][a-z0-9]+(?:_[A-Z][a-z0-9]+)*(?:\/[A-Z][a-z0-9]+(?:_[A-Z][a-z0-9]+)*)+$/;

/**
 * Product/application-name exclusion (mt#3540). A terminal emulator, editor or
 * vendor product mentioned in prose (`iTerm2`, logged as `iTerm2/drop` in the
 * 2026-08-01 pass) matches CAMEL_CASE_RE's shape but names no symbol this
 * project defines. This extends the SAME class the existing stoplist entries
 * cover (`github`, `postgresql`, `macos`, `commonjs`) — kept as its own named
 * set rather than folded into SYMBOL_STOPLIST so the calibration provenance of
 * each group stays legible.
 */
const PRODUCT_NAME_STOPLIST: ReadonlySet<string> = new Set([
  "iterm",
  "iterm2",
  "vscode",
  "jetbrains",
  "ghostty",
  "tmux",
  "supabase",
  "railway",
  "cloudflare",
]);

/**
 * Multi-segment bare-path exclusion (mt#3540). `BARE_DIR_REF_RE` above rejects
 * a SINGLE segment with a trailing slash (`dist/`); it deliberately keeps
 * multi-segment paths, because `src/exec.ts` is a meaningful reference. But a
 * multi-segment path ending in a slash names a DIRECTORY, not a file or a
 * symbol — the 2026-08-01 pass logged `packages/domain/src/detectors//guard`
 * (note the doubled slash: a directory reference with a trailing separator).
 * A directory cannot be the subject of a code-mechanism claim.
 */
const BARE_DIR_PATH_RE = /^[A-Za-z_][\w.-]*(?:\/[\w.-]+)+\/$/;

/**
 * Documented-override env-var exclusion (mt#3540). Guard documentation ends
 * with a standard line — "Override: set `MINSKY_ACK_UNTAKEN_ACTION=1`" — and an
 * agent quoting that boilerplate near a mechanism verb logged
 * `MINSKY_ACK_UNTAKEN_ACTION/Override` and `/guard` in the 2026-08-01 pass.
 *
 * This is the one shape of the four that ADR-024 actually reaches: it is
 * "explicit discussion-framing" under the ADR's Rung 1, whose prose-quotation
 * half is not implemented for any detector in this family. Scoped here as the
 * narrowest form of that idea — the token is excluded only when the
 * override-boilerplate framing is present in the surrounding window, NOT
 * whenever the env var appears — so a genuine claim about what the var DOES
 * still fires. When the shared Rung-1 prefilter lands, this predicate is the
 * piece it should absorb.
 */
const OVERRIDE_BOILERPLATE_RE = /\boverride\b\s*:?\s*(?:set\s+)?`?MINSKY_[A-Z0-9_]+/i;

export function isOverrideBoilerplateMention(tok: string, window: string): boolean {
  if (!/^MINSKY_[A-Z0-9_]+$/.test(tok)) return false;
  return OVERRIDE_BOILERPLATE_RE.test(window);
}

/**
 * URL-query-parameter exclusion — ADR-034 exclusion round SIX (mt#4157).
 *
 * The 2026-08-14 calibration pass classified all 10 injected fires: 8 false. One
 * of those eight is an EXTRACTION defect rather than a backing one. The agent
 * pasted Claude Code's own spend-limit banner —
 * `raise it at claude.ai/settings/usage?from=cc_cli_limit_message` — and
 * `cc_cli_limit_message`, a URL query-parameter VALUE in third-party output, was
 * extracted by `SNAKE_CASE_RE` and paired with the nearby words "limit" and
 * "raise" as predicates. No claim about it was made by anyone.
 *
 * **Round 6 was checked against ADR-034's reopen conditions before being
 * written, which that ADR's §Consequences requires** ("a sixth round is now a
 * decision with a record behind it, not a reflex"). None fires. Condition 1 needs
 * rounds 6 AND 7 inside 5 days; this is 6. Condition 3 needs an identifier index,
 * which does not exist. Condition 2 — "a measured FP rate above 10% on a
 * classified corpus" — is the one that looks triggered by the headline 80%, and
 * is not: it asks whether the mechanism ADR-034 KEPT is failing, and the rejected
 * allowlist would have fixed exactly this one record while ADMITTING the other
 * seven, whose symbols (`descendantsRequiredSigkill`, `expectedHeadSha`,
 * `get_files`) are all real. Those seven are verification-corpus defects, not
 * symbol-identification ones. Mechanism-attributable rate: 1/10.
 *
 * **Scoped to query parameters, deliberately not to "quoted third-party text".**
 * The spec described this class both ways, but only one is mechanically
 * decidable: nothing in the text marks its author, and the fixture's banner is
 * not quoted or fenced at all. A query parameter is decidable, so that is the
 * predicate. Path segments are also left alone — no record has yet fired on one,
 * and ADR-034's whole subject is that predicates written ahead of evidence are
 * how the arms race runs.
 *
 * Window-aware, like {@link isOverrideBoilerplateMention}: the token is excluded
 * only when EVERY occurrence in the slice sits inside a query span, so an agent
 * who also names the symbol in prose still fires. Occurrence-matching is plain
 * substring, which can over-report an occurrence inside a longer word — that
 * fails toward KEEPING the claim, the safe direction for a precision exclusion.
 */
const URL_QUERY_SPAN_RE = /[^\s`'"<>()[\]]*[?&][A-Za-z0-9_.~-]+=[^\s`'"<>()[\]]*/g;

/**
 * Does the part before the first `?`/`&` look like a URL?
 *
 * A SCHEME, or a dotted host — not merely a slash. PR #3031 R1 flagged that an
 * earlier `head.includes("/")` branch would accept `src/foo?x=1`, so an
 * identifier mentioned once in a path-shaped fragment could be suppressed. The
 * slash branch is gone; a head now needs `http(s)://` (which also admits
 * dotless hosts like `localhost:3000`) or a `name.tld`-shaped host.
 *
 * Residual bound, stated rather than papered over: a dotted filename followed by
 * a query — `foo.ts?x=1` — still reads as a host, because distinguishing a TLD
 * from a file extension needs a TLD list, and a stale list is a worse failure
 * than this one. It costs a suppression only when the token appears NOWHERE else
 * in the slice, since the caller requires every occurrence to be inside a span.
 */
const URL_HEAD_RE = /^(?:https?:\/\/\S+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:\/|$))/;

function hasUrlishHead(span: string): boolean {
  return URL_HEAD_RE.test(span.split(/[?&]/)[0] ?? "");
}

export function isUrlQueryParameterMention(tok: string, window: string): boolean {
  const spans: Array<readonly [number, number]> = [];
  for (const m of window.matchAll(URL_QUERY_SPAN_RE)) {
    if (!hasUrlishHead(m[0])) continue;
    const s = m.index ?? 0;
    spans.push([s, s + m[0].length] as const);
  }
  if (spans.length === 0) return false;

  let sawOccurrence = false;
  for (let at = window.indexOf(tok); at >= 0; at = window.indexOf(tok, at + 1)) {
    sawOccurrence = true;
    const inside = spans.some(([s, e]) => at >= s && at + tok.length <= e);
    if (!inside) return false;
  }
  return sawOccurrence;
}

/**
 * UPPERCASE-exact SQL/DDL keyword exclusion (mt#3042). A migration/DDL
 * discussion in prose ("`ALTER` ... `DROP` ... `CREATE`") extracts SQL
 * keywords as backticked "symbols" near the `drops?` predicate — the
 * 2026-07-21T16:12Z calibration record (the ask#5343 review's tokenizer-noise
 * FP class) logged `ALTER`/`DROP`/`CREATE` claims with predicate "DROP".
 * SQL DDL in prose is conventionally UPPERCASE, while genuine all-caps code
 * identifiers are MULTI_WORD_SNAKE (`MINSKY_SKIP_SIZE_JUSTIFICATION`), so an
 * UPPERCASE-exact match closes the observed class with minimal recall risk;
 * lowercase same-spelled identifiers (`create`, `drop`, `update` — real
 * method names) still count as symbols. Predicates are deliberately NOT
 * touched: `drops?` also matches genuine "X drops Y" behavioral claims.
 */
const SQL_KEYWORDS_UPPER: ReadonlySet<string> = new Set([
  "DROP",
  "CREATE",
  "ALTER",
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TABLE",
  "INDEX",
  "GRANT",
  "REVOKE",
  "TRUNCATE",
  "CASCADE",
  "CONSTRAINT",
]);

/**
 * Is this token plausibly a code symbol? Decided by SHAPE, minus the exclusion
 * list built up over five calibration rounds (mt#3113, mt#3002 x2, mt#3042,
 * mt#3540).
 *
 * **Before adding a sixth exclusion, read ADR-034.** mt#3549 proposed replacing
 * this whole predicate with an allowlist of symbols the repo actually defines,
 * which would retire every exclusion at once. It was REJECTED on measurement:
 * most claims this detector correctly fires on are about MCP tool names, env
 * vars, file names, guard names, and DB columns — real repo identifiers that a
 * TypeScript symbol index does not contain — so gating on one would convert
 * true positives into silent false negatives. ADR-034 also records the three
 * conditions that would reopen the question; a sixth round is a good moment to
 * check them rather than to write another predicate.
 *
 * **Round 6 has since been written, and it is NOT here** (mt#4157): the
 * URL-query-parameter exclusion needs the surrounding window, so it lives with
 * {@link isUrlQueryParameterMention} beside the other window-aware predicate
 * rather than in this token-only list, which still holds five rounds. Its doc
 * comment carries the reopen-condition check ADR-034 asks for; read it before
 * writing a SEVENTH, because two rounds inside 5 days is reopen condition 1 and
 * round 6 landed 2026-08-16.
 *
 * @see docs/architecture/adr-034-symbol-identification-in-code-mechanism-assertion.md
 */
function isPlausibleSymbol(tok: string): boolean {
  const t = tok.trim();
  if (t.length < 3) return false;
  if (SYMBOL_STOPLIST.has(t.toLowerCase())) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (FILE_EXTENSION_RE.test(t)) return false;
  if (HEX_ID_RE.test(t)) return false;
  if (SQL_KEYWORDS_UPPER.has(t)) return false;
  if (BARE_DIR_REF_RE.test(t)) return false;
  // mt#3540 — the four shapes the 2026-08-01 calibration pass classified as
  // false positives, all of them non-code text read as a code symbol.
  if (TITLE_CASE_UNDERSCORE_RE.test(t)) return false;
  if (TITLE_CASE_PATH_RE.test(t)) return false;
  if (PRODUCT_NAME_STOPLIST.has(t.toLowerCase())) return false;
  if (BARE_DIR_PATH_RE.test(t)) return false;
  return true;
}

/**
 * Collect distinct symbol-shaped tokens within `window` of `anchorIndex`.
 *
 * Backticks are stripped to yield the full token. The dotted-path last-segment
 * fallback was removed (PR #1697 R1): for a file path like `exec.ts` it produced
 * the extension `ts`/`json` as a "symbol", which both inflated claims and
 * spuriously marked claims backed when the extension happened to appear in the
 * corpus. Meaningful sub-identifiers inside a dotted token (e.g. `maxBuffer` in
 * `cfg.maxBuffer`) are still captured independently by CAMEL_CASE_RE/SNAKE_CASE_RE
 * scanning the slice, so no real symbol is lost.
 */
export function symbolsNear(text: string, anchorIndex: number, window: number): string[] {
  let start = Math.max(0, anchorIndex - window);
  let end = Math.min(text.length, anchorIndex + window);

  // Boundary expansion (mt#2673): a raw character-offset cut can land
  // MID-IDENTIFIER, making `\b` match at the cut point and emitting truncated
  // tails as separate "symbols" ("ion_pr_drive" / "on_pr_drive" from
  // "session_pr_drive" — the 2026-07-07 calibration records). Expand both
  // boundaries outward over WORD characters only (PR #1835 R1 nit: `/`, `-`,
  // `.` excluded so path-like prose never over-expands the slice) so a \w
  // token straddling the window is captured whole. A backticked span cut by
  // the window simply fails to match (missed, not junk) — only \w-token
  // truncation produced the junk-claims bug class.
  const wordChar = /\w/;
  while (start > 0 && wordChar.test(text[start - 1] ?? "") && wordChar.test(text[start] ?? "")) {
    start--;
  }
  while (
    end < text.length &&
    wordChar.test(text[end] ?? "") &&
    wordChar.test(text[end - 1] ?? "")
  ) {
    end++;
  }

  const slice = text.slice(start, end);

  // Collect occurrences with extraction class + position so dedup targets
  // SAME-CLASS STRICT CONTAINMENT only (PR #1835 R1 blocking finding): a
  // truncation residue occupies a range strictly inside the full token's
  // range in the same regex class, while a separately-mentioned substring
  // (`drive` alongside `session_pr_drive`) occupies a disjoint range, and a
  // camel sub-identifier inside a backticked dotted token (`maxBuffer` in
  // `cfg.maxBuffer`) is a different class — both of those are kept.
  type Occurrence = { tok: string; cls: "backtick" | "camel" | "snake"; s: number; e: number };
  const occs: Occurrence[] = [];

  for (const m of slice.matchAll(BACKTICK_SYMBOL_RE)) {
    const raw = m[1] ?? "";
    if (isPlausibleSymbol(raw)) {
      const s = (m.index ?? 0) + 1;
      occs.push({ tok: raw, cls: "backtick", s, e: s + raw.length });
    }
  }
  for (const m of slice.matchAll(CAMEL_CASE_RE)) {
    if (isPlausibleSymbol(m[0])) {
      occs.push({ tok: m[0], cls: "camel", s: m.index ?? 0, e: (m.index ?? 0) + m[0].length });
    }
  }
  for (const m of slice.matchAll(SNAKE_CASE_RE)) {
    if (isPlausibleSymbol(m[0])) {
      occs.push({ tok: m[0], cls: "snake", s: m.index ?? 0, e: (m.index ?? 0) + m[0].length });
    }
  }

  const found = new Set<string>();
  for (const o of occs) {
    const containedInSibling = occs.some(
      (p) => p.cls === o.cls && p.s <= o.s && p.e >= o.e && p.e - p.s > o.e - o.s
    );
    if (containedInSibling) continue;
    // mt#3540 — window-aware exclusion: an env var quoted inside a guard's
    // documented override line is discussion-framing, not a mechanism claim.
    // Needs the slice, so it cannot live in the token-only isPlausibleSymbol.
    if (isOverrideBoilerplateMention(o.tok, slice)) continue;
    // mt#4157 — window-aware exclusion, round 6: a token that appears ONLY as a
    // URL query parameter is part of a link, not a claim subject. Same reason
    // this cannot live in the token-only isPlausibleSymbol: it needs the slice.
    if (isUrlQueryParameterMention(o.tok, slice)) continue;
    found.add(o.tok);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Markdown elision (fenced blocks + blockquotes; KEEP inline code)
// ---------------------------------------------------------------------------

/**
 * Elide fenced code blocks and blockquotes (pasted output / quotes — not fresh
 * assertions) with same-length whitespace, preserving positions. Unlike the
 * causal-premise detector, inline code spans are KEPT, because a backticked
 * symbol inline (`executeCommand`) is exactly the claim we want to detect.
 */
export function elideBlocksAndQuotes(text: string): string {
  let result = text;
  // Fenced code blocks (``` or ~~~ fences, 3+ markers)
  result = result.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (m) =>
    " ".repeat(m.length)
  );
  // Blockquote lines (up to 3 leading spaces + one or more > markers)
  result = result.replace(/^[ \t]{0,3}>+.*$/gm, (m) => " ".repeat(m.length));
  return result;
}

// ---------------------------------------------------------------------------
// Same-turn verification corpus (tool inputs + tool_result content)
// ---------------------------------------------------------------------------

/**
 * Read-class tool names whose input paths/patterns count as inspection. Scoped
 * to exactly the spec's normative list (PR #1697 R1): Read / Grep / Glob /
 * session_read_file / repo_read_file / session_grep_search / repo_search. `Bash`,
 * `list_directory`, and a generic `search` suffix were removed — they would mark
 * a claim "backed" off an unrelated shell command or directory listing (silent
 * false negative). Bash-based inspection (grep/cat) still backs a claim via its
 * tool_result CONTENT, which is collected for all read-class results below.
 */
const READ_CLASS_TOOL_RE = /(?:^|_)(?:Read|Grep|Glob)$|(?:read_file|grep_search|repo_search)$/i;

/**
 * Collect the KEYS of a tool's input object (mt#4084).
 *
 * {@link collectStrings} walks `Object.values`, so a parameter NAME never enters
 * the corpus — which is why a claim about `expectedHeadSha`, a declared
 * parameter of a tool the turn actually called, read as unbacked.
 *
 * Keys only, never values: a value is content the AGENT chose and admitting it
 * would be the write-echo inversion mt#3489 split out of this corpus. A key is
 * different — the MCP boundary REJECTS undeclared parameters (mt#2778), so a key
 * present in a call that succeeded was validated against the tool's declared
 * schema rather than typed into prose.
 */
/**
 * A parameter key distinctive enough to admit as backing (PR #3046 R1).
 *
 * Admitting EVERY key over-suppresses: `message`, `content`, `task`, `path`,
 * `input` and `limit` are all extracted as symbols by `isPlausibleSymbol`
 * (verified by running it — they are not on ADR-034's generic-word exclusion
 * list), and `message` is a parameter of `session_commit`, which an agent calls
 * constantly. A claim like "`message` is truncated at N" would then be silently
 * backed by an unrelated commit in the same turn.
 *
 * So the key must carry its own shape — an internal capital (`expectedHeadSha`,
 * `overrideReason`, `notBefore`) or an underscore. That is not a heuristic
 * chosen ahead of evidence: every key in the measured silencing set
 * (`expectedHeadSha`, `overrideReason`, `notBefore`, `headSha`) is camelCase,
 * so the narrowing preserves all of them while excluding the bare-word class.
 */
const DISTINCTIVE_KEY_RE = /[a-z][A-Z]|_/;

function collectKeys(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (DISTINCTIVE_KEY_RE.test(key)) out.push(key);
      collectKeys(nested, out);
    }
  }
}

/**
 * Push a same-turn tool CALL RECORD into the verification corpus (mt#4084):
 * the tool's name plus its input parameter keys.
 *
 * Backing is a substring test, so the raw MCP-prefixed name is all that is
 * needed — `mcp__minsky__refs_status` in the corpus already backs a claim
 * written as `refs_status`. No prefix-stripping or alias layer, and no second
 * matching layer beside the corpus (SC1's "change the gate, not the backing"
 * constraint, from mt#3594).
 */
function collectCallRecord(name: string, input: unknown, out: string[]): void {
  if (name !== "") out.push(name);
  collectKeys(input, out);
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

/**
 * Tool names whose `tool_result` echoes content the AGENT itself just authored
 * (mt#3489). A write tool's result repeats the payload that was sent to it —
 * `session_search_replace` echoes `searchText`/`replaceText`, `Write` echoes the
 * written content — so the symbols in it were WRITTEN, not inspected.
 *
 * Before this split, those echoes landed in the verification corpus alongside
 * genuine reads, which meant a claim about code the agent had just written was
 * treated as BACKED and suppressed. That is the inversion mem#736 names: "Self-
 * authorship is an aggravating factor, not a mitigating one." The detector's
 * blind spot sat exactly where self-authored claims live.
 *
 * Measured before the split (`.minsky/code-mechanism-assertion-calibration.jsonl`,
 * 298 records): 108 carried `same-turn-read`, 58 of them suppressed by that
 * reason ALONE — and nothing in the record distinguished a read from a write
 * echo, so the size of this class was unknown rather than small.
 */
/**
 * Membership rule, so this list can be extended without guessing: a tool belongs
 * here when its `tool_result` reflects back CONTENT THE AGENT SUPPLIED, rather
 * than state the tool went and read. `session_search_replace` qualifies (it
 * echoes `searchText`/`replaceText`); `session_commit` qualifies (it echoes the
 * message the agent wrote); `git_status` does not (it reports observed state).
 *
 * Erring inclusive is the safe direction WHILE both reasons suppress. A genuine
 * read misclassified as a write echo stops backing its claim, so the claim is
 * labeled `write-echo-backed` instead of `same-turn-read` — a mislabel in the
 * calibration record, with no injection consequence. A write tool MISSING from
 * this list keeps the original bug alive for that tool. The costs are not
 * symmetric, so prefer adding.
 *
 * That asymmetry ends if the `write-echo-backed` leg is ever removed to let these
 * claims surface: a false member would then surface claims that were genuinely
 * read-backed. Re-audit this list as part of that decision, not before.
 */
const WRITE_CLASS_TOOL_RE =
  /(?:^|_)(?:Write|Edit|MultiEdit|NotebookEdit)$|(?:session_write_file|session_search_replace|session_edit_file|session_move_file|session_rename_file|session_delete_file|session_create_directory|session_commit|session_pr_create|session_pr_edit|tasks_create|tasks_edit|tasks_spec_patch|tasks_spec_search_replace|memory_create|memory_update|asks_create|asks_respond|asks_edit)$/i;

/**
 * Map `tool_use.id` -> tool name across a turn.
 *
 * A `tool_result` block names only the `tool_use_id` it answers, never the tool
 * — so attributing a result to the tool that produced it requires this
 * correlation. Verified against a real transcript (2026-08-01): every
 * `tool_result.tool_use_id` matches an assistant `tool_use.id` in the turn.
 */
function buildToolNameById(turnLines: TranscriptLine[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const line of turnLines) {
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;
    if (role !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block["type"] !== "tool_use") continue;
      const id = block["id"];
      const name = block["name"];
      if (typeof id === "string" && typeof name === "string") byId.set(id, name);
    }
  }
  return byId;
}

/**
 * Split the turn's tool evidence into the READ corpus (genuine inspection) and
 * the WRITE-ECHO corpus (the agent's own authored payload, reflected back).
 *
 * Single traversal so the two can never drift apart. A `tool_result` whose
 * originating tool cannot be identified counts as READ — the conservative
 * default, since it preserves the pre-mt#3489 suppression behavior rather than
 * surfacing a claim on evidence we cannot attribute.
 */
/**
 * Corpus options (mt#4084). Exists for ONE consumer: the backing replay's BEFORE
 * arm, which must reproduce pre-mt#4084 behavior from the SHIPPED builder rather
 * than from a copy of the old logic that can drift out of sync with it.
 */
export interface VerificationCorpusOptions {
  /** Include same-turn tool names + parameter keys. Defaults to true (shipped behavior). */
  includeCallRecord?: boolean;
}

function buildCorpora(
  turnLines: TranscriptLine[],
  options: VerificationCorpusOptions = {}
): { read: string; writeEcho: string } {
  const includeCallRecord = options.includeCallRecord !== false;
  const toolNameById = buildToolNameById(turnLines);
  const readParts: string[] = [];
  const writeParts: string[] = [];

  for (const line of turnLines) {
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;

    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        // Read-class tool INPUT — authentic tool_use lives on ASSISTANT lines.
        if (role === "assistant" && block["type"] === "tool_use") {
          const name = (block["name"] as string) ?? "";
          if (READ_CLASS_TOOL_RE.test(name)) {
            collectStrings(block["input"], readParts);
          }
          // mt#4084 — the CALL RECORD backs claims about the call, for EVERY
          // tool rather than only read-class ones. The name attests the harness
          // ran it; the keys are schema-validated by the MCP boundary. Neither
          // is producible by asserting, which is the test that keeps the agent's
          // own prose out (settled mt#4157).
          if (includeCallRecord) collectCallRecord(name, block["input"], readParts);
        }
        // tool_result CONTENT — authentic tool outputs live on USER-role lines
        // (Claude Code records tool_result as user role). Role-gating prevents an
        // assistant-echoed tool_result block from counting as backing (PR #1697 R1).
        if (role === "user" && block["type"] === "tool_result") {
          const originId = block["tool_use_id"];
          const originName = typeof originId === "string" ? toolNameById.get(originId) : undefined;
          const isWriteEcho = originName !== undefined && WRITE_CLASS_TOOL_RE.test(originName);
          collectStrings(block["content"], isWriteEcho ? writeParts : readParts);
        }
      }
    }

    // Top-level tool_use line shape (defensive; assistant-side inspection).
    if (line.type === "tool_use") {
      const name = line.name ?? line.tool_name ?? "";
      if (READ_CLASS_TOOL_RE.test(name)) {
        collectStrings(line.input, readParts);
      }
      // Same widening on the top-level line shape — a turn recorded this way
      // must not produce a different verdict from the nested one (mt#3650 is
      // the standing example of exactly that divergence).
      if (includeCallRecord) collectCallRecord(name, line.input, readParts);
    }
  }

  return { read: readParts.join("\n"), writeEcho: writeParts.join("\n") };
}

/**
 * Build the same-turn verification corpus: the concatenation of
 *   - read-class tool_use INPUT strings (file paths, grep patterns, queries), and
 *   - tool_result CONTENT in the turn (so a read of a symbol's file backs a
 *     claim about that symbol — the file source lands in the result),
 *     EXCLUDING results echoed back by write-class tools (mt#3489).
 *
 * A symbol that appears in this corpus was inspected this turn. A symbol that
 * appears only in the write-echo corpus was AUTHORED this turn, which is not
 * the same thing and must not back a claim about it.
 *
 * ## The agent's own prose is NOT backing — decided 2026-08-16 (mt#4157)
 *
 * Settled here so the next calibration pass does not re-litigate it. Three of
 * the 2026-08-14 pass's eight false positives arrived with their evidence in the
 * same sentence — "Re-running against a real MCP server gave
 * `descendantsRequiredSigkill: 1`", "the exact flagged command returns 76 matches
 * at exit 0 on Darwin", "both failed on `CONNECT_TIMEOUT`". Each reads as
 * maximally well-evidenced and each was recorded unbacked, because a claim the
 * agent states in its own prose is not in this corpus.
 *
 * **Admitting prose was rejected.** It is circular: an agent could back any
 * claim by asserting confidently, and suppression would land exactly on "I
 * checked" — the sentence this detector exists to doubt. Self-authorship is an
 * aggravating factor, not a mitigating one (mem#736), and mt#3489 already split
 * write-echo out of this corpus for the same reason.
 *
 * **The narrower variant the spec floated needs no code — it is what this corpus
 * already does.** "An observation naming a value the tool corpus ALSO contains"
 * is precisely a symbol appearing here, and it already suppresses. The records
 * show the mechanism working: `descendantsRequiredSigkill` fired at
 * 2026-08-13T16:39Z with `hadSameTurnRead: false, backedClaimCount: 0`, and the
 * SAME symbol was suppressed at 17:15Z as `same-turn-read` once a real read
 * existed. All three class members carry `hadSameTurnRead: false` and
 * `backedClaimCount: 0` — there was no tool evidence in the turn to admit.
 *
 * **What is left is a WINDOW question, not a prose question, and it is not
 * ours.** If the read happened an earlier turn in the same session, the evidence
 * is machine-recorded and merely out of frame. Widening same-turn to
 * session-scope is the ask#6817 disposition that mt#3594 owns, and it is gated
 * there on per-claim backing landing first — a session-scoped read of ANYTHING
 * would otherwise back EVERYTHING. Do not widen this corpus's time window here.
 */
export function buildVerificationCorpus(
  turnLines: TranscriptLine[],
  options?: VerificationCorpusOptions
): string {
  return buildCorpora(turnLines, options).read;
}

/**
 * The turn's write-class `tool_result` content — what the agent authored, not
 * what it inspected. Used to label a claim `write-echo-backed` rather than
 * silently treating authorship as verification.
 */
export function buildWriteEchoCorpus(turnLines: TranscriptLine[]): string {
  return buildCorpora(turnLines).writeEcho;
}

/**
 * Input keys carrying the NEW content of a write, and the keys carrying the text
 * it replaces. Both spellings exist because `session_search_replace` accepts the
 * Claude Code aliases (`old_string`/`new_string`) alongside its own
 * (`search`/`replace`).
 */
const WRITE_INPUT_NEW_KEYS = ["replace", "new_string", "content", "contents"];
const WRITE_INPUT_OLD_KEYS = ["search", "old_string"];

/** Keys carrying a whole-file body — no old text accompanies these. */
const WHOLE_FILE_INPUT_KEYS = ["content", "contents"];

/**
 * A single-line comment, a block-comment body line, or a JSDoc continuation.
 *
 * `#!` is excluded: a shebang is not a comment about anything, and matching it
 * would put an interpreter path into the claim corpus (PR #2549 R1).
 */
const COMMENT_LINE_RE = /^\s*(?:\/\/+|\/\*+|\*(?!\/)|#(?!!))\s?(.*)$/;

/**
 * Extract comment text that this turn's writes ADDED (mt#3571).
 *
 * Why the ADDED qualifier is load-bearing: a claim is worth surfacing when the
 * agent WRITES it, not every time a diff happens to carry it. Scanning whole
 * files — or even whole replacement payloads — would re-flag untouched comments
 * on every edit to a well-commented file, which is noise that trains readers to
 * ignore the detector (mem#719: a detector emitting unmatchable output erodes
 * trust in its correct output).
 *
 * So for a search/replace the old text's comment lines are subtracted from the
 * new text's: a comment that merely moved is not an assertion being made.
 *
 * A whole-file write carries no old text, so "added" cannot be computed from the
 * payload — and treating every line as added would be exactly the whole-file
 * scan this is supposed to avoid (PR #2549 R1). Such a write is therefore
 * included ONLY when its `tool_result` reports `created: true`, i.e. the file did
 * not previously exist, which makes every comment in it genuinely new. An
 * overwrite of an existing file is skipped, and so is a write whose result
 * cannot be found or does not carry the flag — absent evidence, exclude.
 *
 * Consequence worth knowing: comments added by OVERWRITING an existing file are
 * not covered. Covering them needs a before-image the payload does not carry.
 *
 * Reads the tool INPUT for content rather than the `tool_result` echo (the input
 * is exactly what the agent authored, with no envelope to strip) and the RESULT
 * only for the `created` flag.
 */
/**
 * True when a `tool_result` body reports a TOP-LEVEL `created: true`.
 *
 * Parsed, not regexed (PR #2549 R1). A regex over the stringified body has a
 * real false-positive path: writing a JSON file whose own CONTENT contains
 * `"created": true` would match, and the result envelope echoes that content —
 * so authoring a fixture could make the detector believe a file was newly
 * created. Reading the parsed top-level field cannot be fooled by nested or
 * echoed text.
 *
 * Unparseable or unexpected shapes return false: absent evidence, exclude.
 */
function resultReportsCreated(raw: unknown): boolean {
  const fromValue = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    return (value as Record<string, unknown>)["created"] === true;
  };

  if (typeof raw === "string") {
    try {
      return fromValue(JSON.parse(raw));
    } catch {
      return false; // not JSON — no claim about creation
    }
  }
  // Claude Code may deliver a result as an array of content blocks.
  if (Array.isArray(raw)) {
    return raw.some((block) => {
      const text = (block as Record<string, unknown> | null)?.["text"];
      return typeof text === "string" && resultReportsCreated(text);
    });
  }
  return fromValue(raw);
}

/**
 * `tool_use.id`s whose correlated result reports the write CREATED the file.
 *
 * Shared by the two corpora that must tell a new file from an overwrite:
 * {@link buildAddedCommentCorpus} (every comment in a new file is genuinely
 * added) and {@link buildArtifactProseCorpus}'s durable-file branch (mt#4534 —
 * every claim in a new doc is genuinely being asserted now). Extracted rather
 * than copied because the two would otherwise answer the same question from two
 * traversals that can drift.
 */
function collectCreatedToolUseIds(turnLines: TranscriptLine[]): Set<string> {
  const created = new Set<string>();
  for (const line of turnLines) {
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;
    if (role !== "user" || !Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block["type"] !== "tool_result") continue;
      const id = block["tool_use_id"];
      if (typeof id !== "string") continue;
      if (resultReportsCreated(block["content"])) created.add(id);
    }
  }
  return created;
}

export function buildAddedCommentCorpus(turnLines: TranscriptLine[]): string {
  const commentLines = (text: string): string[] => {
    const out: string[] = [];
    for (const raw of text.split("\n")) {
      const m = raw.match(COMMENT_LINE_RE);
      const body = m?.[1]?.trim();
      if (body) out.push(body);
    }
    return out;
  };

  const pick = (input: Record<string, unknown>, keys: string[]): string =>
    keys
      .map((k) => input[k])
      .filter((v): v is string => typeof v === "string")
      .join("\n");

  // `created: true` on the correlated result is the only signal distinguishing a
  // NEW file (every comment genuinely added) from an overwrite (most of them
  // pre-existing). Absent, the write is skipped.
  const createdByToolUseId = collectCreatedToolUseIds(turnLines);

  // Deduped: the same comment written by two tools in one turn is one assertion,
  // and duplicates would inflate the claim corpus (PR #2549 R1).
  const added = new Set<string>();

  for (const line of turnLines) {
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;
    if (role !== "assistant" || !Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block["type"] !== "tool_use") continue;
      const name = (block["name"] as string) ?? "";
      if (!WRITE_CLASS_TOOL_RE.test(name)) continue;
      const input = block["input"];
      if (!input || typeof input !== "object") continue;

      const asRecord = input as Record<string, unknown>;
      const oldText = pick(asRecord, WRITE_INPUT_OLD_KEYS);
      const isWholeFile = oldText.length === 0 && pick(asRecord, WHOLE_FILE_INPUT_KEYS).length > 0;
      if (isWholeFile) {
        const id = block["id"];
        if (typeof id !== "string" || !createdByToolUseId.has(id)) continue;
      }

      const newComments = commentLines(pick(asRecord, WRITE_INPUT_NEW_KEYS));
      if (newComments.length === 0) continue;

      const oldComments = new Set(commentLines(oldText));
      for (const c of newComments) {
        if (!oldComments.has(c)) added.add(c);
      }
    }
  }

  return [...added].join("\n");
}

/**
 * Tools whose payload IS a durable artifact the principal or a future agent
 * reads as a record (mt#3642). Narrower than {@link WRITE_CLASS_TOOL_RE}, which
 * also covers ordinary source edits: a claim in a PR body is read as the
 * justification for merging, and one in a spec or memory is read later as
 * settled fact.
 */
/**
 * **This list is a CLAIM about every path by which agent prose reaches a durable
 * artifact — and it goes stale the moment one opens or is avoided (mt#4525).**
 *
 * Not a preference and not a performance bound: any name missing here is prose the
 * corpus cannot see, and the miss is silent because an unlisted tool simply
 * contributes nothing. There is no error to notice.
 *
 * **Review trigger — treat this regex as part of a new write path's consumer set.**
 * When a tool that writes a spec, a PR body, a memory or an ask ships, this line is
 * one of the things that must change with it (the gate-(h) contract-propagation
 * enumeration, applied to a guard's own allowlist).
 *
 * `tasks_edit` was absent until mt#4525, so a spec written through it — inline via
 * `specContent` or by reference via `specFile` — reached this corpus through neither
 * path, while the same prose written through `tasks_spec_patch` was watched.
 *
 * **Known and NOT covered by this regex, deliberately:**
 *
 * - **A CLI-routed write** (`minsky tasks edit --spec-file …` through `Bash`). The
 *   prose never appears as an MCP tool input at all; it reaches the DB through a
 *   subprocess, so there is no `tool_use` name for this regex to match. Adding a name
 *   here cannot fix it. **Owned by mt#4536**, which also records that half its
 *   mechanism already shipped: `cli-mcp-substitution` (mt#4144) maps a Bash command
 *   string back to its registry command id via `completion-manifest.json`. This is
 *   the channel an agent switches to when the MCP path is failing — i.e. exactly when
 *   it is least likely to notice the coverage it just lost.
 * - **A git-tracked repo file** (an ADR, a rule, a doc) written via `Write`/`Edit`.
 *   A different artifact CLASS rather than a missing name — which is why mt#4534
 *   did not answer it by adding names HERE. It is covered as of mt#4534, by the
 *   path-keyed branch this regex's builder runs alongside: see
 *   {@link DURABLE_DOC_PATH_RE}. The `Bash` half of that channel remains
 *   uncovered, deliberately — {@link FILE_WRITE_TOOL_RE} records why and who
 *   owns it.
 */
const ARTIFACT_TOOL_RE =
  /(?:session_pr_create|session_pr_edit|tasks_create|tasks_edit|tasks_spec_patch|tasks_spec_search_replace|memory_create|memory_update|asks_create)$/i;

/**
 * Input keys carrying an artifact's PROSE body across those tools: a PR body,
 * a task spec or spec patch, a memory body, an ask's question text.
 *
 * `specContent` is `tasks_edit`'s inline body (mt#4525). Note that `spec` is ALSO in
 * this list and is `tasks_create`'s body — but on `tasks_edit` the `spec` parameter
 * is a BOOLEAN flag, not prose. The `typeof value === "string"` test in
 * {@link buildArtifactProseCorpus} is what keeps that from mattering, so do not
 * relax it into a truthiness check. PR #3063 R1 read those two as the same key on the
 * sibling detector and was wrong.
 */
const ARTIFACT_PROSE_INPUT_KEYS = [
  "body",
  "spec",
  "specContent",
  "content",
  "question",
  "replace",
  "new_string",
];

/**
 * Inline-body keys handed to the shared spec-text resolver for the BY-REFERENCE
 * branch (mt#4525).
 *
 * Deliberately narrow: only `tasks_edit` accepts a `specFile`, and the resolver
 * checks the inline key first so this map keeps it from re-reading a body the key
 * loop above already collected. It is NOT this detector's scanning scope —
 * {@link ARTIFACT_TOOL_RE} is — and it is passed in rather than shared, so extracting
 * the resolver could not silently widen what any guard reads.
 */
const ARTIFACT_SPEC_INLINE_KEYS: Readonly<Record<string, string>> = {
  tasks_edit: "specContent",
};

/**
 * Tools that write a git-tracked repo FILE, as opposed to a Minsky entity
 * (mt#4534).
 *
 * A different artifact CLASS from {@link ARTIFACT_TOOL_RE}'s, not a missing
 * name — which is why coverage here is keyed on the written PATH rather than on
 * the tool. `Write` is not an artifact tool; `Write` to
 * `docs/architecture/adr-006-agent-identity.md` is.
 *
 * A subset of {@link WRITE_CLASS_TOOL_RE}: the entity writers are already
 * covered above, and the non-content operations (move/rename/delete/mkdir/
 * commit) carry no prose to scan.
 *
 * **Deliberately absent, each for its own reason:**
 *
 * - **`Bash`** — a heredoc or `sed -i` into a doc, which is the shape the
 *   originating incident actually used and the one auto mode steers toward.
 *   Left out because the CLASS is **owned by mt#4536**, which decides the
 *   mechanism once for the five guards blind to this surface; a bespoke
 *   command-string parser here would be the fourth hand-rolled copy that task
 *   exists to prevent. Not left out as intractable: mt#4536 judges the shape
 *   hard because the hook sees shell variables UNEXPANDED, and that bounds the
 *   command string, not the artifact — the authored text is recoverable from
 *   the file's diff afterward, as {@link buildAddedCommentCorpus} already does
 *   for comments.
 * - **`MultiEdit` / `NotebookEdit`** — their payloads nest the new text inside
 *   an `edits` array rather than at the top level, so listing them would add a
 *   name that contributes nothing while reading as coverage. Named here instead,
 *   which is the enumerated-gap form this repo prefers to a silent no-op.
 */
const FILE_WRITE_TOOL_RE =
  /(?:^|_)(?:Write|Edit)$|(?:session_write_file|session_search_replace|session_edit_file)$/i;

/**
 * The subset of {@link FILE_WRITE_TOOL_RE} whose payload is a WHOLE file.
 *
 * Classified by TOOL, not by input key — `session_edit_file` carries a PARTIAL
 * payload (an edit pattern with `// ... existing code ...` markers) under
 * `content`, which is also a {@link WHOLE_FILE_INPUT_KEYS} member, so the
 * key-shaped test {@link buildAddedCommentCorpus} uses would misread every
 * `session_edit_file` call as a whole-file write and gate it on a `created`
 * flag it will never have.
 */
const WHOLE_FILE_WRITE_TOOL_RE = /(?:^|_)Write$|session_write_file$/i;

/**
 * Input keys naming the file a write targets. `Write`/`Edit` use `file_path`;
 * the `session_*` writers use `path`.
 *
 * The same two-family split `extractTargetPath` encodes in
 * `check-generated-file-edit.ts`. Kept as a local key list rather than a call
 * into that helper because it resolves the path to an ABSOLUTE one against a
 * `cwd` this builder does not have, while the pattern below wants the path as
 * the agent wrote it.
 */
const FILE_PATH_INPUT_KEYS = ["file_path", "path"];

/**
 * **A claim about which repo files are DECISION RECORDS** — where prose an agent
 * writes is read later as settled fact, by the principal or by another agent,
 * rather than as a passing note (mt#4534).
 *
 * Each member is here for that property, not for its extension:
 *
 * - **`docs/**`** — ADRs, `docs/rules-rationale/**`, incident write-ups. An ADR
 *   is the canonical decision record for a choice, and `claim-confidence.mdc`
 *   treats this tree as citable evidence — which is exactly what makes a false
 *   claim written into it expensive.
 * - **`.minsky/rules/**`** — the rule corpus SOURCE, compiled into every
 *   agent's always-loaded context.
 * - **any `*.md` / `*.mdc`** — skills, agent definitions, READMEs: prose whose
 *   whole purpose is to be read as instruction.
 *
 * NOT here: source files. A claim in a `.ts` comment belongs to
 * {@link buildAddedCommentCorpus}, and admitting it would double-count it.
 *
 * **Review trigger — the same contract {@link ARTIFACT_TOOL_RE} carries, and
 * the same failure mode.** This is a claim that goes stale, and its miss is
 * silent: a durable prose tree outside these three contributes nothing, with no
 * error to notice. When a new tree of agent-authored prose ships, this pattern
 * is part of its consumer set.
 */
const DURABLE_DOC_PATH_RE = /(?:^|\/)docs\/|(?:^|\/)\.minsky\/rules\/|\.mdc?$/i;

/**
 * True when a payload IS a compile output, recognised by the generation banner
 * it carries.
 *
 * Compiled outputs — `CLAUDE.md`, `.cursor/rules/*.mdc`, `.claude/skills/ * /
 * SKILL.md` — match {@link DURABLE_DOC_PATH_RE} on extension, but their prose is
 * a PROJECTION of a source rule rather than a claim authored at that path.
 * Admitting one would enter the entire rule corpus as a fresh assertion every
 * time a target is regenerated.
 *
 * Recognised by CONTENT via mt#1798's shared banner patterns — the same single
 * source of truth the compile writers emit and `check-generated-file-edit`
 * detects with — rather than by a path list, so it cannot drift when a new
 * compile target ships. That drift is the failure a path list has and mt#1798
 * exists to prevent.
 *
 * Belt-and-braces rather than load-bearing: `check-generated-file-edit` DENIES a
 * banner-bearing write at PreToolUse, so such a payload should not reach a
 * transcript at all.
 */
function isGeneratedOutputPayload(text: string): boolean {
  const head = text.split("\n", 5).join("\n");
  return GENERATION_BANNER_PATTERNS.some(({ re }) => re.test(head));
}

/**
 * Extract the prose an agent wrote INTO a durable artifact this turn (mt#3642).
 *
 * Why this surface exists: the chat corpus is `extractAssistantText`, i.e.
 * assistant `text` blocks. Everything an agent writes for the record — a PR
 * body, a spec patch, a memory, an ask — reaches the transcript as a `tool_use`
 * INPUT instead, so the same sentence is watched in chat, where it is ephemeral
 * and the principal can contradict it, and unwatched in the artifact, where it
 * is durable and outlives the conversation. mt#3092's false socket-contract
 * claim was in a PR body and produced no calibration record at all.
 *
 * Distinct from {@link buildAddedCommentCorpus}, which takes COMMENT LINES out
 * of source-edit payloads. This takes the whole prose body of an artifact
 * payload. The two overlap on a markdown payload — `# Heading` matches the
 * comment-line pattern — and that is left alone deliberately: the surfaces are
 * recorded in separate fields and measured separately, so overlap shows up in
 * the data rather than being silently resolved here.
 *
 * ## Two artifact CLASSES, gated differently (mt#4534)
 *
 * A **Minsky entity** — a PR body, a spec, a memory, an ask — is gated on the
 * TOOL that wrote it ({@link ARTIFACT_TOOL_RE}). A **git-tracked repo file** —
 * an ADR, a rule, a doc — is gated on the PATH it was written to
 * ({@link DURABLE_DOC_PATH_RE}), because the tools that write one (`Write`,
 * `Edit`, the `session_*` writers) also write ordinary source, so the tool name
 * cannot tell the two apart. That is the distinction mt#4534 exists to draw:
 * for a year the corpus grew by tool name while an entire artifact class — the
 * one that outlives the conversation most reliably — stayed invisible, because
 * "prose an agent authored" splits into WHICH TOOL CARRIED IT and WHICH ARTIFACT
 * IT LANDED IN, and only the first was ever enumerated.
 *
 * No ADDED-only subtraction on the ENTITY class, unlike the comment corpus. A
 * spec patch or PR body is authored wholesale rather than edited line-by-line,
 * and its payload is what the agent is asserting right now. `tasks_spec_patch`
 * carries unchanged regions as `// ... existing code ...` markers rather than as
 * text, so re-flagging untouched prose is not the failure mode it is for a
 * source edit.
 *
 * The FILE class does not inherit that, and the difference is real rather than
 * an inconsistency: an ADR is amended incrementally, so a whole-file rewrite
 * re-sends prose the agent is not asserting. Whole-file writes there are gated
 * on a `created` result exactly as the comment corpus gates them; targeted edits
 * are not, their payload being the new text by construction.
 *
 * Reads the tool INPUT, never the `tool_result` echo — the input is exactly what
 * the agent authored.
 */
export function buildArtifactProseCorpus(
  turnLines: TranscriptLine[],
  /**
   * Reader for the BY-REFERENCE (`specFile`) branch (mt#4525). Injectable so that
   * branch is testable without touching a real filesystem —
   * `testing-standards.mdc §Testable Design`, and the seam
   * `custom/no-real-fs-in-tests` exists to require. Defaults to the shared
   * repo-contained disk read.
   */
  readFile?: (path: string) => string | null
): string {
  const parts = new Set<string>();
  const createdByToolUseId = collectCreatedToolUseIds(turnLines);

  /**
   * A durable repo FILE this write targets — an ADR, a rule, a doc (mt#4534).
   *
   * Separate from the entity branch below and reached by a disjoint tool set, so
   * the two are independent `if`s rather than alternatives: if a name ever lands
   * in both, `parts` is a Set and the prose is collected once.
   */
  const collectDurableFileProse = (
    name: string,
    asRecord: Record<string, unknown>,
    toolUseId: string | undefined
  ): void => {
    const path = FILE_PATH_INPUT_KEYS.map((k) => asRecord[k]).find(
      (v): v is string => typeof v === "string" && v.trim().length > 0
    );
    if (path === undefined || !DURABLE_DOC_PATH_RE.test(path)) return;

    // A whole-file write is included ONLY when its result reports the file was
    // CREATED — the same bar, and the same reason, as
    // `buildAddedCommentCorpus`. Rewriting an existing doc re-sends every
    // paragraph already in it, and scanning those would re-flag prose the agent
    // is not asserting now; that is the noise mem#719 warns trains readers to
    // ignore a detector. A targeted edit needs no such gate: its payload is the
    // new text by construction.
    //
    // Consequence, stated rather than left to be discovered: a claim ADDED while
    // overwriting an existing doc is not covered. Covering it needs a
    // before-image the payload does not carry — the identical carve-out the
    // comment corpus records.
    if (WHOLE_FILE_WRITE_TOOL_RE.test(name)) {
      if (toolUseId === undefined || !createdByToolUseId.has(toolUseId)) return;
    }

    for (const key of WRITE_INPUT_NEW_KEYS) {
      const value = asRecord[key];
      if (typeof value !== "string" || value.trim().length === 0) continue;
      if (isGeneratedOutputPayload(value)) continue;
      parts.add(value);
    }
  };

  const collect = (name: string, input: unknown, toolUseId?: string): void => {
    if (!input || typeof input !== "object") return;
    const asRecord = input as Record<string, unknown>;
    if (FILE_WRITE_TOOL_RE.test(name)) collectDurableFileProse(name, asRecord, toolUseId);
    if (!ARTIFACT_TOOL_RE.test(name)) return;
    for (const key of ARTIFACT_PROSE_INPUT_KEYS) {
      const value = asRecord[key];
      if (typeof value === "string" && value.trim().length > 0) parts.add(value);
    }

    // A body carried by REFERENCE, not inline (mt#4525). `tasks_edit --spec-file`
    // names a path whose CONTENTS become the spec, so the key loop above sees a
    // filename and adds nothing — the same silent recall hole this detector's two
    // sibling guards each hit independently. The shared resolver reads it
    // defensively: a missing, oversized, unreadable, or out-of-repo path yields null
    // rather than throwing, because an observer must never turn a valid `tasks_edit`
    // into an error. `parts` is a Set, so a call carrying BOTH keys contributes its
    // prose once.
    const byReference = readAuthoredSpecText(name, asRecord, ARTIFACT_SPEC_INLINE_KEYS, readFile);
    if (byReference.text !== null && byReference.text.trim().length > 0) {
      parts.add(byReference.text);
    }
  };

  for (const line of turnLines) {
    // BOTH shapes, per `TranscriptLine`'s own note ("tool_use lines may carry
    // name/input at top level OR inside message.content") and the precedent in
    // `extractToolUseNames` (`transcript.ts:722-738`), which has handled both
    // since it was written. Handling only the nested shape made a turn recorded
    // in the top-level shape invisible to this surface — PR #2584 R1.
    // No `id` on this shape, so a whole-file write recorded here cannot be
    // confirmed as a creation and is skipped — absent evidence, exclude, as
    // everywhere else the `created` flag is consulted.
    if (line.type === "tool_use") collect(line.name ?? line.tool_name ?? "", line.input);

    const role = line.message?.role ?? line.type;
    const content = line.message?.content;
    if (role !== "assistant" || !Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block["type"] !== "tool_use") continue;
      const id = block["id"];
      collect(
        (block["name"] as string) ?? "",
        block["input"],
        typeof id === "string" ? id : undefined
      );
    }
  }

  return [...parts].join("\n");
}

// ---------------------------------------------------------------------------
// Relay-context detection (mt#3113 leg 3)
// ---------------------------------------------------------------------------

/**
 * Tool names that dispatch or resume a subagent in this harness. A claim
 * whose content is found inside one of these tools' `tool_result` in the
 * SAME turn is very likely a RELAY of the subagent's own report — the
 * subagent performed the read; the parent turn is quoting/paraphrasing its
 * findings, not asserting them fresh and unverified.
 */
const SUBAGENT_DISPATCH_TOOL_RE = /^(?:Agent|Task|SendMessage)$/;

/**
 * Relay-preamble phrasing (mt#3113 leg 3) — a prose marker that the
 * surrounding text is REPORTING what a dispatched subagent/background task
 * found, rather than a fresh first-person assertion. Catches the
 * cross-turn case `buildRelayCorpus`'s same-turn tool_result correlation
 * cannot see (the subagent completed in an earlier turn; this turn merely
 * narrates its already-reported findings) as well as same-turn narration
 * that doesn't literally repeat the subagent's tool_result text verbatim.
 * Deliberately narrow/high-precision (mirrors the RELAY_PREAMBLE naming
 * convention of this file's PREDICATE_PATTERNS) — calibration will surface
 * any additional phrasing worth adding.
 */
export const RELAY_PREAMBLE_PATTERNS: RegExp[] = [
  /\b(?:the\s+)?(?:sub[- ]?agent|dispatched agent|implementer agent|reviewer agent)\s+(?:found|reports?|reported|confirms?|confirmed|says?|said|notes?|noted)\b/i,
  /\bper\s+the\s+(?:sub[- ]?agent|dispatched agent)'?s?\s+(?:report|findings?)\b/i,
  /\bthe\s+(?:sub[- ]?agent|dispatched agent)'s\s+(?:report|findings?|analysis)\b/i,
  /\btask[- ]notification\b/i,
  /\baccording to (?:the\s+)?(?:sub[- ]?agent|the dispatched agent)\b/i,
];

/**
 * Build the same-turn relay corpus: the concatenation of every subagent
 * dispatch/resume tool's `tool_result` CONTENT in the turn, correlated by
 * `tool_use_id` (mirrors `transcript.ts`'s `findCreatedResourceIds`
 * pass-1/pass-2 id-correlation pattern). Distinct from
 * {@link buildVerificationCorpus}, which collects EVERY tool_result in the
 * turn regardless of source (that corpus answers "was this symbol read this
 * turn?"; this one answers "did a DISPATCHED SUBAGENT's own report already
 * contain this claim?" — the relay-context signal).
 */
export function buildRelayCorpus(turnLines: TranscriptLine[]): string {
  const dispatchIds = new Set<string>();
  for (const line of turnLines) {
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;
    if (role === "assistant" && Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (
          block["type"] === "tool_use" &&
          typeof block["name"] === "string" &&
          SUBAGENT_DISPATCH_TOOL_RE.test(block["name"] as string) &&
          typeof block["id"] === "string"
        ) {
          dispatchIds.add(block["id"] as string);
        }
      }
    }

    // Top-level tool_use line shape (defensive; mirrors
    // buildVerificationCorpus's identical fallback above — PR #2236 R1/R2
    // finding: the harness can emit a dispatch tool_use as a top-level line
    // rather than nested inside message.content, and without this branch
    // dispatchIds silently stays empty for that shape).
    if (line.type === "tool_use") {
      const name = line.name ?? line.tool_name ?? "";
      const id = (line as Record<string, unknown>)["id"];
      if (SUBAGENT_DISPATCH_TOOL_RE.test(name) && typeof id === "string") {
        dispatchIds.add(id);
      }
    }
  }
  if (dispatchIds.size === 0) return "";

  const parts: string[] = [];
  for (const line of turnLines) {
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;
    if (role !== "user" || !Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block["type"] === "tool_result" &&
        typeof block["tool_use_id"] === "string" &&
        dispatchIds.has(block["tool_use_id"] as string)
      ) {
        collectStrings(block["content"], parts);
      }
    }
  }
  return parts.join("\n");
}

export interface RelayDetectionResult {
  /** true when the claim set appears to be relayed from a subagent, not freshly asserted. */
  relayed: boolean;
  /** Which signal fired, when relayed is true. */
  reason?: "relayed-subagent-content" | "relayed-preamble-phrase";
  /** Claim symbols the relay-corpus signal covers, when relayed via (a). */
  relayedSymbols: string[];
}

/**
 * Detect whether `claims` (already-unbacked per
 * {@link detectCodeMechanismAssertion}) are RELAYED from a dispatched
 * subagent's own report rather than freshly asserted:
 *   (a) a subagent was dispatched/resumed THIS TURN and its tool_result
 *       carries ANY content ({@link buildRelayCorpus} non-empty) — the parent
 *       turn's claim was made in the same breath as receiving that report,
 *       so it is very likely a quote/paraphrase of it rather than a fresh,
 *       independently-verified assertion, or
 *   (b) the assistant prose carries a relay-preamble phrase
 *       ({@link RELAY_PREAMBLE_PATTERNS}) — catches the cross-turn case (the
 *       subagent completed in an EARLIER turn; this turn merely narrates
 *       its already-reported findings) that (a) cannot see.
 *
 * **Why (a) does not require the claim's literal symbol text to appear in
 * the relay corpus.** `detectCodeMechanismAssertion`'s existing
 * `buildVerificationCorpus` already collects EVERY same-turn tool_result
 * (dispatch or not) as backing evidence — so a claim whose symbol literally
 * appears in a same-turn subagent tool_result is ALREADY excluded from
 * `claims` before this function ever runs (it would show up as
 * `hadSameTurnRead: true` instead). Gating (a) on a literal-symbol match
 * would therefore be unreachable dead code. Instead, (a) fires whenever a
 * subagent report landed this turn AT ALL, accepting a wider
 * (but log-gradeable, per this task's success criterion) suppression
 * surface — this is the deliberate tradeoff named in the mt#3113 spec's
 * framing ("the subagent performed the read; the parent turn quotes its
 * findings" is treated as the DEFAULT read on any claim co-occurring with a
 * subagent report, not something requiring an exact-text match to prove).
 *
 * Turn-level (like {@link CodeMechanismDetectionResult.hadSameTurnRead}), not
 * per-claim — mirrors the existing suppression granularity in this file and
 * keeps the injection-layer gate simple.
 */
export function detectRelayContext(
  assistantText: string,
  claims: ReadonlyArray<{ symbol: string; predicate: string }>,
  relayCorpus: string
): RelayDetectionResult {
  if (claims.length === 0) return { relayed: false, relayedSymbols: [] };

  if (relayCorpus.trim().length > 0) {
    return {
      relayed: true,
      reason: "relayed-subagent-content",
      relayedSymbols: claims.map((c) => c.symbol),
    };
  }

  const prose = elideBlocksAndQuotes(assistantText);
  if (RELAY_PREAMBLE_PATTERNS.some((re) => re.test(prose))) {
    return { relayed: true, reason: "relayed-preamble-phrase", relayedSymbols: [] };
  }

  return { relayed: false, relayedSymbols: [] };
}

// ---------------------------------------------------------------------------
// Detection result type
// ---------------------------------------------------------------------------

export interface CodeMechanismDetectionResult {
  matched: boolean;
  /**
   * Distinct UNBACKED (symbol, predicate) claims, truncated for logging.
   * A claim whose symbol appears in the same-turn verification corpus is
   * excluded at claim level and never appears here (mt#2673 SC1).
   */
  claims: Array<{ symbol: string; predicate: string }>;
  /**
   * Symbol-FREE claims nominated at Rung 2 (mt#3726) — a separate channel from
   * `claims`, never merged into it.
   *
   * Kept separate for two reasons, neither cosmetic. First, every consumer of
   * `claims` keys on `symbol`: the backing rule is
   * `verificationCorpus.includes(symbol)` and the injection reminder names the
   * symbol back to the agent. A claim with no symbol has nothing to look up and
   * nothing to name, so putting one in `claims` would silently produce an
   * unsuppressable, unnameable entry. Second, calibration review has to measure
   * this cohort's false-positive rate on its own before anyone proposes wiring
   * it — the same treatment `commentSurfaceClaims` and `artifactSurfaceClaims`
   * get, and for the same reason.
   *
   * **There is no suppression for this channel yet, and that is a known
   * over-fire source rather than an oversight.** The turn-level backing signal
   * (`hadSameTurnRead`) is symbol-derived and cannot bind here; the candidate
   * replacement — the falsifying FILE being nameable from the claim (mem#1087) —
   * is a materially larger mechanism than an exemplar set, and mt#3594 owns the
   * suppression-granularity question this would consume. Read the first
   * calibration records with that in mind.
   *
   * Absent (rather than empty) on every Rung-1 result, so a record written
   * before this shipped is distinguishable from one where the cohort ran and
   * nominated nothing.
   */
  symbolFreeClaims?: Array<{ family: string; excerpt: string }>;
  /**
   * TURN-level aggregate (mt#2673): true when at least one (symbol,
   * predicate) pair elsewhere in the turn WAS backed by the verification
   * corpus. NOT a claim-level flag on the `claims` above — those are
   * definitionally unbacked. This ambiguity is exactly how the 2026-07-08
   * calibration review misread the 22:13Z record; see `backedClaimCount`
   * for the count of excluded-as-backed pairs.
   */
  hadSameTurnRead: boolean;
  /** Number of (symbol, predicate) pairs excluded from `claims` as backed (mt#2673). */
  backedClaimCount: number;
  /**
   * TURN-level aggregate (mt#3489): true when at least one claimed symbol
   * appears ONLY in the write-echo corpus — the agent WROTE it this turn and
   * never read it. Deliberately disjoint from `hadSameTurnRead`: a symbol that
   * was genuinely read sets that flag instead, even if it was also written.
   *
   * Before mt#3489 these cases were indistinguishable — a write echo set
   * `hadSameTurnRead` and the claim was suppressed as though inspected. Both
   * still suppress injection, so this changes no injection behavior; it makes
   * the authorship-as-verification class countable in the calibration record
   * for the first time, which is the precondition for deciding whether it
   * should surface.
   */
  hadWriteEchoBacking: boolean;
}

// ---------------------------------------------------------------------------
// Core detector (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Detect code-mechanism assertions whose named symbol was NOT inspected this
 * turn.
 *
 * @param assistantText - concatenated assistant text from the prior turn
 * @param verificationCorpus - same-turn read-class inputs + tool_result content
 * @param writeEchoCorpus - same-turn WRITE-class tool_result content (mt#3489).
 *   Symbols found only here were authored this turn, not inspected: they do NOT
 *   back a claim, but they are recorded via `hadWriteEchoBacking` so the class
 *   is countable. Defaults to empty, which reproduces the pre-mt#3489 call
 *   shape for existing callers and tests.
 */
export function detectCodeMechanismAssertion(
  assistantText: string,
  verificationCorpus: string,
  writeEchoCorpus = ""
): CodeMechanismDetectionResult {
  const empty: CodeMechanismDetectionResult = {
    matched: false,
    claims: [],
    hadSameTurnRead: false,
    backedClaimCount: 0,
    hadWriteEchoBacking: false,
  };
  if (!assistantText) return empty;

  const prose = elideBlocksAndQuotes(assistantText);
  const corpusLower = verificationCorpus.toLowerCase();
  const writeEchoLower = writeEchoCorpus.toLowerCase();
  const symbolBacked = (sym: string): boolean => corpusLower.includes(sym.toLowerCase());
  // Checked only for symbols that are NOT read-backed, so a symbol both read and
  // written counts as read — the stronger evidence wins.
  const symbolWriteEchoed = (sym: string): boolean =>
    writeEchoLower.length > 0 && writeEchoLower.includes(sym.toLowerCase());

  const claims: Array<{ symbol: string; predicate: string }> = [];
  const seen = new Set<string>();
  const backedSeen = new Set<string>();
  const writeEchoedSeen = new Set<string>();

  for (const pattern of PREDICATE_PATTERNS) {
    const globalFlags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, globalFlags);
    for (const m of prose.matchAll(globalPattern)) {
      const idx = m.index ?? 0;
      const symbols = symbolsNear(prose, idx, SYMBOL_PROXIMITY_CHARS);
      for (const sym of symbols) {
        const key = `${sym}::${m[0].toLowerCase()}`;
        if (symbolBacked(sym)) {
          backedSeen.add(key);
          continue;
        }
        // Authored-not-inspected: recorded, but NOT treated as backing, so the
        // claim still lands in `claims` rather than being silently dropped.
        if (symbolWriteEchoed(sym)) writeEchoedSeen.add(key);
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({ symbol: sym, predicate: m[0].slice(0, 40) });
      }
    }
  }

  return {
    matched: claims.length > 0,
    claims,
    hadSameTurnRead: backedSeen.size > 0,
    backedClaimCount: backedSeen.size,
    hadWriteEchoBacking: writeEchoedSeen.size > 0,
  };
}

// ---------------------------------------------------------------------------
// Rung 2: identity/equivalence claims (mt#4155)
// ---------------------------------------------------------------------------

/**
 * Why this is Rung 2 and not another `PREDICATE_PATTERNS` entry.
 *
 * Every entry in `PREDICATE_PATTERNS` is a BEHAVIOR verb (`clamps`, `returns`,
 * `throws`) or one of mt#3050's five SOURCING verbs. A claim that asserts a
 * symbol's IDENTITY or EQUIVALENCE — "`X` is the single reader", "`X` is
 * converted to it" — names neither, so `symbolsNear` extracts the symbol
 * perfectly and no predicate anchors it. mt#4106 measured four such claims:
 * `extracted: true`, `matched: false`, `claims: []` on all four, each with a
 * passing positive control.
 *
 * ADR-024 assigns this to Rung 2. Its Rung 1 is a quotation/citation-aware
 * elision PREFILTER aimed at the PRECISION axis — eliding quoted spans cannot
 * make an identity sentence match a behavior verb, so Rung 1 is structurally
 * incapable of covering this class. Adding identity verbs to the pattern list
 * is neither rung: it is the pre-ladder move ADR-024 Context names as the arms
 * race ("each miss has historically been answered by adding another regex
 * family (R1 -> R5)"). The recall-miss rate the Rung-2 evidence gate asks for
 * is exactly what mt#4106 supplies.
 */
export const IDENTITY_CLAIM_FAMILY = "identity-claim";

/**
 * How much of a nominated segment is kept as the claim's `predicate`. Matches
 * the lexical path's 40-char predicate budget so both rungs' calibration
 * records read the same width.
 */
const IDENTITY_PREDICATE_MAX_CHARS = 40;

/**
 * Curated exemplars for the identity/equivalence family.
 *
 * Drawn from the four mt#4106 fixtures plus the sibling surface forms they
 * generalize. Deliberately phrased WITHOUT a concrete symbol name: the
 * embedding scores the claim's GRAMMAR, and seeding a real identifier would
 * bias every score toward turns that happen to discuss that identifier.
 */
export const IDENTITY_CLAIM_EXEMPLARS: readonly string[] = [
  "this function is the single reader of that value",
  "the field is converted to it before the comparison",
  "both are expressed in the same unit against the same reading",
  "that module is the only consumer of this interface",
  "the two share the same underlying reader",
  "this constant is equivalent to the one the caller passes",
  "the value is converted to it, and the watermark that shares the same reader is converted with it",
  "its arithmetic is expressed in the same unit against the same reading, so changing the input changes the projection",
  "converting the one function also converts the watchers that consume it",
];

/** The exemplar set handed to `nominate`. */
export const IDENTITY_CLAIM_EXEMPLAR_SET: ExemplarSet = {
  family: IDENTITY_CLAIM_FAMILY,
  exemplars: [...IDENTITY_CLAIM_EXEMPLARS],
};

// ---------------------------------------------------------------------------
// Rung 2, second cohort: symbol-FREE claim classes (mt#3726)
// ---------------------------------------------------------------------------

/**
 * Why these are a different cohort from the identity family above, and not
 * five more entries in `IDENTITY_CLAIM_EXEMPLARS`.
 *
 * The identity family is symbol-BEARING and predicate-free: `symbolsNear`
 * extracts `X` from "`X` is the single reader" perfectly, and only the
 * PREDICATE match fails. So its claims still render as `(symbol, predicate)`
 * pairs, and its nominated segments still go through symbol extraction.
 *
 * These classes name no symbol at all. Measured 2026-08-19 by calling
 * `symbolsNear` directly on one sentence per class — every one returns `[]`,
 * against controls (`escapeLikeLiteral returns …`, `AgentSpawnsPipeline wires
 * only runForSession`) that extract their symbols. So symbol extraction cannot
 * be how these become claims, which is why they get their own claim channel
 * (`symbolFreeClaims`) rather than joining `claims`.
 *
 * ADR-024 places both cohorts at Rung 2 for the same reason: these are RECALL
 * misses that recur, and Rung 1 is a quotation-elision PREFILTER aimed at
 * PRECISION — eliding quoted spans cannot make a symbol-free sentence match a
 * behavior verb. Adding trigger-phrase regexes for them is neither rung; it is
 * the pre-ladder move ADR-024 Context names as the arms race, and it is what
 * mt#3726's own success criteria prescribed until this task's planning pass
 * reconciled them against the ADR.
 */

/** A caller exists and will run this later, unprompted (mem#873, positive sign). */
export const INVOCATION_PATH_POSITIVE_FAMILY = "invocation-path-positive";

/** No automatic caller exists; a human must run it (mem#873 R2, negative sign). */
export const INVOCATION_PATH_NEGATIVE_FAMILY = "invocation-path-negative";

/** A property of a subsystem, asserted from the one component that was open (mem#1087). */
export const SUBSYSTEM_PROPERTY_FAMILY = "subsystem-property";

/** How a third-party system behaves, relayed rather than read (mt#3726 §Sibling shape). */
export const EXTERNAL_SYSTEM_FAMILY = "external-system-mechanism";

/** A log line attributed to the code path under investigation (mem#1123, R9). */
export const LOG_ATTRIBUTION_FAMILY = "log-attribution";

/**
 * Exemplars are phrased WITHOUT concrete identifiers, for the same reason
 * `IDENTITY_CLAIM_EXEMPLARS` is: the embedding scores the claim's GRAMMAR, and
 * seeding a real name biases every score toward turns discussing that name.
 */
export const SYMBOL_FREE_EXEMPLAR_SETS: readonly ExemplarSet[] = [
  {
    family: INVOCATION_PATH_POSITIVE_FAMILY,
    exemplars: [
      "the missing rows self-heal on the next scheduled run",
      "the sweeper will pick that up automatically",
      "it gets retried on its own, so nothing further is needed",
      "that runs nightly, so the backlog clears itself",
      "the watcher handles it from here",
      "this backfills on the next ingest",
    ],
  },
  {
    family: INVOCATION_PATH_NEGATIVE_FAMILY,
    exemplars: [
      "you'll need to run that command manually",
      "that won't refresh on its own; it requires a reconnect",
      "nothing picks that up automatically, so someone has to trigger it",
      "there is no scheduled job for this, so it needs a deliberate run",
      "you will have to restart it yourself for the change to take effect",
    ],
  },
  {
    family: SUBSYSTEM_PROPERTY_FAMILY,
    exemplars: [
      "two of the three running processes are stale leftovers",
      "this is not a deploy-surface change",
      "silent data loss is the worst consequence here",
      "that would be a one-line migration",
      "these extra instances are leaked and safe to reap",
      "the concurrent copies do not interfere with each other",
    ],
  },
  {
    family: EXTERNAL_SYSTEM_FAMILY,
    exemplars: [
      "the repository auto-closes issues after sixty days",
      "their bot checks only the comment timestamps",
      "the vendor handles that case by retrying the request",
      "it is rate-limited to a hundred requests per minute",
      "that is the documented behavior of the service",
    ],
  },
  {
    family: LOG_ATTRIBUTION_FAMILY,
    exemplars: [
      "the log shows an unhandled rejection, so that failure is uncaught",
      "this error line means the startup path crashed rather than exiting cleanly",
      "the absence of that log line proves the branch never ran",
      "these entries come from the code path I am investigating",
      "the stack trace shows it died there instead of being handled",
    ],
  },
];

/** Every family in the symbol-free cohort, for classification and rendering. */
export const SYMBOL_FREE_FAMILIES: readonly string[] = SYMBOL_FREE_EXEMPLAR_SETS.map(
  (s) => s.family
);

/** True when `family` belongs to the symbol-free cohort rather than the identity family. */
export function isSymbolFreeFamily(family: string): boolean {
  return SYMBOL_FREE_FAMILIES.includes(family);
}

/** How much of a nominated segment is kept as a symbol-free claim's excerpt. */
const SYMBOL_FREE_EXCERPT_MAX_CHARS = 120;

/**
 * Per-class opt-out, separate from the cohort-wide Rung-2 flag.
 *
 * `MINSKY_CMA_RUNG2_NOMINATION` turns the whole embedding path on; this turns
 * the symbol-free cohort back off while leaving mt#4155's identity family
 * running, so a calibration review that finds THIS cohort noisy can quiet it
 * without also reverting a family whose records are clean.
 *
 * Registered in `HOOK_ONLY_ENV_VAR_CATEGORIES` as `operator-override`.
 */
export const SYMBOL_FREE_SKIP_ENV_VAR = "MINSKY_SKIP_SYMBOL_FREE_CLAIMS";

/** True when the operator has turned the symbol-free cohort off. */
export function isSymbolFreeCohortDisabled(): boolean {
  const raw = process.env[SYMBOL_FREE_SKIP_ENV_VAR];
  return raw === "1" || raw?.toLowerCase() === "true" || raw?.toLowerCase() === "yes";
}

/** The exemplar sets a nomination pass should score this turn. */
export function activeExemplarSets(): ExemplarSet[] {
  const sets: ExemplarSet[] = [IDENTITY_CLAIM_EXEMPLAR_SET];
  if (!isSymbolFreeCohortDisabled()) sets.push(...SYMBOL_FREE_EXEMPLAR_SETS.map((s) => ({ ...s })));
  return sets;
}

/**
 * Opt-in for the Rung-2 nomination path.
 *
 * Ships DISABLED, matching mt#3408's precedent for the sibling family and
 * mt#4155 SC5: the mechanism lands, and the threshold that decides it is
 * measured against the calibration log before it is allowed to change a
 * verdict. `DEFAULT_SIMILARITY_THRESHOLD` (0.455) was derived from the
 * retrospective-trigger exemplar band; nothing has measured where
 * identity-claim cosines actually live in THIS corpus.
 *
 * Registered in `HOOK_ONLY_ENV_VAR_CATEGORIES`.
 */
export const RUNG2_NOMINATION_ENV_VAR = "MINSKY_CMA_RUNG2_NOMINATION";

/** True when the operator has opted into the Rung-2 nomination path. */
export function isRung2NominationEnabled(): boolean {
  const raw = process.env[RUNG2_NOMINATION_ENV_VAR];
  return raw === "1" || raw?.toLowerCase() === "true" || raw?.toLowerCase() === "yes";
}

/**
 * One nominated segment, tagged with the family whose exemplars matched it.
 *
 * mt#4155 carried bare `string[]` because there was exactly one family, so the
 * tag was implicit. With the symbol-free cohort (mt#3726) the family decides
 * which claim channel a segment lands in — symbol extraction or the
 * `symbolFreeClaims` excerpt — so it can no longer be dropped at the seam.
 */
export interface NominatedSegment {
  family: string;
  segment: string;
}

/** What a nomination attempt produced for one turn's prose. */
export type IdentityNominationOutcome =
  | { kind: "nominated"; segments: NominatedSegment[] }
  | { kind: "none" }
  | { kind: "degraded"; reason: string };

/**
 * Injected seam. Takes the ELIDED prose and returns the segments whose
 * similarity to the identity-claim exemplars cleared the threshold.
 */
export type IdentityClaimNominator = (prose: string) => Promise<IdentityNominationOutcome>;

/** A detection result plus which rung produced it. */
export interface IdentityAugmentedResult extends CodeMechanismDetectionResult {
  /** `"1-lexical"` when nomination did not contribute claims, `"2-embedding"` when it did. */
  detectionRung: "1-lexical" | "2-embedding";
  /** Set when a nomination attempt degraded; the turn then reports Rung 1. */
  nominationDegradedReason?: string;
}

/**
 * Turn nominated segments into (symbol, predicate) claims.
 *
 * Pure, and applies the SAME backing rules the lexical path applies: a symbol
 * present in the verification corpus was inspected this turn and is excluded at
 * claim level rather than reported. Without this the Rung-2 path would report
 * claims the Rung-1 path suppresses, and the two rungs would disagree about the
 * same turn.
 */
export function identityClaimsFromSegments(
  segments: string[],
  verificationCorpus: string,
  writeEchoCorpus = ""
): {
  claims: Array<{ symbol: string; predicate: string }>;
  backedCount: number;
  hadWriteEcho: boolean;
} {
  const corpusLower = verificationCorpus.toLowerCase();
  const writeEchoLower = writeEchoCorpus.toLowerCase();
  const claims: Array<{ symbol: string; predicate: string }> = [];
  const seen = new Set<string>();
  const backedSeen = new Set<string>();
  let hadWriteEcho = false;

  for (const segment of segments) {
    // Anchor at the segment's midpoint with a window wide enough to span it:
    // unlike the lexical path there is no predicate match to anchor on, so the
    // whole segment is the neighborhood.
    const symbols = symbolsNear(segment, Math.floor(segment.length / 2), segment.length);
    // `safeTruncate`, not `slice`: unlike the lexical path — whose predicate is
    // a regex match over known-ASCII verbs — this slices arbitrary prose, which
    // routinely carries em dashes and can carry astral characters.
    const predicate = safeTruncate(segment.trim(), IDENTITY_PREDICATE_MAX_CHARS, "head");
    for (const sym of symbols) {
      const key = `${sym}::${predicate.toLowerCase()}`;
      if (corpusLower.includes(sym.toLowerCase())) {
        backedSeen.add(key);
        continue;
      }
      if (writeEchoLower.length > 0 && writeEchoLower.includes(sym.toLowerCase())) {
        hadWriteEcho = true;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ symbol: sym, predicate });
    }
  }

  return { claims, backedCount: backedSeen.size, hadWriteEcho };
}

/**
 * Run the Rung-2 pass over a turn and merge whatever it nominates into `base`.
 *
 * Merges rather than replaces: a turn can carry a behavior claim AND an
 * identity claim, and reporting only the lexical half would reintroduce the
 * miss on the very turns where both shapes appear.
 *
 * Never throws and never rejects — a degraded nomination returns `base`
 * unchanged with the reason recorded, which is ADR-024's fail-to-Rung-1
 * invariant rather than a silent skip.
 */
export async function augmentWithIdentityNomination(
  base: CodeMechanismDetectionResult,
  assistantText: string,
  verificationCorpus: string,
  writeEchoCorpus = "",
  nominator?: IdentityClaimNominator
): Promise<IdentityAugmentedResult> {
  const rung1: IdentityAugmentedResult = { ...base, detectionRung: "1-lexical" };
  if (nominator === undefined || !assistantText) return rung1;

  const prose = elideBlocksAndQuotes(assistantText);
  // Eligibility gate before spending a provider round-trip. mt#4155's version
  // skipped the whole turn when no symbol was extractable, on the rationale that
  // "a turn with no extractable symbol has nothing for an identity claim to be
  // ABOUT" — sound for that family and FATAL for the symbol-free cohort, whose
  // defining property is that `symbolsNear` returns nothing (mt#3726; measured
  // on one sentence per class against extracting controls).
  //
  // So the gate now only fires when the identity family is the ONLY thing that
  // could match. With the cohort active every turn is eligible, which is the
  // cost this buys and the reason the whole Rung-2 path stays opt-in behind
  // `MINSKY_CMA_RUNG2_NOMINATION`.
  const hasSymbols = symbolsNear(prose, Math.floor(prose.length / 2), prose.length).length > 0;
  if (!hasSymbols && isSymbolFreeCohortDisabled()) return rung1;

  let outcome: IdentityNominationOutcome;
  try {
    outcome = await nominator(prose);
  } catch (err) {
    return {
      ...rung1,
      nominationDegradedReason: `nominator-threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (outcome.kind === "degraded") {
    return { ...rung1, nominationDegradedReason: outcome.reason };
  }
  if (outcome.kind === "none") return rung1;

  // Route by family. Identity nominations become (symbol, predicate) claims via
  // symbol extraction; symbol-free nominations cannot, by construction, so they
  // land in their own channel as excerpts.
  const identitySegments = outcome.segments
    .filter((n) => !isSymbolFreeFamily(n.family))
    .map((n) => n.segment);
  const symbolFreeClaims = dedupeSymbolFreeClaims(
    outcome.segments.filter((n) => isSymbolFreeFamily(n.family))
  );

  const nominated = identityClaimsFromSegments(
    identitySegments,
    verificationCorpus,
    writeEchoCorpus
  );
  const existing = new Set(base.claims.map((c) => `${c.symbol}::${c.predicate.toLowerCase()}`));
  const fresh = nominated.claims.filter(
    (c) => !existing.has(`${c.symbol}::${c.predicate.toLowerCase()}`)
  );
  if (fresh.length === 0 && symbolFreeClaims.length === 0) return rung1;

  const claims = [...base.claims, ...fresh];
  return {
    // `matched` stays governed by the symbol-keyed claims. A symbol-free
    // nomination alone must NOT flip it: `matched` drives the injection branch
    // and `buildInjectionReminder`, both of which name symbols back to the
    // agent, and this cohort has no suppression yet. Flipping it here would
    // promote an unsuppressed cohort straight to operator-facing injection,
    // which is the opposite of the calibration-first posture ADR-024 requires.
    matched: base.matched || fresh.length > 0,
    claims,
    ...(symbolFreeClaims.length > 0 ? { symbolFreeClaims } : {}),
    hadSameTurnRead: base.hadSameTurnRead || nominated.backedCount > 0,
    backedClaimCount: base.backedClaimCount + nominated.backedCount,
    hadWriteEchoBacking: base.hadWriteEchoBacking || nominated.hadWriteEcho,
    detectionRung: fresh.length > 0 ? "2-embedding" : rung1.detectionRung,
  };
}

/**
 * Collapse nominated symbol-free segments into one claim per family.
 *
 * `nominate` already returns at most one best nomination per family per call,
 * but `augment` runs per SURFACE and a caller may hand in segments from more
 * than one pass, so the invariant is enforced here rather than assumed.
 */
export function dedupeSymbolFreeClaims(
  nominations: readonly NominatedSegment[]
): Array<{ family: string; excerpt: string }> {
  const byFamily = new Map<string, string>();
  for (const n of nominations) {
    if (byFamily.has(n.family)) continue;
    // `safeTruncate`, not `slice`: this is arbitrary prose and routinely carries
    // em dashes and can carry astral characters.
    byFamily.set(n.family, safeTruncate(n.segment.trim(), SYMBOL_FREE_EXCERPT_MAX_CHARS, "head"));
  }
  return [...byFamily].map(([family, excerpt]) => ({ family, excerpt }));
}

/**
 * Build the real-wired nominator.
 *
 * Deps resolve lazily and a failure LATCHES: once degraded, later calls return
 * degraded without re-attempting, so one wedged provider costs one round-trip
 * per process rather than one per turn.
 *
 * The try/catch is load-bearing, not defensive habit. A hook is its own entry
 * point: it inherits neither the reflect polyfill nor the process-global
 * configuration, and `resolveNominationDeps` reaches the embedding factory
 * which needs both. An escaping throw here would take out the whole detector
 * verdict — the silent skip ADR-024 forbids — instead of degrading visibly.
 */
export function createIdentityClaimNominator(): IdentityClaimNominator {
  let deps: NominationDeps | null | undefined;
  let latchedFailure: string | undefined;

  return async (prose: string): Promise<IdentityNominationOutcome> => {
    if (latchedFailure !== undefined) return { kind: "degraded", reason: latchedFailure };

    if (deps === undefined) {
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

    // mt#3726: every ACTIVE family in one call, not just the identity set.
    // `nominate` scores each exemplar set independently and returns at most one
    // best nomination per family, so widening the cohort costs additional
    // exemplar embeddings on the SAME round-trip rather than another round-trip.
    const result = await nominate(prose, activeExemplarSets(), deps);
    if (result.degraded) {
      latchedFailure = result.degradedReason ?? "unknown";
      return { kind: "degraded", reason: latchedFailure };
    }
    const segments = result.nominations.map((n) => ({ family: n.family, segment: n.segment }));
    if (segments.length === 0) return { kind: "none" };
    return { kind: "nominated", segments };
  };
}

// ---------------------------------------------------------------------------
// Calibration logging
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  try {
    // mt#2710: resolve the actual repo ROOT, not the raw shell cwd — `cwd` is
    // routinely a repo subdirectory, and a bare `resolve(cwd, ...)` would
    // scatter this calibration log into a stray subdirectory `.minsky/`.
    const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[code-mechanism-assertion-detector] calibration log write failed: ${msg}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Injection text (gated by INJECTION_ENABLED)
// ---------------------------------------------------------------------------

function buildInjectionReminder(
  claims: Array<{ symbol: string; predicate: string }>,
  relayed = false
): string {
  const lines = claims
    .slice(0, 6)
    .map((c) => `  - "${c.symbol}" ${c.predicate}`)
    .join("\n");
  const base = [
    "[code-mechanism-assertion-detector] Unread code-mechanism claim detected (mt#2486/mt#3050).",
    "",
    "The prior turn asserted what a named symbol DOES (behavior) or where its",
    "capability COMES FROM (sourcing/provenance) without reading that symbol this",
    "turn (it did not appear in any same-turn tool_result or read-class tool input):",
    lines,
    "",
    "Required: READ the symbol's source before asserting its behavior/capability.",
    "The cheapest falsifier is one Read/Grep of the file — see /check-premise.",
  ];

  // mt#3152: a relayed claim used to be SUPPRESSED here (mt#3113 leg 3). It is
  // now surfaced with relay-specific guidance instead — being second-hand is
  // the reason to check a claim, not to stay quiet about it.
  if (relayed) {
    base.push(
      "",
      "RELAY CONTEXT: this turn also carries a subagent report or a relay preamble",
      '("the subagent reports…"). A subagent\'s report is EVIDENCE the claim needs',
      "checking, never a finding to repeat — it inherits none of this page's",
      "guarantees. Read the primary source yourself, or state the provenance and",
      "verification status explicitly (claim-confidence.mdc: a relayed claim is at",
      "most `inferred`/`strong-evidence`, NEVER `verified-*`). See /check-premise",
      "cue (g)."
    );
  }

  return base.join("\n");
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652 Phase 2a)
// ---------------------------------------------------------------------------

/** Injectable deps for `run()` — tests substitute a fake dedup gate (mt#3113 leg 4). */
export interface RunDeps {
  /** Defaults to the real `shouldInjectClaimSet` (code-mechanism-assertion-dedup-store.ts). */
  shouldInjectClaimSetFn?: typeof shouldInjectClaimSet;
  /**
   * Rung-2 nominator (mt#4155). Injected rather than reached for, so the wiring
   * is observable without a provider. Defaults to the real one when
   * `MINSKY_CMA_RUNG2_NOMINATION` is set, and to `undefined` otherwise — which
   * is what keeps Rung 2 off by default.
   */
  identityNominator?: IdentityClaimNominator;
}

/**
 * Compute every injection-layer suppression reason for an already-matched
 * detection result (mt#3113 legs 1/3/4). Pure aside from the dedup gate call
 * (injectable via `shouldInjectClaimSetFn`) — factored out of `run()`/`main()`
 * so both entry points apply the identical three gates in the identical
 * order, and so the composition is unit-testable independent of transcript
 * parsing.
 *
 * Returns BOTH the reasons (empty when nothing suppresses) and the claim-set
 * signature (always computed, for the calibration record) so callers don't
 * need to recompute it.
 */
/**
 * The suppression labels for the two NON-CHAT claim surfaces.
 *
 * Extracted from `run()`/`main()` (mt#3876) so both label strings can be
 * pinned by a test. `computeSuppressionReasons` below owns the other three
 * (`same-turn-read`, `write-echo-backed`, `deduped`) and never saw these two,
 * because it is not passed the per-surface results — so until this extraction
 * nothing asserted either string anywhere, and a typo in one would have been
 * caught by no test and noticed only as a gap in a calibration sweep.
 *
 * The labels matter more than they look. `isSuppressedRecord`
 * (`calibration-sweep.ts`) is `suppressionReasons.length > 0`, and treats a
 * record with NO reason as injected — "unknown is treated as operator-facing so
 * a missing outcome can never hide a real fire." So an unlabeled surface-only
 * record would inflate the injected count AND drive the review cadence, which
 * keys off `injectedFiresSinceLastReview`.
 *
 * Only reached when the CHAT surface did not match: a chat match is a real
 * injection, and the non-chat surfaces are log-only riders on it. Since mt#3642
 * there are three surfaces, so each non-chat one labels itself rather than
 * relying on `!matched` to imply which fired.
 */
export function surfaceOnlyReasons(
  chatMatched: boolean,
  commentMatched: boolean,
  artifactMatched: boolean
): string[] {
  if (chatMatched) return [];
  const reasons: string[] = [];
  if (commentMatched) reasons.push("comment-surface-only");
  if (artifactMatched) reasons.push("artifact-surface-only");
  return reasons;
}

/**
 * The WARN line a symbol-free nomination surfaces (mt#3726, PR #3178 R1).
 *
 * AT4 requires that a fire in log-only posture "writes a calibration record and
 * surfaces a WARN, and blocks nothing." The first draft shipped the record and
 * the blocks-nothing half and no WARN — a cohort that fires into a file nobody
 * is watching, which is the ADR-024 coverage-receipt failure the calibration
 * ladder exists to prevent. The reviewer caught it as BLOCKING.
 *
 * STDERR, via `auditLines` on the dispatcher path and a direct write on the
 * standalone path — deliberately NOT `additionalContext`, which is the
 * operator-facing injection channel this cohort must stay off until its
 * false-positive rate is measured.
 *
 * Names the FAMILIES rather than the excerpts: the excerpt is the agent's own
 * prose and is already in the calibration record, whereas the family is what a
 * reader needs in order to know which claim shape just fired.
 */
export function buildSymbolFreeWarning(
  claims: ReadonlyArray<{ family: string; excerpt: string }>
): string {
  const families = claims.map((c) => c.family).join(", ");
  return (
    `[code-mechanism-assertion-detector] WARN: symbol-free claim nominated ` +
    `(${claims.length}; families: ${families}) — recorded only, not injected; ` +
    `this cohort has no suppression yet (mt#3726, mt#3594)\n`
  );
}

/**
 * Collect every symbol-free claim across the three surfaces (mt#3726).
 *
 * Returns `undefined` rather than `[]` when the cohort produced nothing, so a
 * calibration record written before this shipped stays distinguishable from one
 * where the cohort ran and nominated nothing — the same distinction mt#4155
 * added `identityDetectionRung` for.
 */
export function collectSymbolFreeClaims(
  ...results: ReadonlyArray<CodeMechanismDetectionResult | undefined>
): Array<{ family: string; excerpt: string }> | undefined {
  const all = results.flatMap((r) => r?.symbolFreeClaims ?? []);
  if (all.length === 0) return undefined;
  return dedupeSymbolFreeClaims(all.map((c) => ({ family: c.family, segment: c.excerpt })));
}

export function computeSuppressionReasons(
  result: CodeMechanismDetectionResult,
  relay: RelayDetectionResult,
  sessionId: string | undefined,
  shouldInjectClaimSetFn: typeof shouldInjectClaimSet = shouldInjectClaimSet
): { reasons: string[]; claimSetSignature: string; relayReasons: string[] } {
  const reasons: string[] = [];

  // Leg 1: same-turn-read suppression. hadSameTurnRead is a TURN-level
  // aggregate (mt#2673) — it does NOT mean every logged claim's own symbol
  // was backed (those are definitionally excluded already). This is a
  // deliberate injection-layer gate on top of that unchanged detection
  // semantics, per the mt#3113/ask#5425 disposition — see this file's header
  // comment and the `ask#5343 tune-1 correction` test below for why this is
  // NOT a reversal of the earlier (correctly rejected) detection-level
  // proposal.
  if (result.hadSameTurnRead) reasons.push("same-turn-read");

  // Leg 1b (mt#3489): the claimed symbol was WRITTEN this turn, not read. Before
  // this split, a write tool's tool_result echo landed in the verification
  // corpus and set `hadSameTurnRead` — so authorship suppressed the claim under
  // the same label as inspection, and the two were indistinguishable in the
  // record.
  //
  // This still SUPPRESSES, deliberately: injection behavior is unchanged by
  // mt#3489, because widening a live injector (INJECTION_ENABLED = true) before
  // measuring the class would be the wrong order. What changes is that the class
  // now has its own reason in the calibration record, so its size and FP rate
  // become measurable for the first time. Removing this leg — letting these
  // claims surface — is a separate, evidence-gated decision.
  if (result.hadWriteEchoBacking) reasons.push("write-echo-backed");

  // Leg 3 (mt#3113) NO LONGER SUPPRESSES — reversed by mt#3152.
  //
  // mt#3113 treated "this claim came from a subagent's report" as grounds to
  // stay silent, reasoning that the parent's claim "is very likely a
  // quote/paraphrase of it rather than a fresh, independently-verified
  // assertion." mem#706 (2026-07-24, ~6h after mt#3113 merged) reaches the
  // opposite conclusion from the same premise: a subagent's report, a
  // search-synthesis paragraph, and a monitor's verdict are the SAME
  // epistemic class — evidence that a claim needs checking, never a finding
  // to repeat. "Not independently verified" is the reason to SURFACE a
  // claim, not to suppress it.
  //
  // Why each leg was retired rather than narrowed:
  //   - Leg (a) (`relayCorpus` non-empty): mt#3113's own docblock establishes
  //     that a symbol literally present in a same-turn dispatch tool_result is
  //     ALREADY excluded upstream by `buildVerificationCorpus` (it lands as
  //     `hadSameTurnRead`). So leg (a)'s only REACHABLE cases are those where
  //     the relayed report does NOT contain the claimed symbol — i.e. the
  //     parent asserting beyond what the report substantiates, which is
  //     exactly mem#706's failure. There is no "topical relevance" narrowing
  //     available: the same argument that makes a literal-symbol gate dead
  //     code leaves no in-band relevance signal.
  //   - Leg (b) (relay-preamble phrase): suppressing on "the subagent
  //     reports…" lets a claim be excused by ANNOUNCING that it is
  //     second-hand — the cheapest possible thing for an agent to type, and a
  //     marker of the very class that needs checking.
  //
  // Relay DETECTION is retained and still recorded (returned as
  // `relayReasons`, logged in the calibration record) — what changed is the
  // POLICY applied to it: the injected reminder gains relay-specific guidance
  // (check-premise cue (g)) instead of being withheld. Detection and policy
  // are deliberately kept separate here so a future calibration pass can
  // re-grade the policy without re-deriving the signal.
  const relayReasons: string[] = [];
  if (relay.relayed && relay.reason) relayReasons.push(relay.reason);

  // Leg 4: per-claim-set dedup/cooldown (always evaluated, independent of
  // the other gates above — a claim set repeating across many turns is
  // exactly as noisy whether or not it also happens to be same-turn-read or
  // relayed on any given turn).
  const signature = claimSetSignature(result.claims);
  if (!shouldInjectClaimSetFn(sessionId, signature)) reasons.push("deduped");

  return { reasons, claimSetSignature: signature, relayReasons };
}

/**
 * Guard-dispatcher entry point. Mirrors `main()`'s orchestration but returns
 * a `GuardOutcome` instead of writing to stdout/`process.exit`. Reuses
 * `ctx.transcriptLines` (D6) instead of re-parsing the transcript itself and
 * skips `main()`'s own host-cap/deadline bookkeeping (the dispatcher's D6
 * shared context resolves the budget once per invocation, before any guard
 * runs — see the same note in `causal-premise-detector.ts`'s `run()`).
 */
export async function run(
  input: ClaudeHookInput,
  ctx: DispatchContext,
  deps: RunDeps = {}
): Promise<GuardOutcome | null> {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  if (isOverride) {
    return {
      auditLines: [
        `[code-mechanism-assertion-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines, ctx.recordedAnchor);
  } catch {
    return null;
  }
  if (turnLines.length === 0) return null;

  let result: CodeMechanismDetectionResult;
  let relay: RelayDetectionResult;
  let commentResult: CodeMechanismDetectionResult;
  let artifactResult: CodeMechanismDetectionResult;
  // mt#4155 — which rung produced this turn's claims, and why nomination
  // degraded if it did. Recorded on every calibration entry: a Rung-2 pass that
  // silently never runs is indistinguishable from one that runs and finds
  // nothing, and the calibration log is the only place that is diagnosable.
  let identityRung: "1-lexical" | "2-embedding" = "1-lexical";
  let identityDegradedReason: string | undefined;
  // mt#3649: the text the CHAT surface judged, hoisted so the calibration record
  // can capture it — without it a record carries claims but nothing to re-run a
  // changed detector against. ELIDED, never raw (PR #2926 R1): per
  // `judged-input-capture.ts`, "the elision is what makes the wider window safe
  // rather than a new exposure" — and it is also what the detector matches on,
  // so it is the true replay input.
  let judgedText = "";
  try {
    const assistantText = extractAssistantText(turnLines);
    judgedText = elideBlocksAndQuotes(assistantText);
    const corpus = buildVerificationCorpus(turnLines);
    result = detectCodeMechanismAssertion(assistantText, corpus, buildWriteEchoCorpus(turnLines));
    const relayCorpus = buildRelayCorpus(turnLines);
    relay = detectRelayContext(assistantText, result.claims, relayCorpus);
    // mt#3571 — the comment surface. A SEPARATE pass, never fed into
    // `computeSuppressionReasons` or the injection branch, so it is log-only by
    // construction rather than by a suppression flag that a one-line edit could
    // remove. Same verification corpus: a comment about a symbol the agent
    // actually read this turn is backed, exactly as in chat prose.
    commentResult = detectCodeMechanismAssertion(
      buildAddedCommentCorpus(turnLines),
      corpus,
      buildWriteEchoCorpus(turnLines)
    );
    // mt#3642 — the durable-artifact surface, on the same log-only terms as the
    // comment pass above: its own corpus, its own recorded fields, never fed to
    // `computeSuppressionReasons` or the injection branch. Same verification
    // corpus, so a PR-body claim about a symbol the agent genuinely read this
    // turn is backed exactly as it would be in chat.
    artifactResult = detectCodeMechanismAssertion(
      buildArtifactProseCorpus(turnLines),
      corpus,
      buildWriteEchoCorpus(turnLines)
    );

    // mt#4155 — Rung 2. The nominator is built ONLY when the operator has opted
    // in, so with the flag unset every surface returns exactly what it returned
    // before this shipped: `augmentWithIdentityNomination` short-circuits on an
    // undefined nominator. All three surfaces get the pass because the blind
    // spot is in the shared matcher, not in any one surface's corpus.
    const nominator =
      deps.identityNominator ??
      (isRung2NominationEnabled() ? createIdentityClaimNominator() : undefined);
    if (nominator !== undefined) {
      const writeEcho = buildWriteEchoCorpus(turnLines);
      const chat = await augmentWithIdentityNomination(
        result,
        assistantText,
        corpus,
        writeEcho,
        nominator
      );
      const comment = await augmentWithIdentityNomination(
        commentResult,
        buildAddedCommentCorpus(turnLines),
        corpus,
        writeEcho,
        nominator
      );
      const artifact = await augmentWithIdentityNomination(
        artifactResult,
        buildArtifactProseCorpus(turnLines),
        corpus,
        writeEcho,
        nominator
      );
      result = chat;
      commentResult = comment;
      artifactResult = artifact;
      identityRung =
        chat.detectionRung === "2-embedding" ||
        comment.detectionRung === "2-embedding" ||
        artifact.detectionRung === "2-embedding"
          ? "2-embedding"
          : "1-lexical";
      identityDegradedReason =
        chat.nominationDegradedReason ??
        comment.nominationDegradedReason ??
        artifact.nominationDegradedReason;
    }
  } catch (err) {
    process.stderr.write(
      `[code-mechanism-assertion-detector] detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  // Both surfaces gate the record. Returning on `!result.matched` alone would
  // have made the comment surface silently dead: on a turn whose chat prose
  // asserts nothing, the guard would exit before writing any calibration record.
  //
  // mt#3726 adds a fourth admitting condition for exactly the same reason the
  // comment surface added the second: a symbol-free nomination deliberately does
  // NOT flip `matched` (it has no symbol to inject), so gating the record on
  // `matched` alone would make this cohort structurally unable to write a single
  // calibration record — shipped, running, and permanently invisible, which is
  // the ADR-024 coverage-receipt failure rather than a quiet start.
  const symbolFreeClaims = collectSymbolFreeClaims(result, commentResult, artifactResult);
  if (
    !result.matched &&
    !commentResult.matched &&
    !artifactResult.matched &&
    symbolFreeClaims === undefined
  ) {
    return null;
  }

  const shouldInjectClaimSetFn = deps.shouldInjectClaimSetFn ?? shouldInjectClaimSet;
  const {
    reasons: suppressionReasons,
    claimSetSignature: signature,
    relayReasons,
  } = computeSuppressionReasons(result, relay, input.session_id, shouldInjectClaimSetFn);

  // mt#3571 / PR #2549 R1. An earlier draft recorded the comment surface with NO
  // suppression reason, on the reasoning that "suppressed" misdescribes a claim
  // that never entered the injection path. That reasoning was about what the
  // LABEL means and ignored what the CONSUMER does with it: `isSuppressedRecord`
  // (`calibration-sweep.ts`) is `suppressionReasons.length > 0`, and its docblock
  // states that a record without one "counts as injected here: unknown is treated
  // as operator-facing so a missing outcome can never hide a real fire."
  //
  // So an unlabeled comment-only record would be counted as an operator-facing
  // fire it never was — inflating the injected count AND driving the review
  // cadence, which keys off `injectedFiresSinceLastReview`. The measurement this
  // surface exists to enable would have been corrupted by its own records.
  //
  // mt#3642 — with a THIRD surface, `!result.matched` no longer implies the
  // comment surface is the one that matched, so each non-chat surface labels
  // itself. Leaving the unconditional push would have mislabeled an
  // artifact-only record as comment-only; leaving no label at all is the worse
  // failure the paragraph above describes.
  suppressionReasons.push(
    ...surfaceOnlyReasons(result.matched, commentResult.matched, artifactResult.matched)
  );

  // mt#3726 — same argument as the two surface-only labels above, whose comment
  // spells it out: `isSuppressedRecord` (`calibration-sweep.ts`) is
  // `suppressionReasons.length > 0`, so an UNLABELED record counts as an
  // operator-facing fire. A record whose only content is a symbol-free
  // nomination injected nothing, and leaving it unlabeled would inflate the
  // injected count and drive the review cadence off fires that never reached
  // the operator — corrupting the measurement this cohort ships to enable.
  if (
    symbolFreeClaims !== undefined &&
    !result.matched &&
    !commentResult.matched &&
    !artifactResult.matched
  ) {
    suppressionReasons.push("symbol-free-cohort-only");
  }

  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      // mt#4155 — which rung produced this record, and why nomination degraded
      // if it did. Without these a Rung-2 pass that never ran looks exactly
      // like one that ran and nominated nothing, which is the distinction the
      // promotion decision turns on.
      identityDetectionRung: identityRung,
      identityNominationDegradedReason: identityDegradedReason,
      claims: result.claims,
      hadSameTurnRead: result.hadSameTurnRead,
      backedClaimCount: result.backedClaimCount,
      claimSetSignature: signature,
      suppressionReasons,
      relayReasons,
      // mt#3571 — recorded, never injected. Present as its own fields rather
      // than merged into `claims` so calibration review can measure this
      // surface's FP rate separately from the chat surface's before anyone
      // proposes wiring it.
      commentSurfaceClaims: commentResult.claims,
      commentSurfaceClaimCount: commentResult.claims.length,
      // mt#3642 — same treatment for the durable-artifact surface: recorded,
      // never injected, its own fields so its FP rate is measurable on its own
      // before anyone proposes wiring it.
      artifactSurfaceClaims: artifactResult.claims,
      artifactSurfaceClaimCount: artifactResult.claims.length,
      // mt#3726 — the symbol-free cohort, recorded and never injected, on the
      // same terms as the two surfaces above. `undefined` when the cohort
      // nominated nothing, which keeps a pre-mt#3726 record distinguishable
      // from a turn where it ran and found nothing.
      symbolFreeClaims,
      symbolFreeClaimCount: symbolFreeClaims?.length ?? 0,
      symbolFreeFamilies: symbolFreeClaims?.map((c) => c.family),
      // mt#3649: the judged input itself, so a CHANGED detector can be replayed
      // over this record rather than its effect inferred. Bounded and hashed by
      // the shared mt#3607 capture. `captureSchema` marks the record
      // re-classifiable; its ABSENCE marks a pre-capture record as
      // unrecoverable rather than as clean.
      [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,
      judgedInput: captureArtifact(judgedText),
    },
  };

  // `result.matched` is required here, not implied. Since the early return above
  // now also admits comment-only turns, without it a turn whose ONLY claim is in
  // a comment would inject a reminder built from an EMPTY chat-claim array.
  if (INJECTION_ENABLED && result.matched && suppressionReasons.length === 0) {
    outcome.additionalContext = buildInjectionReminder(result.claims, relayReasons.length > 0);
  }

  // mt#3726 (PR #3178 R1) — AT4's WARN half. Emitted whenever the cohort
  // nominated anything, INDEPENDENT of `matched` and of the injection branch
  // above: a symbol-free nomination on a turn that also carries a symbol-bearing
  // claim is still a fire of this cohort, and gating the WARN on
  // symbol-free-ONLY would hide exactly the mixed turns where both shapes appear.
  if (symbolFreeClaims !== undefined) {
    outcome.auditLines = [...(outcome.auditLines ?? []), buildSymbolFreeWarning(symbolFreeClaims)];
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const capInfo = readHostCap("code-mechanism-assertion-detector.ts", undefined, {
    events: ["UserPromptSubmit"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[code-mechanism-assertion-detector] ${capInfo.warning}\n`);
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
      `[code-mechanism-assertion-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  if (Date.now() >= overallDeadline) {
    process.stderr.write(`[code-mechanism-assertion-detector] budget exhausted — skipping\n`);
    process.exit(0);
  }

  const lines = resolveParentTranscriptLinesForPath(transcriptPath, input.agent_id);
  if (lines.length === 0) process.exit(0);

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    process.exit(0);
  }
  if (turnLines.length === 0) process.exit(0);

  let result: CodeMechanismDetectionResult;
  let relay: RelayDetectionResult;
  let commentResult: CodeMechanismDetectionResult;
  let artifactResult: CodeMechanismDetectionResult;
  // mt#4155 — same fields as `run()`. This path writes into the SAME calibration
  // log, so omitting them here would leave records whose rung is unknowable and
  // silently bias any measurement taken over the window (PR #3128 R2).
  let identityRung: "1-lexical" | "2-embedding" = "1-lexical";
  let identityDegradedReason: string | undefined;
  // mt#3649: the text the CHAT surface judged, hoisted so the calibration record
  // can capture it — without it a record carries claims but nothing to re-run a
  // changed detector against. ELIDED, never raw (PR #2926 R1): per
  // `judged-input-capture.ts`, "the elision is what makes the wider window safe
  // rather than a new exposure" — and it is also what the detector matches on,
  // so it is the true replay input.
  let judgedText = "";
  try {
    const assistantText = extractAssistantText(turnLines);
    judgedText = elideBlocksAndQuotes(assistantText);
    const corpus = buildVerificationCorpus(turnLines);
    result = detectCodeMechanismAssertion(assistantText, corpus, buildWriteEchoCorpus(turnLines));
    const relayCorpus = buildRelayCorpus(turnLines);
    relay = detectRelayContext(assistantText, result.claims, relayCorpus);
    // mt#3571 — comment surface, identical composition to run()'s path.
    commentResult = detectCodeMechanismAssertion(
      buildAddedCommentCorpus(turnLines),
      corpus,
      buildWriteEchoCorpus(turnLines)
    );
    // mt#3642 — the durable-artifact surface, on the same log-only terms as the
    // comment pass above: its own corpus, its own recorded fields, never fed to
    // `computeSuppressionReasons` or the injection branch. Same verification
    // corpus, so a PR-body claim about a symbol the agent genuinely read this
    // turn is backed exactly as it would be in chat.
    artifactResult = detectCodeMechanismAssertion(
      buildArtifactProseCorpus(turnLines),
      corpus,
      buildWriteEchoCorpus(turnLines)
    );

    // mt#4155 — Rung 2, identical composition to run()'s path. Both entry points
    // must apply the same rungs: they write the same calibration log, and a
    // window mixing augmented and un-augmented records would report a recall
    // difference that is an artifact of which entry point ran (PR #3128 R2).
    const nominator = isRung2NominationEnabled() ? createIdentityClaimNominator() : undefined;
    if (nominator !== undefined) {
      const writeEcho = buildWriteEchoCorpus(turnLines);
      const chat = await augmentWithIdentityNomination(
        result,
        assistantText,
        corpus,
        writeEcho,
        nominator
      );
      const comment = await augmentWithIdentityNomination(
        commentResult,
        buildAddedCommentCorpus(turnLines),
        corpus,
        writeEcho,
        nominator
      );
      const artifact = await augmentWithIdentityNomination(
        artifactResult,
        buildArtifactProseCorpus(turnLines),
        corpus,
        writeEcho,
        nominator
      );
      result = chat;
      commentResult = comment;
      artifactResult = artifact;
      identityRung =
        chat.detectionRung === "2-embedding" ||
        comment.detectionRung === "2-embedding" ||
        artifact.detectionRung === "2-embedding"
          ? "2-embedding"
          : "1-lexical";
      identityDegradedReason =
        chat.nominationDegradedReason ??
        comment.nominationDegradedReason ??
        artifact.nominationDegradedReason;
    }
  } catch (err) {
    console.error(
      `[code-mechanism-assertion-detector] detection error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  // mt#3726 — the fourth admitting condition, identical to run()'s. mt#4155's
  // R2 fix (PR #3128) was that this standalone entry point had been left on
  // Rung 1 while the dispatcher path moved; the same divergence would strand
  // this cohort here, so both paths gain the condition together.
  const symbolFreeClaims = collectSymbolFreeClaims(result, commentResult, artifactResult);
  if (
    !result.matched &&
    !commentResult.matched &&
    !artifactResult.matched &&
    symbolFreeClaims === undefined
  ) {
    process.exit(0);
  }

  // mt#3113 legs 1/4 (leg 3 is now surfaced, not suppressed — see mt#3152) —
  // identical composition to run()'s dispatcher path.
  const {
    reasons: suppressionReasons,
    claimSetSignature: signature,
    relayReasons,
  } = computeSuppressionReasons(result, relay, input.session_id);

  // See run()'s comment: without this the record classifies as operator-facing.
  //
  // mt#3642 — with a THIRD surface, `!result.matched` no longer implies the
  // comment surface is the one that matched, so each non-chat surface labels
  // itself. Leaving the unconditional push would have mislabeled an
  // artifact-only record as comment-only; leaving no label at all is the worse
  // failure the paragraph above describes.
  suppressionReasons.push(
    ...surfaceOnlyReasons(result.matched, commentResult.matched, artifactResult.matched)
  );

  // mt#3726 — same argument as the two surface-only labels above, whose comment
  // spells it out: `isSuppressedRecord` (`calibration-sweep.ts`) is
  // `suppressionReasons.length > 0`, so an UNLABELED record counts as an
  // operator-facing fire. A record whose only content is a symbol-free
  // nomination injected nothing, and leaving it unlabeled would inflate the
  // injected count and drive the review cadence off fires that never reached
  // the operator — corrupting the measurement this cohort ships to enable.
  if (
    symbolFreeClaims !== undefined &&
    !result.matched &&
    !commentResult.matched &&
    !artifactResult.matched
  ) {
    suppressionReasons.push("symbol-free-cohort-only");
  }

  if (Date.now() < overallDeadline) {
    appendCalibrationRecord(input.cwd, {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      // mt#4155 — same two fields run() writes. A record without them cannot be
      // attributed to a rung, and this path shares the log (PR #3128 R2).
      identityDetectionRung: identityRung,
      identityNominationDegradedReason: identityDegradedReason,
      claims: result.claims,
      hadSameTurnRead: result.hadSameTurnRead,
      backedClaimCount: result.backedClaimCount,
      claimSetSignature: signature,
      suppressionReasons,
      relayReasons,
      commentSurfaceClaims: commentResult.claims,
      commentSurfaceClaimCount: commentResult.claims.length,
      // mt#3642 — same treatment for the durable-artifact surface: recorded,
      // never injected, its own fields so its FP rate is measurable on its own
      // before anyone proposes wiring it.
      artifactSurfaceClaims: artifactResult.claims,
      artifactSurfaceClaimCount: artifactResult.claims.length,
      // mt#3726 — the symbol-free cohort, recorded and never injected, on the
      // same terms as the two surfaces above. `undefined` when the cohort
      // nominated nothing, which keeps a pre-mt#3726 record distinguishable
      // from a turn where it ran and found nothing.
      symbolFreeClaims,
      symbolFreeClaimCount: symbolFreeClaims?.length ?? 0,
      symbolFreeFamilies: symbolFreeClaims?.map((c) => c.family),
      // mt#3649: the judged input itself, so a CHANGED detector can be replayed
      // over this record rather than its effect inferred. Bounded and hashed by
      // the shared mt#3607 capture. `captureSchema` marks the record
      // re-classifiable; its ABSENCE marks a pre-capture record as
      // unrecoverable rather than as clean.
      [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,
      judgedInput: captureArtifact(judgedText),
    });
  }

  // mt#3726 (PR #3178 R1) — AT4's WARN, before the injection early-exit below.
  // Order is load-bearing: that exit fires on every symbol-free-only turn (it
  // keeps `matched` false by design), so a WARN written after it would never run
  // on exactly the turns this cohort exists for. run() reaches the same
  // behaviour through `auditLines`, which the dispatcher writes to STDERR.
  if (symbolFreeClaims !== undefined) {
    process.stderr.write(buildSymbolFreeWarning(symbolFreeClaims));
  }

  // `!result.matched` is required, not implied — see run()'s matching comment.
  if (!INJECTION_ENABLED || !result.matched || suppressionReasons.length > 0) process.exit(0);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildInjectionReminder(result.claims, relayReasons.length > 0),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
