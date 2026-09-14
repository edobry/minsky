/**
 * Agent harness detection.
 *
 * Minsky is agent-harness-independent: it detects which runtime it's
 * operating in and adapts behavior accordingly. Native subagent capacity
 * is used when available; Minsky's own loop is the fallback.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import { parseAgentId } from "../agent-identity/format";
import { KNOWN_KINDS } from "../agent-identity/kinds";

export type AgentHarness = "claude-code" | "cursor" | "standalone";

/**
 * The set of MCP client applications that Minsky can register itself with.
 * Extend this union as new clients are implemented.
 *
 * `openhands` is included for the `--client openhands` registration code path
 * but is intentionally excluded from `detectInstalledClients()` auto-detection
 * (no reliable filesystem signature; it's an agent framework rather than a
 * user-installed app). Callers must opt in explicitly.
 *
 * `claude-code` (mt#4676) is registered at USER scope — the top-level
 * `mcpServers` key of `.claude.json`, which lives at `~/.claude.json` or, when
 * `CLAUDE_CONFIG_DIR` is set, at `$CLAUDE_CONFIG_DIR/.claude.json` (mt#5066) —
 * not per-project; see `ClaudeCodeRegistrar` in `../mcp/registration.ts` for why.
 */
export type ManagedClient =
  | "cursor"
  | "claude-desktop"
  | "claude-code"
  | "vscode"
  | "windsurf"
  | "junie"
  | "codex"
  | "openhands";

/**
 * The `ManagedClient` union as a runtime list — the accepted values of
 * `--client` on `init`, `setup` and `mcp register`, and what a refusal names
 * when nothing resolved (mt#5153). Kept beside the type so the two cannot
 * drift: `isManagedClient` is the only runtime check, and the CLI/MCP schemas
 * enumerate from this list.
 */
export const MANAGED_CLIENTS: readonly ManagedClient[] = [
  "cursor",
  "claude-desktop",
  "claude-code",
  "vscode",
  "windsurf",
  "junie",
  "codex",
  "openhands",
];

export function isManagedClient(value: unknown): value is ManagedClient {
  return typeof value === "string" && (MANAGED_CLIENTS as readonly string[]).includes(value);
}

/**
 * Detect the current agent harness from environment signals.
 *
 * Claude Code 2.1.x sets `CLAUDECODE=1` (no underscore) plus a family of
 * `CLAUDE_CODE_*`-namespaced vars (`CLAUDE_CODE_ENTRYPOINT`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`). It does NOT set bare
 * `CLAUDE_CODE`. Hook contexts additionally set `CLAUDE_PROJECT_DIR`. We
 * accept any of these signals to recognize Claude Code regardless of which
 * surface the MCP server was launched under.
 *
 * `CLAUDE_CODE_SUBAGENT_MODEL` is also accepted below, but do NOT count it as
 * a harness signal (mt#3151): it was listed here as one because this repo's
 * own `.claude/settings.json` set it, so its presence was self-inflicted —
 * the check was reading our config, not detecting Claude Code. That pin was
 * removed, and whether the harness sets the variable on its own is not
 * established either way; the first session after the removal settles it. The
 * accepted-signal list keeps it because it costs nothing (any one of the
 * signals above already identifies the harness) and dropping it is a separate
 * cleanup, but nothing should rely on it.
 *
 * Detection priority:
 * 1. Any Claude Code env signal → Claude Code
 * 2. CURSOR_* env vars or VS Code fork context → Cursor
 * 3. Neither → standalone / unknown
 */
export function detectAgentHarness(): AgentHarness {
  if (
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
    process.env.CLAUDE_CODE_EXECPATH ||
    process.env.CLAUDE_PROJECT_DIR ||
    // Legacy variant accepted for backward compatibility — never observed in
    // the wild but kept in case future Claude Code versions or third-party
    // shims set it.
    process.env.CLAUDE_CODE
  ) {
    return "claude-code";
  }

  // Cursor sets CURSOR_SESSION_ID / CURSOR_TRACE_ID; both Cursor and stock VS
  // Code set VSCODE_PID (Cursor is a VS Code fork). Treating VSCODE_PID alone
  // as "cursor" is intentional — for our purposes (native subagent support
  // detection at hasNativeSubagentSupport() and downstream prompt-generation
  // dispatch), VS Code and Cursor are equivalent: neither has native subagent
  // support yet, so both fall through to the standalone-style fat-prompt path.
  // If future native-subagent support diverges between the two, split this
  // branch and rename the harness label.
  if (process.env.CURSOR_SESSION_ID || process.env.CURSOR_TRACE_ID || process.env.VSCODE_PID) {
    return "cursor";
  }

  return "standalone";
}

/**
 * Whether a harness supports native subagent dispatch.
 * When true, Minsky returns prompts for the harness to dispatch.
 * When false, Minsky would need its own agent loop (not yet implemented).
 *
 * Takes the harness as a parameter (mt#5153) so a caller that resolved it from
 * the MCP client's identity (`resolveAgentHarness`) asks about THAT harness,
 * not about the serving process's environment. The default keeps the CLI
 * path's behaviour: a child of the harness reads its own environment.
 */
export function hasNativeSubagentSupport(harness: AgentHarness = detectAgentHarness()): boolean {
  return harness === "claude-code"; // Cursor support TBD
}

/**
 * Map an ADR-006 agent id to the `ManagedClient` it was issued by, or `null`
 * when the id's kind names no client Minsky registers with (mt#5153).
 *
 * The kind is the reverse-domain prefix ADR-006 Layer 1 derives from the MCP
 * `clientInfo.name` at `initialize` (`KNOWN_KINDS`), and Layer 3 carries the
 * same kind on the conversation-scoped id the shim stamps. A native subagent
 * (`minsky.native-subagent:run:…@<parent>`, `tasks.dispatch`) is dispatched by its parent's
 * harness, so the walk continues into the parent id.
 *
 * Only kinds ADR-006 recorded are mapped. `com.anthropic.claude-code` is the
 * one empirically captured (Claude Code 2.1.117); `com.cursor.cursor` and
 * `com.openai.codex` are the documented conventions. Anything else — including
 * the `unknown` kind an unrecognised `clientInfo.name` produces — is `null`,
 * which callers treat as "no signal", never as a guess: an unverified name
 * degrading to the honest no-signal path is the whole point of returning
 * `null` here rather than a default.
 */
export function clientFromAgentId(agentId: string | null | undefined): ManagedClient | null {
  let current = agentId ?? null;
  // A parent chain is bounded in practice (one level: subagent → harness), but a
  // malformed id could name itself; cap the walk so a bad input cannot loop.
  for (let depth = 0; current !== null && depth < 4; depth += 1) {
    const parsed = parseAgentId(current);
    if (parsed === null) return null;
    switch (parsed.kind) {
      case KNOWN_KINDS.CLAUDE_CODE:
        return "claude-code";
      case KNOWN_KINDS.CURSOR:
        return "cursor";
      case KNOWN_KINDS.CODEX:
        return "codex";
      case KNOWN_KINDS.MINSKY_NATIVE_SUBAGENT:
        current = parsed.parent ?? null;
        continue;
      default:
        return null;
    }
  }
  return null;
}

/**
 * The harness a caller is running under, for dispatch decisions (mt#5153,
 * closing mt#4510's detection half).
 *
 * On the MCP path the caller's identity is the witness: a tool call executes
 * inside the shared local daemon (ADR-038), whose `process.env` is whatever the
 * daemon's SPAWNER had — nothing, on 2026-08-24 and 2026-09-03, which read as
 * `standalone` for Claude Code callers; `CLAUDECODE=1`, on 2026-09-14, from a
 * tray relaunched out of an agent's Bash, which would read as `claude-code` for
 * a Cursor caller. `detectAgentHarness()` answers about the spawner there, so
 * it is not consulted when a caller id is present. On the CLI path there is no
 * caller id and the process IS the harness's child, so the environment is
 * exactly right.
 */
export function resolveAgentHarness(input: { callerAgentId?: string | null } = {}): AgentHarness {
  if (input.callerAgentId) {
    const client = clientFromAgentId(input.callerAgentId);
    if (client === "claude-code") return "claude-code";
    if (client === "cursor") return "cursor";
    return "standalone";
  }
  return detectAgentHarness();
}

/**
 * How `init`/`setup` arrived at the harness they recorded (mt#5153), written
 * beside `workspace.harness` in `.minsky/config.local.yaml` as
 * `workspace.harnessSource` so `config doctor` (mt#5154) can tell a chosen
 * value from a defaulted one. A file with no `harnessSource` predates this.
 */
export type HarnessSource = "flag" | "env" | "mcp-client" | "installed";

export const HARNESS_SOURCES: readonly HarnessSource[] = ["flag", "env", "mcp-client", "installed"];

/** Operator-facing phrase for each source, used in the notice `init` emits. */
export function describeHarnessSource(source: HarnessSource): string {
  switch (source) {
    case "flag":
      return "from --client";
    case "env":
      return "detected from this process's environment";
    case "mcp-client":
      return "from the MCP client that made this call";
    case "installed":
      return "the only MCP client installed on this machine";
  }
}

export interface ResolveInitClientInput {
  /** `--client` / the MCP `client` parameter. Outranks every detected signal. */
  explicit?: ManagedClient;
  /**
   * The caller's server-injected ADR-006 agent id (`callerActorId`). Present
   * on the MCP path only — its presence is what selects the identity witness
   * over the environment one, so pass it whenever the server supplied it, even
   * when its kind turns out to be unmapped.
   */
  callerAgentId?: string | null;
  /** `detectAgentHarness()` — consulted on the CLI path only. */
  harness?: AgentHarness;
  /** `detectInstalledClients()` — the last resort, and only unambiguous alone. */
  installedClients?: ManagedClient[];
}

export type InitClientResolution =
  | { kind: "resolved"; client: ManagedClient; source: HarnessSource }
  /** No signal, and more than one client installed — a ranked pick would be a guess. */
  | { kind: "ambiguous"; installed: ManagedClient[] }
  /** No signal, and nothing installed that Minsky can register with. */
  | { kind: "none" };

/**
 * Resolve which MCP client `minsky init` / `minsky setup` should register with
 * and record as this workspace's `harness` (mt#4676, redone in mt#5153).
 *
 * Three signal classes, in precedence order:
 *
 *   1. An explicit `--client`.
 *   2. The caller's identity, on the MCP path (`callerAgentId` present) — see
 *      `clientFromAgentId`. When the id is present but its kind is unmapped, the
 *      environment is still NOT consulted: on this path it describes the
 *      daemon's spawner, not the caller (`resolveAgentHarness`).
 *   3. The environment, on the CLI path (no `callerAgentId`) — the process is a
 *      child of the harness that ran it.
 *
 * Installed-ness is not a signal. With no signal and exactly ONE client
 * installed, that client is the answer, as `setup` has always treated it. With
 * two or more, the result is `ambiguous` and the caller prompts (TTY) or fails
 * naming the accepted values (non-interactive); with none it is `none`. This
 * function never picks by ranking: the previous version's
 * `STANDALONE_CLIENT_PRIORITY` put `cursor` first "to preserve the pre-mt#4676
 * default", and on a machine with five clients installed that wrote a silent
 * `harness: cursor` for every no-signal run — the flowtato onboarding
 * (mt#5152), twice. A default that always produces a value is how the
 * no-signal case never surfaced.
 *
 * Every input defaults to the real detector so production callers pass only
 * what they hold; tests pass all four to pin the precedence without touching
 * `process.env` or the filesystem.
 */
export function resolveInitClient(input: ResolveInitClientInput = {}): InitClientResolution {
  if (input.explicit !== undefined) {
    return { kind: "resolved", client: input.explicit, source: "flag" };
  }

  if (input.callerAgentId) {
    const fromCaller = clientFromAgentId(input.callerAgentId);
    if (fromCaller !== null) return { kind: "resolved", client: fromCaller, source: "mcp-client" };
  } else {
    const harness = input.harness ?? detectAgentHarness();
    if (harness === "claude-code")
      return { kind: "resolved", client: "claude-code", source: "env" };
    if (harness === "cursor") return { kind: "resolved", client: "cursor", source: "env" };
  }

  const installed = input.installedClients ?? detectInstalledClients();
  const [only, second] = installed;
  if (only !== undefined && second === undefined) {
    return { kind: "resolved", client: only, source: "installed" };
  }
  if (only === undefined) return { kind: "none" };
  return { kind: "ambiguous", installed: [...installed] };
}

/**
 * The refusal an unresolved client produces on a non-interactive path — the
 * one message `init` and `setup` share, so the two commands cannot drift on
 * the question they used to answer differently (mt#5153).
 *
 * @param resolution An `ambiguous` or `none` result.
 * @param flag The flag the caller accepts, e.g. `--client`.
 * @param witness Which signal was consulted and came back empty — the MCP
 *   caller's identity (`mcp-client`, with the id so the operator can see what
 *   the daemon saw) or the CLI environment (`env`). The two are different
 *   facts and the remedy differs: an unrecognised client is not a missing env
 *   var.
 */
export function describeUnresolvedClient(
  resolution: Exclude<InitClientResolution, { kind: "resolved" }>,
  flag: string,
  witness: { kind: "env" } | { kind: "mcp-client"; agentId: string } = { kind: "env" }
): string {
  const accepted = `Accepted values: ${MANAGED_CLIENTS.join(", ")}.`;
  const noSignal =
    witness.kind === "mcp-client"
      ? `the MCP client making this call (${witness.agentId}) is not one Minsky recognises`
      : "no harness signal in the environment";
  if (resolution.kind === "ambiguous") {
    return (
      `Could not tell which agent harness this project is for: ${noSignal}, and ` +
      `${resolution.installed.length} MCP clients are installed ` +
      `(${resolution.installed.join(", ")}). Pass ${flag} to choose one. ${accepted}`
    );
  }
  return (
    `Could not tell which agent harness this project is for: ${noSignal}, and no known ` +
    `MCP client is installed on this machine. Pass ${flag} to choose one. ${accepted}`
  );
}

/**
 * Injectable dependency for `detectInstalledClients()` — lets tests supply a
 * deterministic path-existence check instead of probing the real filesystem
 * (per `testing-standards.mdc §Testable Design`: inject the collaborator
 * rather than patching `fs.existsSync` in place).
 */
export interface DetectInstalledClientsDeps {
  /** Returns whether a filesystem path exists. Defaults to `fs.existsSync`. */
  pathExists?: (path: string) => boolean;
}

/**
 * Probe the filesystem for installed MCP client applications.
 * Only returns clients that are actually present on this machine.
 *
 * Detection heuristics:
 * - cursor: ~/.cursor/ directory exists
 * - claude-desktop: config directory exists (platform-specific)
 * - claude-code: ~/.claude/ directory exists (created on first run; holds
 *   settings, credentials, conversation history — same signature class as
 *   cursor's ~/.cursor/)
 * - vscode: TODO
 */
export function detectInstalledClients(deps: DetectInstalledClientsDeps = {}): ManagedClient[] {
  const pathExists = deps.pathExists ?? existsSync;
  const clients: ManagedClient[] = [];

  // Cursor: check for ~/.cursor/ directory
  if (pathExists(path.join(homedir(), ".cursor"))) {
    clients.push("cursor");
  }

  // Claude Code: check for ~/.claude/ directory
  if (pathExists(path.join(homedir(), ".claude"))) {
    clients.push("claude-code");
  }

  // Claude Desktop: check for platform-specific config directory
  const home = homedir();
  let claudeConfigDir: string;
  if (process.platform === "darwin") {
    claudeConfigDir = path.join(home, "Library", "Application Support", "Claude");
  } else if (process.platform === "win32") {
    claudeConfigDir = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Claude"
    );
  } else {
    claudeConfigDir = path.join(home, ".config", "Claude");
  }
  if (pathExists(claudeConfigDir)) {
    clients.push("claude-desktop");
  }

  // VS Code: check for ~/.vscode/ directory
  if (pathExists(path.join(homedir(), ".vscode"))) {
    clients.push("vscode");
  }

  // Windsurf: check for ~/.codeium/ directory
  if (pathExists(path.join(homedir(), ".codeium"))) {
    clients.push("windsurf");
  }

  // Junie (JetBrains): check for ~/.junie/ directory (created by Junie CLI)
  if (pathExists(path.join(homedir(), ".junie"))) {
    clients.push("junie");
  }

  // Codex: check for ~/.codex/ directory
  if (pathExists(path.join(homedir(), ".codex"))) {
    clients.push("codex");
  }

  // OpenHands: skip auto-detection — use --client openhands explicitly
  // OpenHands is an agent framework, not typically installed as a user app.

  return clients;
}
