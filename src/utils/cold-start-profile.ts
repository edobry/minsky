/**
 * Cold-start profiling utility for mt#1745.
 *
 * Module-level timer + checkpoint emitter, gated on `MINSKY_MCP_PROFILE=1`.
 * Both `src/cli.ts` and `src/commands/mcp/start-command.ts` consume this so
 * checkpoint `t=` values are comparable across the whole startup path
 * (CLI module load → preAction → action handler → server.start()).
 *
 * Emits `[profile] checkpoint=<name> t=<ms>` lines to stderr. Stdout is
 * reserved for MCP JSON-RPC frames in stdio mode. When the env var is unset
 * (the production path), `profileCheckpoint` is a no-op with zero overhead
 * beyond the env-var read.
 *
 * The benchmark script (`scripts/measure-mcp-start-cold-start.ts`) parses
 * these lines to build a per-stage breakdown.
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
