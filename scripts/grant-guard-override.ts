#!/usr/bin/env bun
/**
 * Mid-session issuance surface for an ADR-028 Phase-7-adjunct guard-override
 * grant (mt#2658).
 *
 * Every guard override today — including the ADR-028 D3 unified
 * `MINSKY_HOOK_OVERRIDE` — is an env var read by the hook subprocess, which
 * inherits the HARNESS env captured at launch. An agent mid-session
 * structurally cannot self-serve any such override for MCP-tool-matched
 * guards: setting the var via a `Bash` call does not propagate to the
 * sibling harness subprocess the guard hook actually runs in. This script
 * is the reachable alternative — it writes a TTL-bound, reason-mandatory
 * grant record to the shared store `.minsky/hooks/guard-grant-store.ts`
 * defines, which `.minsky/hooks/dispatcher.ts`'s `checkOverride()` (and any
 * guard calling it directly, e.g. `parallel-work-guard.ts`'s duplicate-child
 * matcher) consults at decision time.
 *
 * Usage:
 *
 *   bun scripts/grant-guard-override.ts --guard duplicate-child-matcher \
 *     --scope mt#2581 --reason "concurrent decomposition — distinct sibling" \
 *     [--ttl-minutes 30] [--issued-by "<note>"] [--dry-run]
 *
 * Flags:
 *
 *   --guard <name>        Required. The guard name to override (e.g.
 *                          "duplicate-child-matcher", or any name registered
 *                          in `.minsky/hooks/registry.ts`'s `GUARD_REGISTRY`
 *                          for a dispatcher-migrated guard).
 *   --scope <qualifier>   Required. Scope the grant is bound to — e.g. a
 *                          task id. An unscoped grant would silently
 *                          authorize every FUTURE invocation of the guard,
 *                          defeating the audit-and-expire design. NOTE:
 *                          the stored scope is NORMALIZED (`#` stripped,
 *                          lowercased, whitespace trimmed) via
 *                          `guard-grant-store.ts`'s `normalizeScope()` —
 *                          `--scope mt#2581` is stored (and matched) as
 *                          `mt2581`. This matches the same normalization
 *                          `checkOverride()`'s grant lookup applies to the
 *                          guard's own scope value at match time, so a
 *                          `#`-vs-no-`#` mismatch between issuance and
 *                          lookup never causes a false miss — but the
 *                          success/dry-run output below echoes the stored
 *                          (normalized) value, which will look different
 *                          from what you typed.
 *   --reason <note>       Required. Human-readable justification. Every
 *                          issuance is necessarily an audit record — this
 *                          preserves the deliberate-friction property env
 *                          vars accidentally provided.
 *   --ttl-minutes <n>     Optional. Grant lifetime in minutes. Default: 30
 *                          (order of a typical bounded session action, per
 *                          mt#2651's D5 precedent for merge-capability
 *                          grants).
 *   --issued-by <note>    Optional. Free-form audit note identifying the
 *                          issuing agent/session.
 *   --dry-run              Preview the grant that would be written without
 *                          writing it.
 *
 * This is deliberately a lightweight CLI script rather than a new MCP tool
 * — mirrors `scripts/grant-subagent-merge.ts`'s shape exactly (mt#2651's
 * precedent for "whatever is cheapest that an agent/orchestrator can
 * invoke mid-session"). See
 * `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` §D8
 * for the design rationale, and `.minsky/hooks/guard-grant-store.ts` for the
 * grant schema + matching logic this script writes to.
 *
 * @see mt#2658 — this script's tracking task
 */

import {
  appendGuardGrant,
  getGuardGrantStorePath,
  normalizeGuardName,
  normalizeScope,
} from "../.minsky/hooks/guard-grant-store";
import type { GuardGrant } from "../.minsky/hooks/guard-grant-store";

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
    "Usage: bun scripts/grant-guard-override.ts --guard <name> --scope <qualifier> " +
      '--reason "<note>" [--ttl-minutes 30] [--issued-by <note>] [--dry-run]'
  );
}

/**
 * Build the GuardGrant record from parsed CLI args. Exported for testing.
 * `--guard`, `--scope`, and `--reason` are all required — a grant without
 * any one of them would either be unmatchable (missing guard/scope) or
 * silently un-auditable (missing reason), so this returns `null` (a usage
 * error) rather than a partially-formed grant.
 */
export function buildGrantFromArgs(
  args: Record<string, string>,
  nowIso: string
): GuardGrant | null {
  const guardName = args["guard"];
  const scope = args["scope"];
  const reason = args["reason"];
  if (!guardName || !scope || !reason) return null;

  const ttlMinutesRaw = args["ttl-minutes"];
  const ttlMinutes = ttlMinutesRaw ? Number(ttlMinutesRaw) : DEFAULT_TTL_MINUTES;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return null;

  return {
    guardName: normalizeGuardName(guardName),
    scope: normalizeScope(scope),
    issuedAt: nowIso,
    ttlMs: ttlMinutes * 60 * 1000,
    issuedBy: args["issued-by"],
    reason,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const grant = buildGrantFromArgs(args, new Date().toISOString());
  if (!grant) {
    printUsage();
    process.exit(1);
  }

  const storePath = getGuardGrantStorePath();
  const expiresAt = new Date(Date.parse(grant.issuedAt) + grant.ttlMs).toISOString();
  // Echo raw + normalized scope so an operator who typed `--scope mt#2581`
  // isn't surprised the stored/matched value is `mt2581` (normalizeScope
  // strips `#`, lowercases, trims whitespace — see the --scope flag doc
  // above and guard-grant-store.ts's normalizeScope()).
  const rawScope = args["scope"] ?? grant.scope;
  const scopePart =
    rawScope === grant.scope ? grant.scope : `${grant.scope} (normalized from "${rawScope}")`;

  if (args["dry-run"] === "true") {
    console.log(
      `[dry-run] would grant guard override: guard=${grant.guardName} scope=${scopePart} ` +
        `reason="${grant.reason}" issuedAt=${grant.issuedAt} expiresAt=${expiresAt} store=${storePath}`
    );
    return;
  }

  appendGuardGrant(storePath, grant);
  console.log(
    `Granted guard override: guard=${grant.guardName} scope=${scopePart} ` +
      `reason="${grant.reason}" expiresAt=${expiresAt} store=${storePath}`
  );
}

if (import.meta.main) {
  await main();
}
