#!/usr/bin/env bun
// PostToolUse observer on the `Agent` tool (mt#3257): verify the dispatched subagent's ACTUAL
// model tier against the requested one, and surface a mismatch into the conversation.
//
// ## Why this exists
//
// A committed `CLAUDE_CODE_SUBAGENT_MODEL: "sonnet"` pin silently overrode every per-call
// `model` request in BOTH directions for three months (mt#3151 removed it per ask#6205). During
// that window an entire investigation (mt#3094, 11/11 dispatches requesting `fable`) ran as
// Sonnet while being reported to the operator as frontier-tier — false provenance produced by
// trusting the REQUEST as evidence of the OUTCOME. The signal that would have caught it existed
// (the per-agent transcript records the model actually used) but nothing read it; "someone
// remembers to grep a transcript" is not a mechanism. This hook is that mechanism.
//
// ## How it works — measured payload, not assumed
//
// The Agent-tool PostToolUse payload carries BOTH sides of the comparison (established by three
// direct captures on Claude Code 2.1.220, recorded in mt#3257's spec — the vendor hooks doc
// documents the PostToolUse mechanism but is silent on these fields):
//
//   - `tool_input.model` — the requested tier, in alias form (`"haiku"`), present only when the
//     caller passed one;
//   - `tool_response.resolvedModel` — the full id of the model that actually ran
//     (`"claude-haiku-4-5-20251001"`), present in BOTH dispatch modes: on completion for a
//     synchronous dispatch, and already at launch for `run_in_background: true` (status
//     `async_launched`).
//
// No transcript resolution is needed, which sidesteps the two-layout problem (`~/.claude/
// projects/.../subagents/agent-<id>.jsonl` vs `<conv>/tasks/<id>.output` — both real, split
// version/mode-dependent) entirely.
//
// ## Payload-key note (`tool_response` vs `tool_result`)
//
// This repo's `ToolHookInput` declares `tool_result`, but the measured 2.1.220 payload key is
// `tool_response` — and mt#3182 already found production `session_start` PostToolUse payloads
// carry no parsed `tool_result` (its hook wrote 0 rows against 235 sessions before its fix).
// This hook reads `tool_response` first and falls back to `tool_result`, so a harness rename in
// either direction degrades to the logged `response-missing` trace below instead of silence.
//
// ## Fail-open contract
//
// This is an OBSERVER (hook-observers.mdc): it never blocks, never delays, and exits 0 on every
// path. A payload whose fields are absent (older/newer harness, error result) is NOT a mismatch:
// it appends a `resolved-model-missing` / `response-missing` record to the mismatch log — a
// quiet, greppable trace chosen deliberately over silent fail-open, because a silently-dead
// verification hook is exactly the mem#528 failure class ("listed as active" is not "fires").
//
// ## What this does NOT cover
//
// `tasks_dispatch` dispatches are headless spawns, not Agent-tool calls — this hook never sees
// them. That path's verification is the per-agent `actual_model` recording (mt#3256).
//
// @see mt#3257 — this hook's task (probe records for all three payload captures)
// @see mt#3151 — the pin removal that made explicit tiers resolve at all
// @see mt#3256 — actual_model recording, the tasks_dispatch-path sibling signal
// @see .minsky/hooks/warn-bare-prohibition-dispatch.ts — PreToolUse sibling on the same tool
// @see .minsky/rules/hook-observers.mdc "Subagent model verification"

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Override env var: set to "1"/"true"/"yes" to suppress the check and its log entirely. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_SUBAGENT_MODEL_CHECK";

/**
 * Mismatch/trace log FILE NAME — bare, with no `.minsky/` prefix and no directory.
 *
 * mt#4816: this was `.minsky/subagent-model-mismatch.jsonl`, relative to the repo root, which
 * made it the last telemetry writer depositing a file into whatever Minsky-managed project the
 * agent happened to be working in — the condition mt#4748's SC2 forbids. The value is now the
 * bare name so it is BYTE-IDENTICAL to the `relativePath` its row declares in
 * `packages/domain/src/guard-events/stream-sources.ts`; the two are asserted equal in this
 * hook's test, so they cannot drift apart the way `ask-form-lint`'s did (mt#4811).
 */
export const MISMATCH_LOG = "subagent-model-mismatch.jsonl";

/**
 * Tool names this hook reacts to. The settings matcher is `Agent`; `Task` is the same tool's
 * older/community name, tolerated here so a matcher widened later needs no code change.
 */
export const TARGET_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * Requested-alias to resolved-model-id prefix map. The Agent tool's `model` param takes an
 * alias; `resolvedModel` is a full model id. Prefix pairs measured in mt#3257's probes
 * (`opus` -> `claude-opus-5`, `haiku` -> `claude-haiku-4-5-20251001`) plus the two remaining
 * aliases the tool's enum documents, following the same `claude-<alias>` id convention.
 */
export const ALIAS_PREFIXES: Readonly<Record<string, string>> = {
  sonnet: "claude-sonnet",
  opus: "claude-opus",
  haiku: "claude-haiku",
  fable: "claude-fable",
};

/** True when the override env var is set to a recognized truthy value. */
export function isOverrideActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[OVERRIDE_ENV_VAR];
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * ToolHookInput plus the payload key production actually delivers (`tool_response`), which the
 * repo's shared type does not declare yet — see the payload-key note in the header.
 */
type PostToolUsePayload = ToolHookInput & { tool_response?: unknown };

/**
 * Extract the tool's response object, accepting the measured key (`tool_response`) first and
 * the repo-typed legacy key (`tool_result`) second — see the payload-key note in the header.
 */
export function extractResponse(input: ToolHookInput): Record<string, unknown> | null {
  const payload = input as PostToolUsePayload;
  for (const value of [payload.tool_response, payload.tool_result]) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * True when the resolved model id satisfies the requested tier. A known alias matches its
 * `claude-<alias>` id-prefix family; an unrecognized request is treated as EITHER a (possibly
 * full) model id compared directly, OR a future alias following the same `claude-<alias>` id
 * convention the four known aliases follow — so a new vendor alias this table hasn't learned
 * yet (e.g. `"frontier"` resolving to `claude-frontier-1`) verifies instead of false-warning
 * (PR #2388 R1 BLOCKING #1).
 */
export function requestedMatchesResolved(requested: string, resolved: string): boolean {
  const alias = requested.trim().toLowerCase();
  const prefix = ALIAS_PREFIXES[alias];
  if (prefix) {
    return resolved === prefix || resolved.startsWith(`${prefix}-`);
  }
  return (
    resolved === alias ||
    resolved.startsWith(`${alias}-`) ||
    resolved === `claude-${alias}` ||
    resolved.startsWith(`claude-${alias}-`)
  );
}

export type ModelCheckDecision =
  | { kind: "silent"; reason: string }
  | { kind: "log-only"; reason: string; record: Record<string, unknown> }
  | { kind: "warn"; reason: string; message: string; record: Record<string, unknown> };

/** Shared fields for every record this hook appends. */
function baseRecord(input: ToolHookInput, requested: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    // The DISPATCHING agent's id (set when a subagent made the dispatch), not the new subagent.
    dispatching_agent_id: input.agent_id ?? null,
    tool_name: input.tool_name,
    requested,
  };
}

/**
 * Core decision logic (pure — exported for testing). Every exit states a reason; the mismatch
 * warning is the only path that injects context into the conversation.
 */
export function decideModelCheck(
  input: ToolHookInput,
  env: NodeJS.ProcessEnv = process.env
): ModelCheckDecision {
  if (isOverrideActive(env)) {
    return { kind: "silent", reason: `${OVERRIDE_ENV_VAR} override active` };
  }

  if (!TARGET_TOOL_NAMES.has(input.tool_name)) {
    return { kind: "silent", reason: "not an Agent-tool call" };
  }

  const requestedRaw = input.tool_input?.["model"];
  if (typeof requestedRaw !== "string" || requestedRaw.trim().length === 0) {
    return { kind: "silent", reason: "no model tier requested on this dispatch" };
  }
  const requested = requestedRaw.trim();

  const response = extractResponse(input);
  if (response === null) {
    return {
      kind: "log-only",
      reason: "tool response object absent from payload (tool_response/tool_result)",
      record: { ...baseRecord(input, requested), kind: "response-missing" },
    };
  }

  const resolved = response["resolvedModel"];
  if (typeof resolved !== "string" || resolved.trim().length === 0) {
    return {
      kind: "log-only",
      reason: "resolvedModel absent from tool response — payload shape may have changed",
      record: {
        ...baseRecord(input, requested),
        kind: "resolved-model-missing",
        response_status: response["status"] ?? null,
      },
    };
  }

  if (requestedMatchesResolved(requested, resolved)) {
    return { kind: "silent", reason: `requested ${requested} matches resolved ${resolved}` };
  }

  const agentId = typeof response["agentId"] === "string" ? response["agentId"] : "unknown";
  const message = [
    `[verify-subagent-model] Subagent model MISMATCH: this dispatch requested \`${requested}\``,
    `but actually ran \`${resolved}\` (agentId ${agentId}).`,
    `Do NOT report this subagent's work as ${requested}-tier — the resolved model is the`,
    `authoritative record (mt#3257; /check-premise cue (h): "the tool accepted the param" is not`,
    `evidence it took effect). If the mismatch is expected and acknowledged, set`,
    `${OVERRIDE_ENV_VAR}=1.`,
  ].join(" ");

  return {
    kind: "warn",
    reason: `requested ${requested}, resolved ${resolved}`,
    message,
    record: {
      ...baseRecord(input, requested),
      kind: "mismatch",
      resolved,
      subagent_id: agentId,
      response_status: response["status"] ?? null,
      is_async: response["isAsync"] === true,
    },
  };
}

/**
 * State dir this stream's log lives under — FLAT, not project-keyed.
 *
 * mt#4816 decided flat over project-keyed for the `special` family, and the reason is that
 * project attribution never depended on the path: `attachProjectIds`
 * (`packages/domain/src/guard-events/ingest-service.ts`) resolves each row's `project_id` from
 * the record's own `session_id`, and uses the file path only for the `source_path` column. So a
 * flat file loses nothing, and it matches how `fire-log` and `guard-health-log` — the two
 * siblings in this family — are already treated.
 *
 * **Keyed on `MINSKY_STATE_DIR`, deliberately NOT `getMinskyStateDir()`.** Those two resolve
 * differently: `getMinskyStateDir()` (`@minsky/shared/paths`) keys on `XDG_STATE_HOME` ONLY, and
 * mt#3965 records that as an intentional choice. The READER here is the guard-events ingest,
 * whose `resolveStateDir` (`packages/domain/src/guard-events/ingest-runtime.ts`) keys on
 * `MINSKY_STATE_DIR` — as do `fire-log.ts` and `guard-health.ts`, the two flat siblings. Using
 * the shared helper would therefore reproduce exactly the writer/reader split mt#4811 found live
 * in `ask-form-lint`, where the sweep read an empty corpus and reported "this guard never fired."
 * The agreement is asserted in this hook's test rather than left to these two derivations
 * staying in sync by hand.
 */
export function getSubagentModelStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env["MINSKY_STATE_DIR"];
  if (envDir) return envDir;
  return join(homedir(), ".local", "state", "minsky");
}

/** Absolute path of this stream's log. Must equal `resolveStreamPath`'s answer for its row. */
export function getMismatchLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getSubagentModelStateDir(env), MISMATCH_LOG);
}

/**
 * Append one log record; never throws (a logging failure must not affect the turn).
 *
 * `env` is injected rather than read from the module so a test can point the write at a temp
 * directory without mutating `process.env` — the same shape `fire-log.ts` uses.
 */
export function appendMismatchRecord(
  record: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): void {
  try {
    const logPath = getMismatchLogPath(env);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[verify-subagent-model] Failed to write mismatch log: ${msg}\n`);
  }
}

async function main(): Promise<void> {
  let input: ToolHookInput;
  try {
    input = await readInput<ToolHookInput>();
  } catch {
    // Malformed stdin — exit silently. Never block.
    process.exit(0);
  }

  let decision: ModelCheckDecision;
  try {
    decision = decideModelCheck(input);
  } catch (err) {
    // Fail open on any decision error — a comparison bug must never affect a dispatch's turn.
    process.stderr.write(
      `[verify-subagent-model] Decision error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }

  if (decision.kind === "log-only" || decision.kind === "warn") {
    appendMismatchRecord(decision.record);
  }

  if (decision.kind === "warn") {
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: decision.message,
      },
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

if (import.meta.main) {
  main();
}
