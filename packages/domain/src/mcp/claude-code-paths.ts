/**
 * Where Claude Code keeps its user-scope state file, `.claude.json` (mt#5066).
 *
 * The vendor documents the file at `~/.claude.json` and documents `CLAUDE_CONFIG_DIR`
 * as relocating "every `~/.claude` path" (code.claude.com/docs/en/claude-directory);
 * it does not say in words whether the two compose. The binary answers: measured on
 * Claude Code 2.1.258 (2026-09-11), `CLAUDE_CONFIG_DIR=<empty dir> claude mcp list`
 * CREATED `<dir>/.claude.json` and did not read the operator's user-scope servers from
 * `~/.claude.json`. So when the variable is set, the file Claude Code reads and writes
 * lives INSIDE the config dir, and a registration written to the HOME-root file is one
 * Claude Code never sees.
 *
 * Every Minsky writer of that file resolved it as `homedir()/.claude.json` until this
 * module existed — which is how the cold-agent harness (`scripts/cold-agent-onboarding-run.ts`)
 * could relocate `CLAUDE_CONFIG_DIR` and still have `minsky setup` write the operator's real
 * file: Claude Code had moved, Minsky had not.
 *
 * The sibling for the DIRECTORY is `resolveClaudeSessionsDir`
 * (`../conversation-run-state/claude-code-session-roster.ts`); the rule is the same and
 * the fallback differs — the directory falls back to `~/.claude/`, this file to `~/`.
 *
 * `env`/`home` are injectable with real defaults, evaluated at CALL time, so a fresh
 * read never sees a stale environment.
 */
import { homedir } from "os";
import { join } from "path";

export const CLAUDE_JSON_BASENAME = ".claude.json";

export function resolveClaudeJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const base = configDir && configDir.trim().length > 0 ? configDir : home;
  return join(base, CLAUDE_JSON_BASENAME);
}
