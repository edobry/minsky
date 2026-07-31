/**
 * Cold-start profiling utility (mt#1745; moved to @minsky/shared by mt#2973).
 *
 * Module-level timer + checkpoint emitter, gated on `MINSKY_MCP_PROFILE=1`.
 * `src/cli.ts`, `src/commands/mcp/start-command.ts`, and the persistence layer
 * (`packages/domain/src/persistence/**`) all consume this so checkpoint `t=`
 * values are comparable across the whole startup path (CLI module load →
 * preAction → container.initialize → persistence connect → action handler).
 *
 * It lives in `@minsky/shared` (not `src/utils/`) specifically so the
 * domain/persistence layer can import it WITHOUT depending on the app `src/`
 * layer (a clean-architecture violation). `src/utils/cold-start-profile.ts`
 * re-exports from here for the two pre-existing app-layer importers, preserving
 * the module-singleton timer so both layers share ONE `PROFILE_START_MS`
 * origin.
 *
 * Emits `[profile] checkpoint=<name> t=<ms>` lines to stderr. Stdout is
 * reserved for MCP JSON-RPC frames in stdio mode. When the env var is unset
 * (the production path), `profileCheckpoint` is a no-op with zero overhead
 * beyond the env-var read.
 *
 * The benchmark scripts (`scripts/measure-mcp-start-cold-start.ts`,
 * `scripts/benchmark-cold-boot.ts`) parse these lines to build a per-stage
 * breakdown.
 */

const PROFILE_START_MS = performance.now();
const PROFILE_ENABLED = process.env.MINSKY_MCP_PROFILE === "1";

export function profileCheckpoint(name: string): void {
  if (!PROFILE_ENABLED) return;
  const t = (performance.now() - PROFILE_START_MS).toFixed(2);
  process.stderr.write(`[profile] checkpoint=${name} t=${t}\n`);
}

export function isProfileEnabled(): boolean {
  return PROFILE_ENABLED;
}
