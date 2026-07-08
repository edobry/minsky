#!/usr/bin/env bun
/**
 * Orchestrator-side surface for issuing an ADR-028 D5 subagent
 * merge-capability grant.
 *
 * `.minsky/hooks/block-subagent-merge-without-grant.ts` denies a
 * subagent-initiated `mcp__minsky__session_pr_merge` call by default
 * (ADR-028 D5). This script is the escape valve: the ORCHESTRATOR (main
 * agent, or an orchestrating parent coordinating a burndown-style wave of
 * subagent dispatches) runs it — at or after dispatch time, BEFORE the
 * subagent's merge attempt — to write a TTL-bound capability grant to the
 * shared grant store the guard reads.
 *
 * Usage:
 *
 *   bun scripts/grant-subagent-merge.ts --task mt#2651 [--ttl-minutes 30] \
 *     [--agent-scope any] [--issued-by "<note>"] [--reason "<note>"]
 *
 * Flags:
 *
 *   --task <id>          Required. Task id this grant authorizes (e.g. "mt#2651").
 *   --ttl-minutes <n>    Optional. Grant lifetime in minutes. Default: 30
 *                        (order of a typical bounded subagent dispatch, per
 *                        ADR-028 D5's "short TTL... on the order of a typical
 *                        subagent dispatch duration").
 *   --agent-scope <s>    Optional. "any" (default) authorizes any subagent
 *                        dispatched for the task, or a specific harness
 *                        agent_id to scope the grant tighter.
 *   --issued-by <note>   Optional. Free-form audit note identifying the
 *                        issuing orchestrator/session (e.g. the parent
 *                        session id or a short description).
 *   --reason <note>      Optional. Free-form justification for the grant.
 *   --dry-run            Preview the grant that would be written without
 *                        writing it.
 *
 * This is deliberately a lightweight CLI script rather than a new MCP tool
 * or dispatcher registration (ADR-028 D5 names both as Phase 3 options;
 * mt#2651's spec explicitly asks for "whatever is cheapest that an
 * orchestrator can invoke"). See
 * `.minsky/rules/hook-files.mdc` §"Subagent Merge Capability Guard" for the
 * full guard + grant documentation, and
 * `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` §D5
 * for the design rationale.
 *
 * @see mt#2651 — this script's tracking task
 */

import {
  appendGrant,
  getMergeGrantStorePath,
  normalizeTaskId,
} from "../.minsky/hooks/merge-grant-store";
import type { MergeGrant } from "../.minsky/hooks/merge-grant-store";

const DEFAULT_TTL_MINUTES = 30;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function printUsage(): void {
  console.error(
    "Usage: bun scripts/grant-subagent-merge.ts --task mt#<id> " +
      "[--ttl-minutes 30] [--agent-scope any] [--issued-by <note>] " +
      "[--reason <note>] [--dry-run]"
  );
}

/** Build the MergeGrant record from parsed CLI args. Exported for testing. */
export function buildGrantFromArgs(
  args: Record<string, string>,
  nowIso: string
): MergeGrant | null {
  const task = args["task"];
  if (!task) return null;

  const ttlMinutesRaw = args["ttl-minutes"];
  const ttlMinutes = ttlMinutesRaw ? Number(ttlMinutesRaw) : DEFAULT_TTL_MINUTES;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return null;

  return {
    taskId: normalizeTaskId(task),
    agentScope: args["agent-scope"] ?? "any",
    issuedAt: nowIso,
    ttlMs: ttlMinutes * 60 * 1000,
    issuedBy: args["issued-by"],
    reason: args["reason"],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const grant = buildGrantFromArgs(args, new Date().toISOString());
  if (!grant) {
    printUsage();
    process.exit(1);
  }

  const storePath = getMergeGrantStorePath();
  const expiresAt = new Date(Date.parse(grant.issuedAt) + grant.ttlMs).toISOString();

  if (args["dry-run"] === "true") {
    console.log(
      `[dry-run] would grant subagent merge capability: task=${grant.taskId} ` +
        `scope=${grant.agentScope} issuedAt=${grant.issuedAt} expiresAt=${expiresAt} ` +
        `store=${storePath}`
    );
    return;
  }

  appendGrant(storePath, grant);
  console.log(
    `Granted subagent merge capability: task=${grant.taskId} scope=${grant.agentScope} ` +
      `expiresAt=${expiresAt} store=${storePath}`
  );
}

if (import.meta.main) {
  await main();
}
