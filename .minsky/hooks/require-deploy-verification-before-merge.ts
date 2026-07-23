#!/usr/bin/env bun
// PreToolUse hook (mt#2353): block session_pr_merge when a PR touches a DEPLOY
// SURFACE (infra-as-code / per-service deploy+build config / deploy workflows)
// but the PR body has no `Deploy verification:` section committing to post-merge
// deploy-health verification.
//
// Why: the mt#1459 "Execution evidence:" gate fires ONLY when a PR adds test
// files. A PR that changes DEPLOYED BEHAVIOR but adds no tests (config-as-code,
// Dockerfile, railway.json, deploy workflow) skips it entirely. mt#2345
// (2026-06-08) merged infra/index.ts + services/reviewer/railway.json, applied
// them to prod, and was reported DONE on `pulumi up` exit-0 while the reviewer
// service crash-looped for ~30 min. This gate closes that hole at the merge
// boundary.
//
// Architectural note: DONE is set ATOMICALLY at merge (applyPostMergeStateSync),
// and the deploy happens AFTER merge — so this gate cannot require deploy-SUCCESS
// EVIDENCE pre-merge (the deploy doesn't exist yet). It requires a `Deploy
// verification:` PLAN/commitment in the PR body; the sibling PostToolUse hook
// (deploy-verification-after-merge.ts) then injects the MANDATORY post-merge
// reminder to actually run it. Together they are the deploy-surface analog of the
// mt#1459 gate + drive-pr-to-convergence pair.
//
// Escape hatches:
//   1. PR title contains `[no-deploy-impact]` — the surface match is a false
//      positive (e.g. a comment-only edit to a deploy-config file). Allows with a
//      warning.
//   2. PR body contains a `Deploy verification:` section — the commitment.
//   3. MINSKY_SKIP_DEPLOY_VERIFY=1 — operator override, audit-logged.
//
// @see mt#2353 — this hook
// @see mt#1459 / require-execution-evidence-before-merge.ts — sibling gate (test-file surface)
// @see deploy-verification-after-merge.ts — sibling PostToolUse post-merge reminder
//
// Gap A extension (mt#2545): a SECOND, independent condition added to this same
// hook — a BUILD-SURFACE PR (cockpit-tray/src-tauri/**, the LOCAL-APP deploy
// surface from packages/domain/src/deployment/deploy-surface.ts) whose body
// asserts altitude-4 usability ("you can use it now" / "ready to use" / "it's
// live") WITHOUT an explicit rebuild + reinstall acknowledgment is HARD-BLOCKED.
// Per claim-confidence.mdc's Axis A (delivery state): a Build/install-class
// deliverable has `deployed < usable` with NO agent-observable transition into
// `usable` — the tray's own Rust binary is not auto-rebuilt, so a merged change
// stays invisible until the principal rebuilds + reinstalls (mt#2528 incident).
// This condition is independent of the Railway deploy-verification check above
// (different surface, different override var) but shares this hook's PR-body
// fetch, parsing conventions, and override plumbing rather than standing up a
// parallel hook. See `checkUsabilityClaim` below.
// @see mt#2923 — sibling chat-seam injection (same surface detection, different
//   enforcement point: chat-prose vs this PR-body pre-merge gate)

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import { deriveRepoFromGit, fetchPrContext, formatContextFailureWarnings } from "./pr-context";
import type { PrFile } from "./pr-context";
import { findDeploySurfaceFiles, findLocalAppDeploySurfaceFiles } from "./deploy-surface-detector";
import { makeRecordAndExit, type RecordAndExit } from "./merge-gate-fire-log";
import { classifyOverride } from "./fire-log";

/** This guard's fire-log identifier (mt#3084, evaluation-loop Phase 3). */
const GUARD_NAME = "require-deploy-verification-before-merge";

// ---------------------------------------------------------------------------
// Override env var (single source of truth — also registered in HOOK_ONLY_ENV_VARS)
// ---------------------------------------------------------------------------

/** Operator override: skip the deploy-verification gate. Audit-logged when set. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_DEPLOY_VERIFY";

/** True when the override env var is set to a truthy value (1/true/yes). */
export function isOverrideSet(): boolean {
  const v = process.env[OVERRIDE_ENV_VAR];
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Operator override for the Gap A usability-claim gate ONLY (mt#2545) — separate
 * from {@link OVERRIDE_ENV_VAR} so an operator can skip just the build-surface
 * usability-claim block without also disabling the Railway deploy-verification
 * check above (and vice versa). Audit-logged when set.
 */
export const USABILITY_CLAIM_OVERRIDE_ENV_VAR = "MINSKY_SKIP_USABILITY_CLAIM_CHECK";

/** True when {@link USABILITY_CLAIM_OVERRIDE_ENV_VAR} is set to a truthy value (1/true/yes). */
export function isUsabilityClaimOverrideSet(): boolean {
  const v = process.env[USABILITY_CLAIM_OVERRIDE_ENV_VAR];
  return v === "1" || v === "true" || v === "yes";
}

// ---------------------------------------------------------------------------
// PR body / title parsing
// ---------------------------------------------------------------------------

/**
 * Markdown marker for the deploy-verification commitment section (mt#2648 —
 * same accepted-forms class as the sibling `hasExecutionEvidence` marker in
 * `require-execution-evidence-before-merge.ts`). Accepts, case-insensitive:
 *   A. A Markdown heading (any level 1-6) + "deploy verification" with an
 *      OPTIONAL trailing colon — e.g. "## Deploy verification",
 *      "### Deploy verification:".
 *   B. A plain label line — "deploy verification:" with a REQUIRED colon (no
 *      heading marker) — keeping the colon required here preserves the
 *      original true-negative behavior for bare prose mentions.
 * `m`+`i` flags. Group 1 (heading hashes, form A only) is unused downstream;
 * group 2 captures trailing inline content for the inline-content check.
 */
// Up to 3 leading spaces before a heading marker, per CommonMark (spaces
// only — not \s, which would let the match skip across blank lines).
const DEPLOY_VERIFICATION_MARKER =
  /^(?: {0,3}(#{1,6})\s+deploy verification\s*:?|deploy verification\s*:)\s*(.*)$/im;

/** Title bypass tag for false-positive deploy-surface matches. */
const NO_DEPLOY_IMPACT_TAG = /\[no-deploy-impact\]/i;

/**
 * Deferral-language patterns (mt#2353 Recurrence 3): a `Deploy verification:`
 * section whose content is a DEFERRAL — "deferred to §10", "will verify later",
 * "not yet deployed", "to be verified" — is NOT evidence. The post-merge
 * verification must be committed to / run, not punted; "deferred to §10 because
 * not-yet-deployed" is exactly the loophole the spec disallows. A section whose
 * content matches this pattern does NOT satisfy the gate. Note: this runs ONLY
 * against the matched section's own text, never the rest of the PR body, so a
 * concrete commitment ("Will run `deployment_wait-for-latest` after merge and
 * confirm SUCCESS") passes — it names the action, not a punt.
 */
const DEFERRAL_PATTERN =
  /\b(?:defer(?:red|ring|s)?|will\s+verify(?:\s+it)?\s+later|verify(?:\s+it)?\s+later|not[\s-]?yet[\s-]?deployed|to\s+be\s+verified|pending\s+deploy(?:ment)?|verify\s+post-?merge)\b/i;

/**
 * True when the PR body contains a `Deploy verification:` block with non-empty
 * content following the marker. Mirrors the mt#1459 `hasExecutionEvidence`
 * discipline: HTML comments stripped first; a `No Deploy verification:` negation
 * does NOT qualify; content must follow the heading (inline or on subsequent
 * lines before the next heading).
 */
export function hasDeployVerification(prBody: string): boolean {
  const stripped = prBody.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(DEPLOY_VERIFICATION_MARKER);
    if (!match) continue;

    // Negation guard: "No Deploy verification:" / "## No Deploy verification:".
    const beforeMarker = line.slice(0, line.toLowerCase().indexOf("deploy")).toLowerCase();
    if (/\bno\b/.test(beforeMarker)) continue;

    // Collect this section's content: inline (heading line) + following lines
    // until the next heading or EOF.
    const parts: string[] = [];
    const inlineContent = (match[2] ?? "").trim();
    if (inlineContent.length > 0) parts.push(inlineContent);
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine === undefined) break;
      if (/^ {0,3}#{1,6}\s/.test(nextLine)) break; // next heading (≤3-space indent, CommonMark) — stop
      if (nextLine.trim().length > 0) parts.push(nextLine.trim());
    }
    const content = parts.join(" ").trim();
    if (content.length === 0) continue; // empty section — keep looking

    // Deferral-text-is-not-evidence (mt#2353 Recurrence 3): a deferral-only
    // section does NOT satisfy the gate. Keep scanning in case a later, genuine
    // section exists.
    if (DEFERRAL_PATTERN.test(content)) continue;

    return true;
  }
  return false;
}

/** True when the PR title carries the `[no-deploy-impact]` bypass tag. */
export function hasNoDeployImpactTag(prTitle: string): boolean {
  return NO_DEPLOY_IMPACT_TAG.test(prTitle);
}

// ---------------------------------------------------------------------------
// Core check (pure / injectable)
// ---------------------------------------------------------------------------

export interface DeployVerificationCheckResult {
  blocked: boolean;
  reason?: string;
  deploySurfaceFiles: string[];
  bypassDetected: boolean;
  warnings: string[];
}

/**
 * Run the deploy-verification check given PR files + metadata. Pure core of the
 * hook — injectable for unit tests.
 */
export function checkDeployVerification(
  prFiles: PrFile[],
  prTitle: string,
  prBody: string
): DeployVerificationCheckResult {
  const warnings: string[] = [];
  const deploySurfaceFiles = findDeploySurfaceFiles(prFiles);

  // No deploy surface touched → hook is silent.
  if (deploySurfaceFiles.length === 0) {
    return { blocked: false, deploySurfaceFiles: [], bypassDetected: false, warnings };
  }

  // Title bypass for false-positive surface matches.
  if (hasNoDeployImpactTag(prTitle)) {
    warnings.push(
      `[no-deploy-impact] bypass: merge proceeding without a \`Deploy verification:\` ` +
        `section for ${deploySurfaceFiles.length} deploy-surface file(s). Confirm the ` +
        `change truly has no deploy impact.`
    );
    return { blocked: false, deploySurfaceFiles, bypassDetected: true, warnings };
  }

  // Commitment present → allow.
  if (hasDeployVerification(prBody)) {
    return { blocked: false, deploySurfaceFiles, bypassDetected: false, warnings };
  }

  // No commitment, no bypass → block.
  const fileList = deploySurfaceFiles.map((f) => `  - ${f}`).join("\n");
  const reason =
    `Merge blocked: PR touches ${deploySurfaceFiles.length} deploy-surface file(s) but the ` +
    `PR body has no deploy-verification section.\n\n` +
    `Accepted marker forms (case-insensitive): \`Deploy verification:\` (plain label, colon ` +
    `required) OR a Markdown heading of any level with an optional trailing colon ` +
    `(e.g. \`## Deploy verification\`, \`### Deploy verification:\`).\n\n` +
    `Deploy-surface files:\n${fileList}\n\n` +
    `Deploy/infra changes can break the post-merge deploy (Dockerfile breakage, ` +
    `config-as-code resolution error, crash on start) in ways no pre-merge check catches ` +
    `(mt#2345). DONE is set AT merge, so you MUST verify the post-merge deploy yourself.\n\n` +
    `To unblock, choose one of:\n` +
    `  1. Add a \`Deploy verification\` section (any accepted form above) to the PR body committing to run ` +
    `\`mcp__minsky__deployment_wait-for-latest\` → SUCCESS (and confirm the runtime started) ` +
    `AFTER merge. A tool/auth flake is a BLOCKER (reconnect /mcp and retry), NOT a license to ` +
    `defer; "applied" / "pulumi up exit-0" is the ACTION, not the OUTCOME. ` +
    `(use \`mcp__minsky__session_pr_edit\` to update the body.)\n` +
    `  2. If this change truly has no deploy impact (e.g. a comment-only edit), prefix the PR ` +
    `title with \`[no-deploy-impact]\`.\n` +
    `  3. Operator override: set \`${OVERRIDE_ENV_VAR}=1\` (audit-logged).`;

  return { blocked: true, reason, deploySurfaceFiles, bypassDetected: false, warnings };
}

// ---------------------------------------------------------------------------
// Gap A: build-surface usability-claim check (mt#2545)
// ---------------------------------------------------------------------------

/**
 * Altitude-4 usability-claim patterns: PR-body language asserting the merged
 * change is immediately usable by the principal — claim-confidence.mdc's
 * `usable` delivery state. Deliberately narrow (a handful of high-precision
 * phrasings) rather than a broad "sounds positive" scan — bare verbs like
 * "test it" / "use it" are deliberately EXCLUDED on their own (too generic;
 * "you should test it before merging" is a caveat, not a usability claim).
 * Phrasing anchored to the canonical mt#2545 examples ("you can use it now" /
 * "ready to use" / "it's live" / "go ahead and test") and aligned with the
 * sibling chat-seam detector's `USABILITY_CLAIM_PATTERNS`
 * (`.minsky/hooks/build-claim-injection-detector.ts`, mt#2923) for vocabulary
 * consistency across the two enforcement surfaces. Case-insensitive.
 */
export const USABILITY_CLAIM_PATTERNS: readonly RegExp[] = [
  // "you can use it now" / "you can now use it" / "you can use it"
  /\byou\s+can\s+(?:now\s+)?use\s+it(?:\s+now)?\b/i,
  // "ready to use" / "ready for use"
  /\bready\s+(?:to\s+use|for\s+use)\b/i,
  // "it's live" / "it is live"
  /\bit(?:'s|\s+is)\s+live\b/i,
  // "go ahead and test" (mt#2923 canonical phrasing) / "go ahead and use it"
  /\bgo\s+ahead\s+and\s+(?:test\b|use\s+it\b)/i,
  // "usable now"
  /\busable\s+now\b/i,
  // "feel free to use it" / "feel free to try it"
  /\bfeel\s+free\s+to\s+(?:use|try)\s+it\b/i,
];

/**
 * Negation words that void a usability claim when they appear ANYWHERE in the
 * lookback window immediately preceding a claim match (mt#2545 R1 fix). The
 * prior implementation required the negation word to be the LITERAL,
 * whitespace-only-separated prefix on the SAME LINE — which missed "not YET
 * ready to use" (the intervening word "yet" breaks an immediate-prefix
 * match), any negation separated from the claim by punctuation ("NOT, in any
 * sense, ready to use"), and a negation on the previous line of a wrapped
 * sentence. This version scans a fixed-size character window for the
 * PRESENCE of a negation word anywhere in it, independent of what's between
 * the negation and the claim.
 */
const NEGATION_WORD =
  /\b(?:not|isn'?t|aren'?t|ain'?t|wasn'?t|weren'?t|won'?t|wouldn'?t|can'?t|cannot|will\s+not|is\s+not|are\s+not|was\s+not|were\s+not)\b/i;

/** Characters of lookback scanned before a claim match for a negation word. */
const NEGATION_WINDOW_CHARS = 40;

/**
 * The text scanned for a negation word before a claim match at `matchIndex`
 * in `flat` — a lookback of up to `NEGATION_WINDOW_CHARS`, further capped at
 * the nearest preceding sentence-ending punctuation (`.`/`!`/`?`) within that
 * span. The clause-boundary cap matters: without it, a negation in an
 * EARLIER, unrelated sentence within `NEGATION_WINDOW_CHARS` characters would
 * bleed into a LATER, genuinely non-negated claim's window and wrongly
 * suppress it (e.g. "The old handler is not ready to use. The new one is
 * ready to use." — the second, real claim sits well within 40 characters of
 * the first sentence's "not"). Commas and other mid-clause punctuation are
 * NOT boundaries — "NOT, in any real sense, ready to use" must still count
 * as negated.
 */
function negationLookbackWindow(flat: string, matchIndex: number): string {
  const hardStart = Math.max(0, matchIndex - NEGATION_WINDOW_CHARS);
  const slice = flat.slice(hardStart, matchIndex);
  const lastBoundary = Math.max(
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?")
  );
  return lastBoundary === -1 ? slice : slice.slice(lastBoundary + 1);
}

/**
 * True when the PR body contains an altitude-4 usability claim (mt#2545). HTML
 * comments are stripped first (mirrors `hasDeployVerification`'s convention);
 * newlines are then flattened to spaces so a negation word on the PREVIOUS
 * line of a wrapped sentence is still visible in the lookback window (a
 * single flat scan replaces the prior fragile per-line loop). A claim whose
 * clause-capped lookback (see {@link negationLookbackWindow}) contains a
 * negation word is not counted — this covers same-line, intervening-word,
 * punctuation-separated, and line-wrapped negations alike, without
 * suppressing a later, unrelated, genuinely non-negated claim.
 */
export function hasUsabilityClaim(prBody: string): boolean {
  const stripped = prBody.replace(/<!--[\s\S]*?-->/g, "");
  const flat = stripped.replace(/\n/g, " ");
  for (const pattern of USABILITY_CLAIM_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = global.exec(flat)) !== null) {
      const before = negationLookbackWindow(flat, match.index);
      if (!NEGATION_WORD.test(before)) {
        return true;
      }
      if (global.lastIndex === match.index) global.lastIndex += 1; // zero-width guard
    }
  }
  return false;
}

/**
 * Rebuild-family term (rebuild/rebuilds/rebuilding/rebuilt, with or without a
 * hyphen). Anchored on the "buil" stem rather than "build" + suffix: "rebuilt"
 * is an irregular past tense (drops the trailing "d" — "built", not
 * "buildt"), so a naive `build(?:ing|s|t)?` suffix never matches it.
 */
const REBUILD_TERM = /\bre-?buil(?:d(?:s|ing)?|t)\b/i;
/** Reinstall-family term (reinstall/reinstalling/reinstalls/reinstalled, with or without a hyphen). */
const REINSTALL_TERM = /\bre-?install(?:ing|s|ed)?\b/i;

/**
 * True when the PR body contains an explicit rebuild + reinstall acknowledgment
 * (mt#2545) — the crossing step claim-confidence.mdc requires be named for a
 * Build/install-class deliverable. Requires BOTH a rebuild-family term AND a
 * reinstall-family term to appear anywhere in the body (HTML comments
 * stripped) — deliberately permissive on placement/order, since the
 * acknowledgment may be its own bullet or section separate from the usability
 * claim itself.
 */
export function hasRebuildReinstallAck(prBody: string): boolean {
  const stripped = prBody.replace(/<!--[\s\S]*?-->/g, "");
  return REBUILD_TERM.test(stripped) && REINSTALL_TERM.test(stripped);
}

export interface UsabilityClaimCheckResult {
  blocked: boolean;
  reason?: string;
  buildSurfaceFiles: string[];
  bypassDetected: boolean;
  warnings: string[];
}

/**
 * Run the Gap A usability-claim check given PR files + metadata. Pure core of
 * the hook — injectable for unit tests. Independent of
 * {@link checkDeployVerification}: this fires on the LOCAL-APP (build) surface,
 * not the Railway deploy surface, and blocks on a DIFFERENT condition (an
 * unwarranted usability claim, not a missing verification commitment).
 */
export function checkUsabilityClaim(
  prFiles: PrFile[],
  prTitle: string,
  prBody: string
): UsabilityClaimCheckResult {
  const warnings: string[] = [];
  const buildSurfaceFiles = findLocalAppDeploySurfaceFiles(prFiles);

  // No build surface touched → check is silent.
  if (buildSurfaceFiles.length === 0) {
    return { blocked: false, buildSurfaceFiles: [], bypassDetected: false, warnings };
  }

  // No `[no-deploy-impact]` title bypass here (mt#2545 R1 — deliberate, NOT an
  // oversight): a tray build-surface file IS a deploy/build surface by
  // definition (`isLocalAppDeploySurfaceFile`), so a title tag claiming "no
  // deploy impact" would be semantically wrong on this surface and would let
  // this HARD block be trivially skipped. The `[no-deploy-impact]` tag stays
  // scoped to the Railway `checkDeployVerification` check above ONLY. The two
  // intended escapes for this check are (a) adding the explicit rebuild +
  // reinstall acknowledgment (the spec's own escape — see the block below),
  // and (b) the dedicated audited `USABILITY_CLAIM_OVERRIDE_ENV_VAR` override.

  // No usability claim asserted → nothing to enforce.
  if (!hasUsabilityClaim(prBody)) {
    return { blocked: false, buildSurfaceFiles, bypassDetected: false, warnings };
  }

  // Usability claim present AND an explicit rebuild + reinstall acknowledgment → allow.
  if (hasRebuildReinstallAck(prBody)) {
    return { blocked: false, buildSurfaceFiles, bypassDetected: false, warnings };
  }

  // Usability claim present, no acknowledgment → block.
  const fileList = buildSurfaceFiles.map((f) => `  - ${f}`).join("\n");
  const reason =
    `Merge blocked: PR touches ${buildSurfaceFiles.length} build-surface (cockpit-tray native ` +
    `binary) file(s) and the PR body asserts principal-usability (e.g. "you can use it now" / ` +
    `"ready to use" / "it's live") WITHOUT an explicit rebuild + reinstall acknowledgment.\n\n` +
    `Per claim-confidence.mdc's Axis A (delivery state): this is a Build/install-class ` +
    `deliverable — \`deployed < usable\`, with NO agent-observable transition into \`usable\`. ` +
    `The tray's own Rust binary is NOT auto-rebuilt (only src/cockpit/** is), so a merged change ` +
    `stays invisible until the principal rebuilds + reinstalls. Asserting altitude-4 usability ` +
    `here is exactly the unwarranted claim the rule calls out (the mt#2528 originating ` +
    `incident) — state delivery at the altitude the class supports and name the crossing step ` +
    `instead.\n\n` +
    `Build-surface files:\n${fileList}\n\n` +
    `This is a HARD block — \`[no-deploy-impact]\` does NOT bypass it (a tray build-surface file ` +
    `IS a deploy/build surface). To unblock, choose one of:\n` +
    `  1. Add an explicit rebuild + reinstall acknowledgment to the PR body (e.g. "Merged — not ` +
    `yet usable; requires a tray rebuild + reinstall via cockpit-tray/scripts/install-local.sh ` +
    `before this is usable").\n` +
    `  2. Reword the claim to the correct delivery altitude instead of asserting usability ` +
    `(e.g. "Merged (verified-1a: cargo test green) — usable after tray rebuild + reinstall").\n` +
    `  3. Operator override: set \`${USABILITY_CLAIM_OVERRIDE_ENV_VAR}=1\` (audit-logged).`;

  return { blocked: true, reason, buildSurfaceFiles, bypassDetected: false, warnings };
}

// ---------------------------------------------------------------------------
// Top-level hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const startMs = Date.now();
  const input = await readInput<ToolHookInput>();
  // mt#3084 (evaluation-loop Phase 3): fire-log every evaluation, exactly
  // once per invocation regardless of which exit fires below.
  const recordAndExit: RecordAndExit = makeRecordAndExit(GUARD_NAME, startMs, input);

  // Operator override: skip with an audit line on stdout (non-JSON — Claude Code's
  // hook-output parser logs it as "Ignoring non-JSON line", matching the sibling
  // override-audit convention). Mutually exclusive with the deny path below.
  // Reviewer R1 BLOCKING #2: does NOT echo the raw env value — hook stdout is
  // persisted to transcripts and ingested (CLAUDE.md "Secret handling in shell
  // commands"); presence/name only, matching `require-growth-justification-
  // before-merge.ts` / `block-subagent-merge-without-grant.ts`.
  if (isOverrideSet()) {
    process.stdout.write(
      `[deploy-verification] override active: ${OVERRIDE_ENV_VAR} set at ` +
        `${new Date().toISOString()} — deploy-verification gate skipped (value not echoed)\n`
    );
    recordAndExit("allow", {
      overrideEnvVar: OVERRIDE_ENV_VAR,
      overrideClassification: classifyOverride(OVERRIDE_ENV_VAR),
    });
  }

  const task = (input.tool_input.task as string | undefined) ?? "";
  if (!task) recordAndExit("allow");

  // Derive owner/repo from the git remote (forks + non-edobry/minsky remotes).
  const repo = deriveRepoFromGit(input.cwd);
  if (!repo) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "⚠️ [deploy-verification] Could not derive owner/repo from git remote — check skipped.",
      },
    });
    recordAndExit("warn");
  }

  // mt#2617: ONE consolidated fetch (PR-number resolution + title/body/files)
  // instead of the previous resolvePrNumber (1-2 calls) + fetchPrMeta (1
  // call) + fetchPrFiles (1 call) = up to 4 calls.
  const context = fetchPrContext(repo, { task, cwd: input.cwd, include: { files: true } });

  // Fail-open: can't fetch PR data → allow with a warning. mt#2617 R1
  // BLOCKING #2: surface BOTH the primary resolution warning AND any
  // accumulated per-call warnings (e.g. a fetchPrFiles warning that fired
  // before meta resolution failed) — dropping the latter silently lost
  // operator-visible signal the pre-refactor code always surfaced.
  if (!context.ok) {
    const allFailureWarnings = formatContextFailureWarnings(context);
    const lastIndex = allFailureWarnings.length - 1;
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: allFailureWarnings
          .map((w, i) => (i === lastIndex ? `⚠️ [deploy-verification] ${w}` : `⚠️ ${w}`))
          .join("\n"),
      },
    });
    recordAndExit("warn");
  }

  const { title: prTitle, body: prBody, files: prFiles, warnings: topLevelWarnings } = context;

  const deployResult = checkDeployVerification(prFiles, prTitle, prBody);

  // Gap A (mt#2545): independent override for the usability-claim check only —
  // does not affect the Railway deploy-verification check above. Unlike the
  // top-level MINSKY_SKIP_DEPLOY_VERIFY override above, this one does NOT
  // exit immediately — it neutralizes ONE sub-check and the hook keeps going,
  // so mt#3084 tracks it in `usabilityOverrideFields` and attaches it to
  // whichever recordAndExit call below actually fires (deny, warn, or the
  // final allow) rather than assuming the override implies an allow outcome.
  //
  // Reviewer R1 NON-BLOCKING: no simultaneous-override conflation is possible
  // here — the top-level MINSKY_SKIP_DEPLOY_VERIFY branch above calls
  // `recordAndExit` directly (process.exit(0)), so control never reaches this
  // point when it fires. Only ONE override variable (`usabilityOverrideFields`)
  // is ever live by the time the final recordAndExit calls below run.
  let usabilityResult: UsabilityClaimCheckResult;
  let usabilityOverrideFields:
    | { overrideEnvVar: string; overrideClassification: ReturnType<typeof classifyOverride> }
    | undefined;
  if (isUsabilityClaimOverrideSet()) {
    // Reviewer R1 BLOCKING #2: value not echoed — see the rationale on the
    // MINSKY_SKIP_DEPLOY_VERIFY override audit line above.
    process.stdout.write(
      `[usability-claim] override active: ${USABILITY_CLAIM_OVERRIDE_ENV_VAR} set ` +
        `at ${new Date().toISOString()} — usability-claim gate skipped (value not echoed)\n`
    );
    usabilityResult = {
      blocked: false,
      buildSurfaceFiles: [],
      bypassDetected: false,
      warnings: [],
    };
    usabilityOverrideFields = {
      overrideEnvVar: USABILITY_CLAIM_OVERRIDE_ENV_VAR,
      overrideClassification: classifyOverride(USABILITY_CLAIM_OVERRIDE_ENV_VAR),
    };
  } else {
    usabilityResult = checkUsabilityClaim(prFiles, prTitle, prBody);
  }

  const allWarnings = [...topLevelWarnings, ...deployResult.warnings, ...usabilityResult.warnings];
  const blockingReasons = [deployResult, usabilityResult]
    .filter((r) => r.blocked)
    .map((r) => r.reason)
    .filter((r): r is string => Boolean(r));

  if (blockingReasons.length > 0) {
    const warningContext =
      allWarnings.length > 0 ? `${allWarnings.map((w) => `⚠️ ${w}`).join("\n")}\n\n` : "";
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${warningContext}${blockingReasons.join("\n\n---\n\n")}`,
      },
    });
    recordAndExit("deny", usabilityOverrideFields);
  } else if (allWarnings.length > 0) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: allWarnings.map((w) => `⚠️ ${w}`).join("\n"),
      },
    });
    recordAndExit("warn", usabilityOverrideFields);
  }
  recordAndExit("allow", usabilityOverrideFields);
}
