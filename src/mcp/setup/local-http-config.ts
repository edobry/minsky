/**
 * `minsky setup local-http` decision core (mt#3816, ADR-038 §Question 7).
 *
 * Discovers every Claude Code MCP entry that points at Minsky, decides which
 * ones migrate to the shim form, and renders the plan. Nothing here touches
 * the real filesystem except through injected deps, so the decisions — which
 * entries migrate, what the rewritten args are, what a no-op looks like — are
 * unit-testable without a home directory.
 *
 * ## Why discovery rather than a fixed target
 *
 * Claude Code stores MCP servers at three scopes and TWO of them are
 * per-project (<https://code.claude.com/docs/en/mcp>):
 *
 *   local   → `~/.claude.json`, under that project's path   (current project only)
 *   project → `.mcp.json` in the project root               (current project only)
 *   user    → `~/.claude.json`, top level                   (all projects)
 *
 * So "rewrite the config" has no single answer. Writing to one fixed scope is
 * how a migration silently covers one project and leaves the rest on the
 * proxy. This module scans all three and reports everything it finds.
 *
 * It also never CREATES an entry in a scope that did not already have one.
 * Per the same doc, "the entire server entry from that source is used; fields
 * are not merged across scopes" — so introducing an entry at a different scope
 * would silently change which definition wins.
 */

import fs from "fs";
import os from "os";
import path from "path";

/** The three scopes Claude Code resolves MCP servers from, in precedence order. */
export type McpScope = "local" | "project" | "user";

/**
 * What a discovered Minsky entry currently is.
 *
 * `other` exists because an entry can name Minsky without being either form —
 * a bare `mcp start`, say. Those are reported and never rewritten: this
 * command migrates the proxy topology, and silently converting anything else
 * would be a scope change the operator did not ask for.
 */
export type EntryForm = "proxy" | "shim" | "other";

export interface DiscoveredEntry {
  scope: McpScope;
  /** Absolute path of the file holding the entry. */
  file: string;
  /** The server's key under `mcpServers`. */
  serverName: string;
  /** Local scope only: the project path the entry is filed under. */
  projectPath?: string;
  form: EntryForm;
  /** The entry's `command`, verbatim. */
  command: string;
  /** The entry's `args`, verbatim. */
  args: string[];
}

// ---------------------------------------------------------------------------
// Injected IO
// ---------------------------------------------------------------------------

export interface ConfigFsDeps {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string): void;
  renameSync(from: string, to: string): void;
  readdirSync(p: string): string[];
}

export function makeProductionConfigFsDeps(): ConfigFsDeps {
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p, "utf8") as string,
    writeFileSync: (p, data) => fs.writeFileSync(p, data, "utf8"),
    renameSync: (from, to) => fs.renameSync(from, to),
    readdirSync: (p) => fs.readdirSync(p),
  };
}

// ---------------------------------------------------------------------------
// Entry classification
// ---------------------------------------------------------------------------

/**
 * Whether this command/args pair invokes Minsky's CLI.
 *
 * Two shapes are real in this repo: the installed binary
 * (`/Users/.../bin/minsky mcp ...`) and the from-source dev form
 * (`bun /path/to/src/cli.ts mcp ...`). Matching only the first would silently
 * skip a developer's own config, which is the population most likely to be
 * migrating early.
 */
export function isMinskyInvocation(command: string, args: string[]): boolean {
  const base = path.basename(command);
  if (base === "minsky") return true;
  if (base === "bun" || base === "node" || base === "bunx" || base === "npx") {
    return args.some((a) => a.endsWith("/cli.ts") || a.endsWith("/minsky.js") || a === "minsky");
  }
  return false;
}

/**
 * Whether this invocation can actually reach `mcp shim`.
 *
 * `mcp shim` is NOT a command of the normal CLI. `scripts/cli-entry.ts` — the
 * package's `bin` — intercepts `["mcp","shim"]` from argv and imports a
 * separate build artifact, deliberately never entering `src/cli.ts`, because
 * that path pulls in tsyringe and the full command registry and the shim's RSS
 * thinness is load-bearing (mt#3812; `src/mcp/shim/rss-budget.test.ts` is a
 * committed merge gate on it). So routing depends on whether the invocation
 * goes THROUGH that bin wrapper, and every prefix that bypasses it errors with
 * `unknown command 'shim'`. Measured 2026-08-16:
 *
 *   minsky mcp shim --url …            → runs      (bin wrapper intercepts)
 *   bun dist/minsky.js mcp shim --url … → unknown command 'shim'
 *   bun src/cli.ts mcp shim --url …     → unknown command 'shim'
 *
 * Both bypassing forms are ones `isMinskyInvocation` matches on purpose, which
 * is why this predicate is separate from it: an entry can be unambiguously
 * Minsky's and still be unable to run the form we would rewrite it to.
 */
export function canRouteShim(command: string, args: string[]): boolean {
  const base = path.basename(command);
  if (base === "minsky") return true;
  // `bunx`/`npx` resolve the package's bin when given `minsky`, so they route.
  // A script path (`.../cli.ts`, `.../minsky.js`) does not — it IS the bypass.
  if (base === "bunx" || base === "npx") return args.includes("minsky");
  return false;
}

/**
 * Index of the `mcp` token in `args`, or -1.
 *
 * Located rather than assumed at a fixed position: the dev form prefixes a
 * script path, so `args[0]` is `mcp` for the binary and a `.ts` path for
 * `bun`. Everything before this index is the invocation and is preserved.
 */
export function findMcpTokenIndex(args: string[]): number {
  return args.indexOf("mcp");
}

export function classifyForm(args: string[]): EntryForm {
  const i = findMcpTokenIndex(args);
  if (i < 0) return "other";
  const sub = args[i + 1];
  if (sub === "proxy") return "proxy";
  if (sub === "shim") return "shim";
  return "other";
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string")) return null;
  return value as string[];
}

/**
 * Build a DiscoveredEntry from one `mcpServers` member, or null when it is not
 * a Minsky invocation.
 *
 * A remote (HTTP/SSE) entry has a `url` and no `command`; it returns null here
 * rather than throwing, because a config full of unrelated servers is the
 * normal case, not an error.
 */
export function classifyEntry(input: {
  scope: McpScope;
  file: string;
  serverName: string;
  projectPath?: string;
  entry: unknown;
}): DiscoveredEntry | null {
  const { entry } = input;
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const command = obj["command"];
  if (typeof command !== "string") return null;
  const args = readStringArray(obj["args"]) ?? [];
  if (!isMinskyInvocation(command, args)) return null;

  return {
    scope: input.scope,
    file: input.file,
    serverName: input.serverName,
    ...(input.projectPath === undefined ? {} : { projectPath: input.projectPath }),
    form: classifyForm(args),
    command,
    args,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  projectRoot: string;
  home?: string;
  deps?: ConfigFsDeps;
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".mcp.json");
}

export function claudeJsonPath(home: string): string {
  return path.join(home, ".claude.json");
}

function parseJsonFile(file: string, deps: ConfigFsDeps): Record<string, unknown> | null {
  if (!deps.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(deps.readFileSync(file));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // A malformed config is reported by the caller as "nothing discoverable
    // here" rather than crashing the whole scan: the other scopes may still
    // hold a migratable entry, and refusing to look at them helps nobody.
    return null;
  }
}

function serversOf(container: Record<string, unknown> | null): Record<string, unknown> {
  if (!container) return {};
  const servers = container["mcpServers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

/**
 * Every Minsky MCP entry visible on this machine, across all three scopes.
 *
 * Local scope is scanned for EVERY project key in `~/.claude.json`, not just
 * `projectRoot` — a machine-wide daemon migration that covered only the
 * current project would leave every other project spawning its own server,
 * which is the condition this whole topology exists to remove.
 */
export function discoverMinskyEntries(options: DiscoveryOptions): DiscoveredEntry[] {
  const deps = options.deps ?? makeProductionConfigFsDeps();
  const home = options.home ?? os.homedir();
  const found: DiscoveredEntry[] = [];

  const projectFile = projectConfigPath(options.projectRoot);
  const projectJson = parseJsonFile(projectFile, deps);
  for (const [serverName, entry] of Object.entries(serversOf(projectJson))) {
    const hit = classifyEntry({ scope: "project", file: projectFile, serverName, entry });
    if (hit) found.push(hit);
  }

  const claudeFile = claudeJsonPath(home);
  const claudeJson = parseJsonFile(claudeFile, deps);

  for (const [serverName, entry] of Object.entries(serversOf(claudeJson))) {
    const hit = classifyEntry({ scope: "user", file: claudeFile, serverName, entry });
    if (hit) found.push(hit);
  }

  const projects = claudeJson?.["projects"];
  if (projects && typeof projects === "object" && !Array.isArray(projects)) {
    for (const [projectPath, value] of Object.entries(projects as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const servers = serversOf(value as Record<string, unknown>);
      for (const [serverName, entry] of Object.entries(servers)) {
        const hit = classifyEntry({
          scope: "local",
          file: claudeFile,
          serverName,
          projectPath,
          entry,
        });
        if (hit) found.push(hit);
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// The rewrite
// ---------------------------------------------------------------------------

/**
 * The shim args for a given daemon URL, preserving whatever preceded `mcp`.
 *
 * The proxy's `--child-args` payload is intentionally dropped: it told the
 * proxy which child to spawn, and under the shim topology the daemon is a
 * separate long-lived process started once, not a child of this entry.
 */
export function rewriteToShimArgs(args: string[], daemonUrl: string): string[] {
  const i = findMcpTokenIndex(args);
  const prefix = i < 0 ? args.slice() : args.slice(0, i);
  return [...prefix, "mcp", "shim", "--url", daemonUrl];
}

export interface PlannedRewrite {
  entry: DiscoveredEntry;
  beforeArgs: string[];
  afterArgs: string[];
}

export interface MigrationPlan {
  /** Entries that will be rewritten. */
  rewrites: PlannedRewrite[];
  /** Entries already in shim form — the no-op population. */
  alreadyMigrated: DiscoveredEntry[];
  /** Minsky entries in neither form; reported, never touched. */
  skipped: DiscoveredEntry[];
  /**
   * Proxy-form entries whose invocation cannot route `mcp shim` — reported,
   * never rewritten. See `canRouteShim` for which prefixes those are.
   */
  unroutable: DiscoveredEntry[];
  /** Distinct files the rewrites would touch. */
  filesTouched: string[];
}

export function planMigration(entries: DiscoveredEntry[], daemonUrl: string): MigrationPlan {
  const rewrites: PlannedRewrite[] = [];
  const alreadyMigrated: DiscoveredEntry[] = [];
  const skipped: DiscoveredEntry[] = [];
  const unroutable: DiscoveredEntry[] = [];

  for (const entry of entries) {
    if (entry.form === "proxy") {
      // Rewriting an entry to a command its own prefix cannot execute would
      // hand the operator a config that fails at spawn with `unknown command
      // 'shim'` — worse than not migrating it, because the proxy entry that
      // did work is gone. Report instead.
      //
      // Substituting the installed `minsky` binary for the prefix is NOT the
      // fix: that silently changes which binary — and which VERSION — the
      // operator's entry runs, the same class of unrequested scope change the
      // `other` population above is held back for.
      if (!canRouteShim(entry.command, entry.args)) {
        unroutable.push(entry);
        continue;
      }
      rewrites.push({
        entry,
        beforeArgs: entry.args,
        afterArgs: rewriteToShimArgs(entry.args, daemonUrl),
      });
    } else if (entry.form === "shim") {
      alreadyMigrated.push(entry);
    } else {
      skipped.push(entry);
    }
  }

  const filesTouched = [...new Set(rewrites.map((r) => r.entry.file))];
  return { rewrites, alreadyMigrated, skipped, unroutable, filesTouched };
}

/** True when applying this plan would change nothing on disk. */
export function isNoOp(plan: MigrationPlan): boolean {
  return plan.rewrites.length === 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function describeLocation(entry: DiscoveredEntry): string {
  const where = entry.projectPath === undefined ? "" : ` [${entry.projectPath}]`;
  return `${entry.scope} scope · ${entry.file}${where} · server "${entry.serverName}"`;
}

/**
 * The before/after the operator reads before authorizing `--execute`.
 *
 * Renders the no-op and skipped populations too: "nothing to do" and "I did
 * not look" are indistinguishable from an empty diff, and only one of them is
 * a reason to stop.
 */
export function renderPlan(plan: MigrationPlan, daemonUrl: string): string {
  const lines: string[] = [];

  if (isNoOp(plan)) {
    // Distinguish the two ways the rewrite set can be empty. "Found none" and
    // "found some, none of them migratable" are the same empty diff and are
    // not the same news — the second is a reason to stop and read.
    lines.push(
      plan.unroutable.length > 0
        ? "No Minsky MCP entries can be migrated — see the unmigratable entries below."
        : "No proxy-form Minsky MCP entries found — nothing to migrate."
    );
  } else {
    lines.push(
      `Migrating ${plan.rewrites.length} Minsky MCP entr` +
        `${plan.rewrites.length === 1 ? "y" : "ies"} to the shim at ${daemonUrl}:`
    );
  }

  for (const rewrite of plan.rewrites) {
    lines.push("");
    lines.push(`  ${describeLocation(rewrite.entry)}`);
    lines.push(`    command: ${rewrite.entry.command}  (unchanged)`);
    lines.push(`    - args: ${JSON.stringify(rewrite.beforeArgs)}`);
    lines.push(`    + args: ${JSON.stringify(rewrite.afterArgs)}`);
  }

  if (plan.alreadyMigrated.length > 0) {
    lines.push("");
    lines.push("Already on the shim (no change):");
    for (const entry of plan.alreadyMigrated) lines.push(`  ${describeLocation(entry)}`);
  }

  if (plan.unroutable.length > 0) {
    lines.push("");
    lines.push("Proxy entries that CANNOT be migrated — this invocation cannot run `mcp shim`,");
    lines.push("which is routed by the `minsky` bin wrapper and not by the CLI itself (mt#3812):");
    for (const entry of plan.unroutable) {
      lines.push(`  ${describeLocation(entry)}`);
      lines.push(`    command: ${entry.command} · args: ${JSON.stringify(entry.args)}`);
    }
    lines.push("");
    lines.push("  Left on the proxy, which still works. To move one onto the shim, point its");
    lines.push("  `command` at an installed `minsky` binary and re-run — deliberately not done");
    lines.push("  for you, since it changes which binary and version the entry executes.");
  }

  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push("Minsky entries in neither proxy nor shim form — left alone:");
    for (const entry of plan.skipped) {
      lines.push(`  ${describeLocation(entry)} · args: ${JSON.stringify(entry.args)}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export const BACKUP_SUFFIX = ".minsky-backup-";

/**
 * Backup path for a config file at a given instant.
 *
 * The timestamp is passed in rather than read from the clock so the caller
 * stamps one instant across every file it touches in a single run — a revert
 * that restored files from two different instants would be a config nobody
 * ever ran.
 */
export function backupPathFor(file: string, timestamp: string): string {
  return `${file}${BACKUP_SUFFIX}${timestamp}`;
}

/** Filesystem-safe instant stamp: `2026-08-12T21-51-00-123Z`. */
export function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * The most recent backup of `file`, or null.
 *
 * Lexicographic max is correct here because the stamp is ISO-8601 with fixed
 * width, so string order and chronological order coincide.
 */
export function findLatestBackup(file: string, deps: ConfigFsDeps): string | null {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${BACKUP_SUFFIX}`;
  let names: string[];
  try {
    names = deps.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = names.filter((n) => n.startsWith(prefix)).sort();
  const latest = candidates[candidates.length - 1];
  return latest === undefined ? null : path.join(dir, latest);
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Indentation of an existing JSON document, defaulting to 2.
 *
 * Re-serializing `~/.claude.json` with the wrong indent would rewrite a large
 * file the operator never asked us to reformat; detecting it keeps the diff
 * to the entry we actually changed.
 *
 * Returns the whitespace VERBATIM for a tab-indented document rather than a
 * width. `JSON.stringify` takes a string indent as readily as a number, and
 * collapsing tabs to the numeric default reformatted every line of a
 * tab-indented config — the whole-file diff this function exists to avoid,
 * reached by the one path that could not express its own answer.
 */
export function detectIndent(raw: string): string | number {
  const match = raw.match(/\n(\s+)"/);
  const indent = match?.[1];
  if (indent === undefined) return 2;
  if (indent.includes("\t")) return indent;
  return indent.length;
}

/** Write `data` to `file` via a temp file + rename, so a crash cannot truncate it. */
export function writeAtomically(file: string, data: string, deps: ConfigFsDeps): void {
  const tmp = `${file}.minsky-tmp`;
  deps.writeFileSync(tmp, data);
  deps.renameSync(tmp, file);
}

/**
 * Apply the plan's rewrites for one file and return its new contents.
 *
 * Returns null when this file's document cannot be read or parsed — the
 * caller reports that rather than writing a guess over the operator's config.
 */
export function applyRewritesToDocument(raw: string, rewrites: PlannedRewrite[]): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const root = doc as Record<string, unknown>;

  for (const rewrite of rewrites) {
    const { entry } = rewrite;
    const container =
      entry.scope === "local"
        ? ((root["projects"] as Record<string, unknown> | undefined)?.[
            entry.projectPath as string
          ] as Record<string, unknown> | undefined)
        : root;
    const servers = container?.["mcpServers"];
    if (!servers || typeof servers !== "object") continue;
    const target = (servers as Record<string, unknown>)[entry.serverName];
    if (!target || typeof target !== "object") continue;
    // Mutating only `args` is what preserves `type`, `env`, and any key
    // Claude Code adds later that this code has never heard of.
    (target as Record<string, unknown>)["args"] = rewrite.afterArgs;
  }

  return `${JSON.stringify(root, null, detectIndent(raw))}\n`;
}
