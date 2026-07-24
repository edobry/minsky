#!/usr/bin/env bun
// UserPromptSubmit hook: detect a single assistant turn that batches an
// id-MINTING tool call (tasks_create, session_start, session_pr_create,
// asks_create, memory_create) together — in the SAME parallel tool-call
// batch (one assistant message, multiple tool_use blocks) — with a call
// whose free-text input is likely to reference that id (session_commit's
// `message`, session_pr_create/session_pr_edit's `body`, tasks_spec_patch's
// `content`, memory_create's `content`). Per mt#3125.
//
// mem#511 (feedback_never_guess_session_path_or_prenarrate_tool_outcomes)
// diagnosed the ROOT of the constructed-identifier / pre-narration family:
// "batching dependent tool calls into one parallel block. Step N+1 can't
// know its inputs until step N returns, so a batched dependent chain FORCES
// guessing + happy-path narration." Two structural fixes already shipped
// from that memory — mt#2195 (guessed-session-path guard) and mt#2197
// (pre-narration detector) — but BOTH guard symptoms: specific downstream
// identifier surfaces (a filesystem path, a narrated prose claim), not the
// batch itself. The family recurred on an uncovered surface 2026-07-23
// (mt#3090): `tasks_create` batched with `session_commit`, whose message had
// to name the not-yet-returned task id. Neither existing guard could fire —
// mt#2195 has no path to check; mt#2197 has no narrated prose to check
// (`tasks_create` DID run that turn, so its no-matching-tool-use
// discriminator was satisfied even though the id was still guessed).
//
// This is the ROOT-tier guard: it fires directly on the batching
// precondition, independent of which downstream identifier surface (task
// id, PR number, ask uuid, memory id, sessionId...) the consuming call's
// free text happens to reference.
//
// INFORMATIONAL ONLY / CALIBRATION-FIRST (mt#3125 SC3, mirrors the
// causal-premise-detector mt#2216 / mt#2263 ladder precedent): v1 logs
// matches and injects NOTHING. INJECTION_ENABLED gates that; flip only
// after reviewing the false-positive rate from the calibration log.
//
// False-positive posture is explicit (SC4): batching a minting call with a
// genuinely INDEPENDENT consumer (one whose free text does NOT reference the
// minted entity) is legitimate and is the MAIN false-positive source — this
// detector does not attempt to disambiguate at detection time (no NLP/regex
// match against the minted id, which does not exist yet when the batch is
// authored); that disambiguation is exactly what calibration review measures.
//
// "Same tool block" is deliberately narrower than "same turn": a batch is
// multiple tool_use blocks inside ONE assistant message's content array
// (a genuinely parallel dispatch). Tool calls from two DIFFERENT assistant
// messages in the same logical turn (separated by a tool_result round-trip)
// are excluded — by the time the second message is composed, the first
// call's real result is already in hand, so that shape is not the failure
// this task guards (Success Criterion 1: "in the same tool block").
//
// @see mt#3125 — this task
// @see mem#511 — feedback_never_guess_session_path_or_prenarrate_tool_outcomes
// @see mt#2195 — sibling guessed-session-path guard (symptom: fs path)
// @see mt#2197 — sibling pre-narration detector (symptom: narrated prose)
// @see mt#2199 — always-injected root rule (CLAUDE.md §Sequence Dependent Tool Calls)
// @see .claude/hooks/causal-premise-detector.ts — calibration-first (INJECTION_ENABLED) template
// @see .claude/hooks/pre-narration-detector.ts — sibling structure + calibration-log pattern
// @see mt#2652 — ADR-028 Phase 2a: this file's exported `run()` is the
//      dispatcher-compatible entry point invoked in-process by
//      `./dispatch-userpromptsubmit.ts`; `main()` / the CLI entrypoint below
//      is the standalone-invocable twin (same convention as every sibling
//      detector in this family).

import { readInput, findRepoRoot } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { parseTranscript, extractLastAssistantTurn } from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection (mt#3125 SC3)
// ---------------------------------------------------------------------------

/**
 * When false (v1/calibration mode), the hook logs matches to JSONL and
 * injects NO additionalContext. Flip to true only after reviewing the
 * fire rate + false-positive rate from the calibration log (mt#2263 ladder).
 */
export const INJECTION_ENABLED = false;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_CONSTRUCTED_IDENTIFIER_BATCH";

const CALIBRATION_LOG = ".minsky/constructed-identifier-batch-calibration.jsonl";

// ---------------------------------------------------------------------------
// Category definitions (Success Criterion 1)
// ---------------------------------------------------------------------------

/**
 * Id-MINTING tool names — a call that mints a new resource id server-side
 * and returns it in its result (the caller never supplies the id as input).
 * Both MCP-prefixed and bare forms are listed (transcripts have been
 * observed with either — same convention as every sibling detector's
 * `requiredTools`/`names` lists in this family).
 */
export const MINT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mcp__minsky__tasks_create",
  "tasks_create",
  "mcp__minsky__session_start",
  "session_start",
  "mcp__minsky__session_pr_create",
  "session_pr_create",
  "mcp__minsky__asks_create",
  "asks_create",
  "mcp__minsky__memory_create",
  "memory_create",
]);

export interface ConsumeToolSpec {
  /** Tool names (MCP-prefixed + bare) whose call carries the free-text field. */
  names: readonly string[];
  /** The `tool_input` field name holding text likely to reference a minted id. */
  field: string;
}

/**
 * Id-CONSUMING tool+field pairs — a call whose free-text input is the kind of
 * field that routinely names another entity's id (a commit message crossref,
 * a PR body, a spec patch, a memory note). `session_pr_create` appears here
 * too (in addition to `MINT_TOOL_NAMES`): its OWN mint (a PR number) isn't
 * knowable within the same call, but its `body` field can still reference a
 * DIFFERENT id minted earlier in the same batch (e.g. a `tasks_create` result).
 */
export const CONSUME_TOOL_SPECS: readonly ConsumeToolSpec[] = [
  { names: ["mcp__minsky__session_commit", "session_commit"], field: "message" },
  { names: ["mcp__minsky__session_pr_create", "session_pr_create"], field: "body" },
  { names: ["mcp__minsky__session_pr_edit", "session_pr_edit"], field: "body" },
  { names: ["mcp__minsky__tasks_spec_patch", "tasks_spec_patch"], field: "content" },
  { names: ["mcp__minsky__memory_create", "memory_create"], field: "content" },
];

function findConsumeSpec(name: string): ConsumeToolSpec | undefined {
  return CONSUME_TOOL_SPECS.find((spec) => spec.names.includes(name));
}

// ---------------------------------------------------------------------------
// Detection (pure, exported for testing)
// ---------------------------------------------------------------------------

export interface ToolUseBlock {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Group tool_use blocks by their originating assistant MESSAGE — one array
 * per assistant transcript line — so a genuinely parallel batch (multiple
 * tool_use blocks inside ONE assistant message's content array) is
 * distinguishable from tool calls spread across separate assistant messages
 * of the same logical turn (interleaved with a tool_result round-trip). Only
 * the former is "the same tool block" this detector's Success Criterion 1
 * requires — see the module header for why the latter is out of scope.
 */
export function extractToolUseBlocksByMessage(turnLines: TranscriptLine[]): ToolUseBlock[][] {
  const groups: ToolUseBlock[][] = [];
  for (const line of turnLines) {
    if (line.type !== "assistant" && line.message?.role !== "assistant") continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    const blocks: ToolUseBlock[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block["type"] === "tool_use" && typeof block["name"] === "string") {
        const rawInput = block["input"];
        const input =
          rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
        blocks.push({ name: block["name"] as string, input });
      }
    }
    if (blocks.length > 0) groups.push(blocks);
  }
  return groups;
}

export interface BatchMatch {
  mintTool: string;
  consumeTool: string;
  consumeField: string;
  /** First 200 chars of the free-text field's value, for the calibration record. */
  excerpt: string;
}

/**
 * Detect batched (id-minting, id-consuming) tool-call PAIRS within a turn.
 *
 * For each assistant message's block group (Success Criterion 1's "same tool
 * block"), every ordered pair of DISTINCT blocks (i, j) where block i is an
 * id-minting call and block j is an id-consuming call with a non-empty
 * free-text field produces one match. `i === j` is excluded — a single call
 * that is both categories (`session_pr_create`) cannot reference its own
 * not-yet-existent id, so self-pairing is not a real instance of the failure.
 *
 * Deduplicated per (mintTool, consumeTool, consumeField) triple so a batch
 * with multiple calls of the same shape doesn't produce redundant records.
 *
 * Categorical by design (SC1/SC4): this does NOT attempt to determine
 * whether the consuming call's text ACTUALLY references the minted id — the
 * minted id doesn't exist yet at authoring time, so no string match is
 * possible. Co-occurrence of the two categories in one batch is the whole
 * signal; disambiguating genuine dependence from a legitimate independent
 * pairing is deferred to calibration review (SC4).
 */
export function detectBatchedMintAndConsume(turnLines: TranscriptLine[]): BatchMatch[] {
  const groups = extractToolUseBlocksByMessage(turnLines);
  const seen = new Set<string>();
  const matches: BatchMatch[] = [];

  for (const blocks of groups) {
    for (let i = 0; i < blocks.length; i++) {
      const mintBlock = blocks[i];
      if (!mintBlock || !MINT_TOOL_NAMES.has(mintBlock.name)) continue;

      for (let j = 0; j < blocks.length; j++) {
        if (i === j) continue;
        const consumeBlock = blocks[j];
        if (!consumeBlock) continue;
        const spec = findConsumeSpec(consumeBlock.name);
        if (!spec) continue;

        const rawValue = consumeBlock.input[spec.field];
        if (typeof rawValue !== "string" || rawValue.trim().length === 0) continue;

        const key = `${mintBlock.name}|${consumeBlock.name}|${spec.field}`;
        if (seen.has(key)) continue;
        seen.add(key);

        matches.push({
          mintTool: mintBlock.name,
          consumeTool: consumeBlock.name,
          consumeField: spec.field,
          excerpt: rawValue.slice(0, 200),
        });
      }
    }
  }
  return matches;
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
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[constructed-identifier-batch-detector] Failed to write calibration log: ${msg}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Injection text (gated by INJECTION_ENABLED; SC2 — names the specific
// minting + consuming calls and states the rule)
// ---------------------------------------------------------------------------

export function buildReminder(matches: BatchMatch[]): string {
  const lines = matches
    .map(
      (m) =>
        `  - \`${m.mintTool}\` (mints an id) batched with \`${m.consumeTool}\`'s \`${m.consumeField}\` field: "${m.excerpt}"`
    )
    .join("\n");

  return [
    "[constructed-identifier-batch-detector] Batched dependent tool call detected (mt#3125).",
    "",
    "The prior assistant turn batched an id-MINTING tool call together with a call whose",
    "free-text input is likely to reference that id, in the SAME parallel tool-call batch.",
    "Step N+1 cannot know step N's minted id until step N's real result is read — a batched",
    "dependent chain forces guessing the id (mem#511; CLAUDE.md §Sequence Dependent Tool Calls).",
    "",
    "Matched pairs:",
    lines,
    "",
    "Required: read the minting call's real result THIS turn, then write the consuming",
    "call's free text in the NEXT turn. Never construct/guess an id (taskId, sessionId,",
    "PR number, ask uuid, memory id) before the minting call returns it.",
    "",
    "If the two calls are genuinely INDEPENDENT (the consuming call's text does not",
    `reference the minted id), this is a false positive under calibration review — set ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652 Phase 2a)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Mirrors `main()`'s orchestration but returns
 * a `GuardOutcome` instead of writing to stdout/`process.exit`. Reuses
 * `ctx.transcriptLines` (D6) instead of re-parsing the transcript itself.
 * Calibration is logged unconditionally on a match; `additionalContext` is
 * gated behind `INJECTION_ENABLED` (false — calibration-first, mt#3125 SC3).
 */
export function run(input: ClaudeHookInput, ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  if (isOverride) {
    return {
      auditLines: [
        `[constructed-identifier-batch-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  let matches: BatchMatch[];
  try {
    const turnLines = extractLastAssistantTurn(lines);
    if (turnLines.length === 0) return null;
    matches = detectBatchedMintAndConsume(turnLines);
  } catch (err) {
    process.stderr.write(
      `[constructed-identifier-batch-detector] Detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  if (matches.length === 0) return null;

  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      injection_enabled: INJECTION_ENABLED,
      // "matches"-shape family (mirrors retrospective-trigger / ask-routing-deferral /
      // pre-narration — see src/domain/calibration/calibration-sweep.ts's fallback
      // parse branch). `category` is the (mintTool, consumeTool) pair label the
      // shared diversity-extraction reads; `phrase` is the excerpt. mintTool/
      // consumeTool/consumeField are carried as extra context for full audit
      // fidelity, not consulted by the shared sweep parser.
      matches: matches.map((m) => ({
        category: `${m.mintTool}+${m.consumeTool}`,
        phrase: m.excerpt,
        mintTool: m.mintTool,
        consumeTool: m.consumeTool,
        consumeField: m.consumeField,
      })),
    },
  };

  if (INJECTION_ENABLED) {
    outcome.additionalContext = buildReminder(matches);
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
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
      `[constructed-identifier-batch-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  let lines: TranscriptLine[];
  try {
    lines = parseTranscript(transcriptPath);
  } catch (err) {
    console.error(
      `[constructed-identifier-batch-detector] Failed to read transcript: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (lines.length === 0) {
    process.exit(0);
  }

  let matches: BatchMatch[];
  try {
    const turnLines = extractLastAssistantTurn(lines);
    if (turnLines.length === 0) {
      process.exit(0);
    }
    matches = detectBatchedMintAndConsume(turnLines);
  } catch (err) {
    console.error(
      `[constructed-identifier-batch-detector] Detection error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (matches.length === 0) {
    process.exit(0);
  }

  // Calibration record (always — this is the v1 product, mirroring
  // causal-premise-detector / ask-routing-deferral-detector).
  appendCalibrationRecord(input.cwd, {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    injection_enabled: INJECTION_ENABLED,
    matches: matches.map((m) => ({
      category: `${m.mintTool}+${m.consumeTool}`,
      phrase: m.excerpt,
      mintTool: m.mintTool,
      consumeTool: m.consumeTool,
      consumeField: m.consumeField,
    })),
  });

  // Calibration-first: inject only when the gate is flipped on.
  if (!INJECTION_ENABLED) {
    process.exit(0);
  }

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
