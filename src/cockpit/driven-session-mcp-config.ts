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
 * Like `driven-session-host.ts`, this module imports no domain code — only
 * `node:fs`. It builds a config from process-level and filesystem facts, so the
 * host can build spawn argv without reaching into the domain layer.
 *
 * That is why the mt#4239 additions below RETURN their rejections instead of
 * logging them: a logger would be the first import to erode the invariant, and
 * returning the list keeps the selection logic testable without a logger or a
 * spawned process. The caller owns reporting.
 */
import { readFileSync } from "node:fs";

/**
 * The server name that is always present and always SYNTHESIZED.
 *
 * mt#3377 provisioned this and nothing else. As of mt#4239 other servers may be
 * INHERITED alongside it (see {@link resolveDrivenSessionMcpConfig}) — but this
 * one is never inherited, because its `command` must point at the running build
 * and its `--repo` at the session's own workspace.
 */
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
 * `inheritedServers` carries entries copied verbatim out of the operator's
 * `.mcp.json` (see {@link selectInheritableServers}). The `minsky` entry is
 * written LAST and therefore always wins: it must point at the RUNNING build
 * and at this session's repo path, neither of which any file on disk knows, so
 * an inherited entry under the same name must never shadow it. `mt#3377`
 * provisioned only this one server; `mt#4239` made the rest configurable.
 */
export function buildDrivenSessionMcpConfig(
  repoPath: string,
  invocation: MinskyInvocation = resolveMinskyInvocation(),
  inheritedServers: Readonly<Record<string, unknown>> = {}
): string {
  return JSON.stringify({
    mcpServers: {
      ...inheritedServers,
      [DRIVEN_SESSION_MCP_SERVER_NAME]: {
        command: invocation.command,
        args: [...invocation.prefixArgs, "mcp", "start", "--repo", repoPath],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Inheriting the operator's other servers (mt#4239)
// ---------------------------------------------------------------------------

/** Default server set when configuration declares none. */
export const DEFAULT_DRIVEN_SESSION_MCP_SERVERS: readonly string[] = ["minsky", "github"];

/** One server this build declined to provision, and why. The caller logs these. */
export interface RejectedMcpServer {
  readonly name: string;
  readonly reason: string;
}

/** What {@link readOperatorMcpServers} found, plus why it found nothing. */
export interface OperatorMcpServers {
  readonly servers: Readonly<Record<string, unknown>>;
  /** Set when the source could not be read or parsed. Null on success. */
  readonly error: string | null;
}

/**
 * Read the operator's declared MCP servers from a `.mcp.json`.
 *
 * **Reads the DAEMON's checkout, not the driven session's `cwd`** — the two are
 * different directories and only one of them has the file. `.mcp.json` is
 * gitignored (mem#772), so a session-workspace clone never contains one; the
 * cockpit daemon runs from the main checkout, which does. Passing the session's
 * `repoPath` here would silently resolve nothing and hand every driven session
 * the bare `minsky` entry again — the exact pre-mt#4239 behavior, with no error
 * to notice.
 *
 * Never throws: a missing or malformed file yields an empty set plus a reason,
 * so the caller can log it and still spawn a working session with `minsky`.
 * Degrading to fewer tools is survivable; failing to spawn is not.
 */
export function readOperatorMcpServers(sourcePath: string): OperatorMcpServers {
  let raw: string;
  try {
    // `String(...)` rather than relying on the encoding argument to narrow:
    // this project ships a narrowed ambient `node:fs` (`src/types/node.d.ts:25`)
    // declaring ONE overload that returns `string | Buffer` regardless of
    // options, so no argument makes it a `string`. Same class of narrowing as
    // the `process.execPath` note above. Matches the house idiom in
    // `src/utils/test-utils/command-source-scan.ts` and `src/utils/tsgo-binary.ts`.
    raw = String(readFileSync(sourcePath, "utf-8"));
  } catch (err: unknown) {
    return {
      servers: {},
      error: `could not read ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return { servers: parsed.mcpServers ?? {}, error: null };
  } catch (err: unknown) {
    return {
      servers: {},
      error: `could not parse ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Is this entry a LOCAL command server — the only kind a driven session can use?
 *
 * Tests for `command` POSITIVELY rather than enumerating the remote transport
 * types (`http` / `sse` / `ws`). That direction is deliberate: a transport this
 * code has never heard of is refused by default rather than provisioned by
 * default, and the failure mode of over-refusing (a missing tool, logged) is far
 * cheaper than the failure mode of over-accepting (see the caller's docs — up to
 * `MCP_TIMEOUT` of dead first-turn latency on every single spawn).
 */
function isLocalCommandServer(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const command = (entry as Record<string, unknown>)["command"];
  return typeof command === "string" && command.length > 0;
}

/**
 * Pick the inheritable entries for `names` out of `available`.
 *
 * Two names never make it into the payload, for different reasons:
 *
 * - **`minsky`** — skipped silently, because it is SYNTHESIZED rather than
 *   inherited ({@link buildDrivenSessionMcpConfig}). Listing it in config is
 *   correct and idiomatic; it just isn't a lookup.
 * - **A remote server** — rejected WITH a reason. A headless `claude -p` child
 *   cannot complete an OAuth flow: verified live against `claude` 2.1.226, where
 *   a `--strict-mcp-config` payload carrying the Notion connector answered *"the
 *   `notion` MCP server requires authentication, which can't be completed in
 *   this non-interactive session"*. Vendor-documented at
 *   code.claude.com/docs/en/mcp. Emitting it anyway would cost up to
 *   `MCP_TIMEOUT` (30s by default) of first-turn latency per spawn — the vendor's
 *   own `--mcp-config` docs say `-p` waits for pending servers before the first
 *   turn — and still deliver no tools. On a surface where the principal is
 *   waiting on a phone, that is the worst available trade.
 */
export function selectInheritableServers(
  names: readonly string[],
  available: Readonly<Record<string, unknown>>
): { servers: Record<string, unknown>; rejected: RejectedMcpServer[] } {
  const servers: Record<string, unknown> = {};
  const rejected: RejectedMcpServer[] = [];

  for (const name of names) {
    if (name === DRIVEN_SESSION_MCP_SERVER_NAME) continue;

    const entry = available[name];
    if (entry === undefined) {
      rejected.push({ name, reason: "not declared in the operator's .mcp.json" });
      continue;
    }
    if (!isLocalCommandServer(entry)) {
      rejected.push({
        name,
        reason:
          "remote server (no `command`) — a headless driven session cannot complete its OAuth flow",
      });
      continue;
    }
    servers[name] = entry;
  }

  return { servers, rejected };
}

/** The full outcome of resolving a driven session's MCP config. */
export interface DrivenSessionMcpResolution {
  /** The `--mcp-config` payload. */
  readonly config: string;
  /** Server names actually in the payload, `minsky` included. */
  readonly serverNames: readonly string[];
  /** Names asked for and not provisioned. The caller logs these. */
  readonly rejected: readonly RejectedMcpServer[];
  /** Set when the source file could not be read; null otherwise. */
  readonly sourceError: string | null;
}

/**
 * Resolve the whole `--mcp-config` payload for one driven session (mt#4239).
 *
 * Returns the rejections rather than logging them, keeping this module free of
 * every import but `node:fs` — the same no-domain-imports invariant the module
 * docblock states, and what lets the selection logic be tested without a logger
 * or a spawned process.
 */
export function resolveDrivenSessionMcpConfig(
  repoPath: string,
  opts: {
    readonly names?: readonly string[];
    /** Directory holding the operator's `.mcp.json`. Defaults to the daemon's cwd. */
    readonly sourceDir?: string;
    readonly invocation?: MinskyInvocation;
    /**
     * How to read the source. Defaults to {@link readOperatorMcpServers}.
     *
     * Injected rather than reached for, so the resolution logic is testable
     * without touching a real filesystem — `custom/no-real-fs-in-tests` forbids
     * that in tests, and it is right to: a shared temp path is a race between
     * concurrent test files. Per `testing-standards.mdc §Testable Design`,
     * pushing the side effect to an injectable edge beats mocking the module.
     */
    readonly readServers?: (sourcePath: string) => OperatorMcpServers;
  } = {}
): DrivenSessionMcpResolution {
  const names = opts.names ?? DEFAULT_DRIVEN_SESSION_MCP_SERVERS;
  const sourceDir = opts.sourceDir ?? process.cwd();
  const readServers = opts.readServers ?? readOperatorMcpServers;

  const { servers: available, error: sourceError } = readServers(`${sourceDir}/.mcp.json`);
  const { servers, rejected } = selectInheritableServers(names, available);
  const config = buildDrivenSessionMcpConfig(
    repoPath,
    opts.invocation ?? resolveMinskyInvocation(),
    servers
  );

  return {
    config,
    serverNames: [...Object.keys(servers), DRIVEN_SESSION_MCP_SERVER_NAME],
    rejected,
    sourceError,
  };
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

/**
 * Render spawn argv for a log line with the `--mcp-config` payload collapsed.
 *
 * The config is an inline JSON blob carrying absolute local paths, and the
 * spawn log fires on every start AND every resume — logging it verbatim bloats
 * the daemon log and writes machine-local paths into it for no diagnostic gain.
 *
 * What a reader actually needs from that log line is which servers the child
 * was given, so the value collapses to `<config: minsky>` rather than being
 * dropped: flag presence stays visible (the thing you check when a driven
 * session has no tools), and the server set stays greppable. Falls back to
 * `<config: unparseable>` rather than echoing a malformed payload.
 */
export function redactMcpConfigForLog(argv: readonly string[]): string {
  const rendered: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    rendered.push(arg);

    if (arg === "--mcp-config" && i + 1 < argv.length) {
      rendered.push(summarizeConfigForLog(argv[i + 1] as string));
      i++; // the payload is consumed by the summary above
    }
  }

  return rendered.join(" ");
}

function summarizeConfigForLog(config: string): string {
  try {
    const parsed = JSON.parse(config) as { mcpServers?: Record<string, unknown> };
    const names = Object.keys(parsed.mcpServers ?? {});
    return names.length > 0 ? `<config: ${names.join(",")}>` : "<config: none>";
  } catch {
    return "<config: unparseable>";
  }
}
