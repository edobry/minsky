#!/usr/bin/env bun
/**
 * Issuance surface for an approved-Ask action grant (mt#2823).
 *
 * Materializes a responded, operator-approved `authorization.approve` Ask
 * into a narrow, TTL-bound, ONE-SHOT grant record that
 * `.minsky/hooks/ask-permission-bridge.ts` (PreToolUse) consults to emit the
 * harness `permissionDecision: "allow"` for exactly the approved action.
 *
 * The script VERIFIES the ask server-side before writing (state
 * responded/closed, kind authorization.approve, responder "operator",
 * approving response value) — and the bridge re-verifies at decision time,
 * so this write is a convenience materialization, never the authority.
 *
 * Usage:
 *
 *   bun scripts/grant-ask-action.ts --ask <askId> \
 *     (--command-exact "<cmd>" | --command-pattern "<regex>") \
 *     [--tool Bash] [--ttl-minutes 15] [--reason "<note>"] \
 *     [--issued-by "<note>"] [--dry-run]
 *
 * Flags:
 *
 *   --ask <id>              Required. The responded authorization.approve
 *                           Ask id (full uuid).
 *   --command-exact <cmd>   The exact command approved — regex-escaped and
 *                           anchored. Preferred: narrowest possible grant.
 *   --command-pattern <re>  A regex the pending command must match. Refused
 *                           when overbroad (must retain >= 12 literal chars
 *                           after stripping regex metacharacters — a `.*`
 *                           grant would authorize ANY command for the TTL).
 *   --tool <name>           Harness tool the grant applies to. Default:
 *                           "Bash" (also: "mcp__minsky__session_exec").
 *   --ttl-minutes <n>       Grant lifetime. Default: 15 — a grant is minted
 *                           for an action about to run, not a standing
 *                           capability.
 *   --reason <note>         Audit justification. Default:
 *                           "approved via ask <askId>".
 *   --issued-by <note>      Free-form audit note for the issuing session.
 *   --dry-run               Preview without writing (also skips the
 *                           server-side verification network call only when
 *                           it fails — the preview still reports the
 *                           verification verdict).
 *
 * Mirrors `scripts/grant-guard-override.ts` (ADR-028 D8) /
 * `scripts/grant-subagent-merge.ts` (D5) — the third instance of the
 * file-based grant-issuance shape.
 *
 * @see mt#2823 — tracking task
 * @see .minsky/hooks/ask-grant-store.ts — grant schema + matching
 * @see .minsky/hooks/ask-permission-bridge.ts — the consuming hook
 */

import {
  appendAskGrant,
  getAskGrantStorePath,
  isOverbroadPattern,
} from "../.minsky/hooks/ask-grant-store";
import type { AskGrant } from "../.minsky/hooks/ask-grant-store";
import { verifyApprovedAsk } from "../.minsky/hooks/ask-verification";

const DEFAULT_TTL_MINUTES = 15;
const DEFAULT_TOOL = "Bash";

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
    'Usage: bun scripts/grant-ask-action.ts --ask <askId> (--command-exact "<cmd>" | ' +
      '--command-pattern "<regex>") [--tool Bash] [--ttl-minutes 15] [--reason "<note>"] ' +
      '[--issued-by "<note>"] [--dry-run]'
  );
}

/** Regex-escape + anchor an exact command string. Exported for testing. */
export function exactCommandPattern(command: string): string {
  return `^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/**
 * Build the AskGrant from parsed CLI args. Returns a string error message on
 * invalid input (usage error), or the grant. Exported for testing.
 */
export function buildGrantFromArgs(
  args: Record<string, string>,
  nowIso: string
): AskGrant | string {
  const askId = args["ask"];
  if (!askId) return "missing required --ask <askId>";

  const exact = args["command-exact"];
  const pattern = args["command-pattern"];
  if (!exact && !pattern) return "one of --command-exact or --command-pattern is required";
  if (exact && pattern) return "--command-exact and --command-pattern are mutually exclusive";

  const commandPattern = exact ? exactCommandPattern(exact) : (pattern as string);
  try {
    new RegExp(commandPattern);
  } catch (err) {
    return `--command-pattern does not compile as a regex: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (isOverbroadPattern(commandPattern)) {
    return (
      "refusing overbroad command pattern: fewer than 12 literal characters remain after " +
      "stripping regex metacharacters. Narrow the pattern to the approved command."
    );
  }

  const ttlMinutesRaw = args["ttl-minutes"];
  const ttlMinutes = ttlMinutesRaw ? Number(ttlMinutesRaw) : DEFAULT_TTL_MINUTES;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return "invalid --ttl-minutes";

  return {
    askId,
    tool: args["tool"] || DEFAULT_TOOL,
    commandPattern,
    issuedAt: nowIso,
    ttlMs: ttlMinutes * 60 * 1000,
    reason: args["reason"] || `approved via ask ${askId}`,
    issuedBy: args["issued-by"],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const grantOrError = buildGrantFromArgs(args, new Date().toISOString());
  if (typeof grantOrError === "string") {
    console.error(`Error: ${grantOrError}`);
    printUsage();
    process.exit(1);
  }
  const grant = grantOrError;

  // Server-side verification at mint time (the bridge re-verifies at
  // decision time — this refusal just fails earlier and clearer).
  const verification = verifyApprovedAsk(grant.askId);
  if (verification.verdict !== "approved") {
    console.error(
      `Refusing to issue grant: ask ${grant.askId} did not verify as operator-approved ` +
        `(${verification.verdict}: ${verification.detail}).`
    );
    process.exit(1);
  }

  const storePath = getAskGrantStorePath();
  const expiresAt = new Date(Date.parse(grant.issuedAt) + grant.ttlMs).toISOString();

  if (args["dry-run"] === "true") {
    console.log(
      `[dry-run] would grant ask-action: ask=${grant.askId} tool=${grant.tool} ` +
        `pattern=${grant.commandPattern} reason="${grant.reason}" expiresAt=${expiresAt} ` +
        `store=${storePath} (verification: ${verification.detail})`
    );
    return;
  }

  appendAskGrant(storePath, grant);
  console.log(
    `Granted ask-action: ask=${grant.askId} tool=${grant.tool} pattern=${grant.commandPattern} ` +
      `reason="${grant.reason}" expiresAt=${expiresAt} one-shot store=${storePath}`
  );
}

if (import.meta.main) {
  await main();
}
