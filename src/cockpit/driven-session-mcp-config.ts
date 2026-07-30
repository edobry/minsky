/**
 * MCP configuration for driven sessions (mt#3377).
 *
 * ## Why this module exists
 *
 * A driven session is a genuine `claude` binary spawned with `cwd` set to a
 * Minsky WORKSPACE (a session clone), not to the operator's main checkout.
 * Claude Code resolves MCP servers per-project: local scope (`~/.claude.json`
 * under the project's path) and project scope (`.mcp.json` in the project
 * root) both load "current project only"
 * (https://code.claude.com/docs/en/mcp). This repo declares its servers in a
 * gitignored, untracked `.mcp.json` at the main checkout, so a session clone
 * inherits NONE of them — and there is no user-scope block to fall back on.
 *
 * The observed consequence (2026-07-30): driven sessions booted with zero MCP
 * servers. Every `mcp__minsky__*` tool was absent, `ToolSearch` returned "No
 * matching deferred tools found", and the agent degraded to shelling out to
 * the `minsky` CLI — bypassing the guard and hook wiring the MCP tools carry.
 *
 * ## Why `--mcp-config` and not a seeded `.mcp.json`
 *
 * Seeding a `.mcp.json` into the session clone cannot work: "For security
 * reasons, Claude Code prompts for approval before using project-scoped
 * servers from `.mcp.json` files", and a fresh clone cannot approve its own —
 * "`enableAllProjectMcpServers` or `enabledMcpjsonServers` committed to the
 * project's `.claude/settings.json` is ignored in an untrusted folder, and the
 * server stays at `Pending approval`". A headless child never sees the trust
 * dialog, so the server would never connect.
 *
 * `--mcp-config` is the vendor-canonical shape for a HOST provisioning servers
 * into a session it controls: Claude Code on the web "connectors are
 * provisioned by the remote host and arrive as explicit `--mcp-config`
 * entries". It accepts "JSON files or strings", and `--strict-mcp-config`
 * means "Only use MCP servers from `--mcp-config`, ignoring all other MCP
 * configurations" (https://code.claude.com/docs/en/cli-reference) — which is
 * what makes the driven session's tool surface DETERMINISTIC rather than a
 * function of whichever claude.ai connectors and plugins the operator happens
 * to have configured.
 *
 * ## Invariant
 *
 * Like `driven-session-host.ts`, this module imports no domain code. It
 * synthesizes a config from process-level facts only, so the host can build
 * spawn argv without reaching into the domain layer.
 */

/** The single server name a driven session is provisioned with. */
export const DRIVEN_SESSION_MCP_SERVER_NAME = "minsky";

/**
 * How to invoke this Minsky build as a subprocess.
 *
 * A driven session's MCP server must be the SAME Minsky build that is running
 * the cockpit daemon — otherwise the child talks to whatever happens to be on
 * `PATH`, which for a tray-launched GUI process is frequently a minimal PATH
 * that does not include `~/.bun/bin` at all (the `minsky`-ENOENT shape).
 */
export interface MinskyInvocation {
  readonly command: string;
  /** Args that must PRECEDE the minsky subcommand (e.g. the script path under bun). */
  readonly prefixArgs: readonly string[];
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Resolve how to re-invoke this Minsky build.
 *
 * Three shapes, in order:
 *
 * 1. **Compiled binary** — the running executable IS `minsky` (the installed
 *    CLI, the shape the tray ships). Re-invoke it directly.
 * 2. **Dev / `bun run src/cli.ts`** — the executable is the bun runtime and
 *    `argv[1]` is the entry script. Re-invoke bun with that script.
 * 3. **Neither recognizable** — fall back to bare `"minsky"` and let `PATH`
 *    resolve it. This is the only branch that can fail on a minimal PATH; it
 *    exists so an unrecognized host shape degrades to today's behavior rather
 *    than throwing at spawn time.
 *
 * Reads the executable from `argv[0]` rather than `process.execPath`: this
 * project's ambient `process` type is a narrowed shim that does not declare
 * `execPath`, and `argv[0]` carries the same value.
 *
 * The parameter is injectable for tests; production passes nothing.
 */
export function resolveMinskyInvocation(argv: readonly string[] = process.argv): MinskyInvocation {
  const executable = argv[0];
  if (!executable) {
    return { command: "minsky", prefixArgs: [] };
  }

  if (basename(executable) === "minsky") {
    return { command: executable, prefixArgs: [] };
  }

  const entry = argv[1];
  if (entry && /(^|\/)(cli|index)\.(ts|js)$/.test(entry)) {
    return { command: executable, prefixArgs: [entry] };
  }

  return { command: "minsky", prefixArgs: [] };
}

/**
 * The MCP config a driven session is launched with, as an inline JSON string
 * suitable for `--mcp-config`.
 *
 * `repoPath` becomes the server's `--repo`, so the driven session's
 * repo-scoped tools resolve against the workspace the agent is actually
 * working in rather than the operator's main checkout. Pass the same value
 * used as the child's `cwd`.
 *
 * Only the `minsky` server is provisioned. The operator's other servers
 * (`github`, `supabase`, `chrome-devtools`) carry their own credential paths —
 * the `github` entry shells out to `gh auth token` — so granting them to an
 * autonomous child is a separate, deliberate decision rather than a default.
 */
export function buildDrivenSessionMcpConfig(
  repoPath: string,
  invocation: MinskyInvocation = resolveMinskyInvocation()
): string {
  return JSON.stringify({
    mcpServers: {
      [DRIVEN_SESSION_MCP_SERVER_NAME]: {
        command: invocation.command,
        args: [...invocation.prefixArgs, "mcp", "start", "--repo", repoPath],
      },
    },
  });
}

/**
 * The spawn-argv fragment that provisions the config.
 *
 * `--strict-mcp-config` is not optional decoration: without it the child also
 * loads the operator's ambient claude.ai connectors and plugin servers, so the
 * driven session's tool surface would vary per machine and per operator
 * settings change. With it, the surface is exactly what this module declares.
 */
export function mcpConfigArgs(mcpConfig: string | null | undefined): string[] {
  if (!mcpConfig) return [];
  return ["--mcp-config", mcpConfig, "--strict-mcp-config"];
}
