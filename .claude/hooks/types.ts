// Types for Claude Code hook stdin/stdout contract
// Utility: spawnSync wrapper that returns { exitCode, stdout, stderr } without throwing

export interface ClaudeHookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  agent_id?: string;
}

export interface ToolHookInput extends ClaudeHookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
}

export interface StopHookInput extends ClaudeHookInput {
  reason?: string;
  stop_hook_active?: boolean;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
}

// Sync exec helper — returns exit code + output without throwing
export function execSync(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  const result = Bun.spawnSync(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout,
  });
  const timedOut = result.exitCode === null && result.signalCode === "SIGTERM";
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    timedOut,
  };
}

/**
 * PATH-augmented sync exec helper. Prepends common homebrew/system binary
 * directories to PATH so that `gh` and `git` resolve correctly regardless of
 * the shell PATH that launched Claude Code. Used by hooks that call `gh`/`git`.
 */
export function execWithPath(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const result = Bun.spawnSync(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout ?? 10000,
    env: { ...process.env, PATH: pathPrefix },
  });
  const timedOut = result.exitCode === null && result.signalCode === "SIGTERM";
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    timedOut,
  };
}

// Read hook input from stdin
export async function readInput<T = ClaudeHookInput>(): Promise<T> {
  return (await Bun.stdin.json()) as T;
}

// Write hook output to stdout
export function writeOutput(output: HookOutput): void {
  process.stdout.write(JSON.stringify(output));
  emitHookFiredOnDeny(output);
}

// ---------------------------------------------------------------------------
// hook.fired system-event bridge (mt#2537)
// ---------------------------------------------------------------------------
//
// Design (chosen over touching each individual guard hook, per mt#2537's
// "prefer a design touching few/no individual guard hooks" preference):
// `writeOutput` is the single common function every guard hook (54 call sites
// as of mt#2537) already calls to emit its stdout decision. Intercepting HERE
// gives `hook.fired` coverage across every hook with zero per-hook edits.
//
// Scope: only `decision: "blocked"` (a `permissionDecision: "deny"`) is
// covered in v1. "overridden" decisions (MINSKY_FORCE_*/MINSKY_SKIP_* env-var
// bypasses) are logged by each hook as its own free-text audit line to stdout
// (e.g. "[parallel-work-guard] override active: ...") — there is no shared
// choke point for those the way there is for `writeOutput`'s JSON contract,
// and retrofitting every override call site would violate the
// touch-few-hooks design preference. Deferred; see mt#2537 PR body.
//
// Invocation path: fire-and-forget, detached `minsky events emit hook.fired`
// subprocess, `.unref()`'d immediately so the parent hook process's own exit
// (and its <15s host-cap budget, see readHostCap above) is never blocked on
// it. Any failure (spawn error, `minsky` not on PATH) is swallowed — this
// must never affect the hook's actual permission decision, which has already
// been written to stdout by the time this runs.
export function emitHookFiredOnDeny(output: HookOutput): void {
  if (output.hookSpecificOutput?.permissionDecision !== "deny") return;
  try {
    const scriptPath = process.argv[1] ?? "unknown";
    const hookName = scriptPath.split(/[\\/]/).pop() || scriptPath;
    const payload = JSON.stringify({ hook: hookName, decision: "blocked" as const });
    const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
    const proc = Bun.spawn(["minsky", "events", "emit", "hook.fired", "--payload", payload], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, PATH: pathPrefix },
    });
    proc.unref();
  } catch {
    // Best-effort — telemetry must never break (or delay) the hook's actual
    // decision, which writeOutput has already flushed to stdout above.
  }
}

// ---------------------------------------------------------------------------
// Host-cap reader + budget derivation (mt#1546)
// ---------------------------------------------------------------------------
//
// PreToolUse/PostToolUse hooks declare a host-imposed `timeout` in
// `.claude/settings.json` — Claude Code SIGKILLs the hook after that many
// seconds. Hooks that run multiple bounded calls inside that window need their
// internal budgets to stay under the cap. Hardcoding ms values per-hook drifts
// silently when the cap is bumped; reading the cap at startup keeps the
// relationship structural.
//
// `readHostCap` walks `hooks.<event>[*].hooks[*].command` for the entry that
// references this hook's basename (exact or `<dir>/<basename>` suffix match) and
// returns its `timeout` field. Callers pass an optional `events` filter to
// disambiguate when the same hook is wired into more than one event.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_HOST_CAP_SEC = 15;

/**
 * Floor on derived per-call timeouts. Without a clamp, hostCaps in the
 * single-digit seconds (or pathologically small values) can floor to 0 or
 * a few ms, which is shorter than realistic git-call wall time and would
 * make every probe instantly time out. 100ms is well below the typical
 * git-probe latency (<= a few hundred ms in degraded conditions) but above
 * the noise floor for spawn + exit overhead.
 */
export const MIN_DERIVED_BUDGET_MS = 100;

export interface HostCapInfo {
  /** Resolved host cap in seconds. */
  hostCapSec: number;
  /** Where the cap came from. */
  source: "settings.json" | "default";
  /**
   * Set on every fallback path (project dir undetectable, settings.json missing
   * or malformed, no matcher entry, missing/invalid timeout). Unset on the
   * happy path. Hooks should surface the warning through their existing
   * operator-warning channel (e.g., the `warnings` array emitted as
   * `additionalContext`).
   */
  warning?: string;
}

/**
 * Read the host-imposed timeout cap (in seconds) for the matcher entry that
 * runs this hook.
 *
 * @param hookFilename — basename of the hook script (e.g.,
 *   `"check-branch-fresh.ts"`). Matched against each hook entry's `command`
 *   field via exact equality OR `<dir>/<basename>` suffix match (so the typical
 *   `$CLAUDE_PROJECT_DIR/.claude/hooks/<basename>` form is recognised).
 *   Substring match was deliberately replaced with suffix match in PR #958
 *   R1 to disambiguate when multiple hooks share a filename suffix.
 * @param projectDir — optional override. When omitted, falls back to
 *   `process.env.CLAUDE_PROJECT_DIR`.
 * @param options — `events` allowlist defaults to `["PreToolUse"]` so
 *   callers don't have to remember the safer default; pass a different
 *   array (or `[]` for "all events") when the hook fires on a different
 *   lifecycle event. `readFile` defaults to `node:fs.readFileSync`; tests
 *   inject a fake reader to keep tests pure.
 *
 * Falls back to `DEFAULT_HOST_CAP_SEC` (15s) on any failure path with a
 * descriptive `warning` set.
 */
export interface ReadHostCapOptions {
  /**
   * Restrict the walk to these event names. Defaults to `["PreToolUse"]`
   * (the typical case). Pass `[]` to scan every event or a different array
   * for PostToolUse/Stop/etc. hooks. The default makes the function
   * footgun-free for the common case (PR #958 R2 NON-BLOCKING #3 fix).
   */
  events?: readonly string[];
  /** Custom file reader (used by tests to avoid touching real fs). */
  readFile?: (path: string) => string;
}

export function readHostCap(
  hookFilename: string,
  projectDir?: string,
  options?: ReadHostCapOptions
): HostCapInfo {
  const readFile = options?.readFile ?? ((p: string): string => readFileSync(p, "utf8") as string);
  const events = options?.events ?? ["PreToolUse"];
  const root = projectDir ?? process.env["CLAUDE_PROJECT_DIR"] ?? null;
  if (!root) {
    return {
      hostCapSec: DEFAULT_HOST_CAP_SEC,
      source: "default",
      warning: `CLAUDE_PROJECT_DIR not set and no projectDir override — using default host cap (${DEFAULT_HOST_CAP_SEC}s)`,
    };
  }

  const settingsPath = join(root, ".claude", "settings.json");
  let raw: string;
  try {
    raw = readFile(settingsPath);
  } catch (err) {
    return {
      hostCapSec: DEFAULT_HOST_CAP_SEC,
      source: "default",
      warning: `Could not read ${settingsPath}: ${err instanceof Error ? err.message : String(err)} — using default host cap (${DEFAULT_HOST_CAP_SEC}s)`,
    };
  }

  return findHostCapInSettings(raw, hookFilename, {
    events,
    settingsPathForErrors: settingsPath,
  });
}

/**
 * True iff `command` references a hook whose script basename equals
 * `hookFilename`. Accepts:
 *   - exact equality (`command === hookFilename`)
 *   - `<dir>/<basename>` path-segment suffix on any whitespace-delimited
 *     token in `command`
 *
 * Tokenising on whitespace lets the matcher recognise wrapper invocations
 * (`bun run .claude/hooks/check-branch-fresh.ts --flag`,
 * `node $CLAUDE_PROJECT_DIR/.claude/hooks/check-branch-fresh.ts`) AND
 * trailing-args invocations (`.claude/hooks/check-branch-fresh.ts --quiet`)
 * — PR #958 R3 BLOCKING #1 fix.
 *
 * Rejects substrings that don't end at a path-segment boundary, so e.g.
 * `"fresh.ts"` does NOT match `"check-branch-fresh.ts"` and
 * `"check-branch-fresh.ts"` does NOT match `"check-branch-fresh.ts.bak"`.
 *
 * Cross-platform: backslash-separated paths in tokens (Windows-style,
 * e.g., `C:\repo\.claude\hooks\check-branch-fresh.ts`) are normalised to
 * forward slashes before the suffix check.
 *
 * Case-sensitive (intentional — a casing typo in `settings.json` should
 * fail loudly with a "no matcher entry found" warning, not silently match
 * the wrong entry). Reaffirmed against R2 NON-BLOCKING #4 and R3
 * NON-BLOCKING #3.
 */
// Known runtime wrappers that may precede the hook script in `command`.
// When found at the head, the wrapper (and its subcommand, if any) is
// skipped before evaluating the executable token. This handles invocations
// like `bun run X`, `node X`, `npx tsx X`, etc. PR #958 R6 BLOCKING fix.
const KNOWN_WRAPPERS: ReadonlySet<string> = new Set([
  "env",
  "bun",
  "bunx",
  "node",
  "npx",
  "tsx",
  "ts-node",
  "deno",
]);

// Wrappers that take a subcommand before the script (e.g., `bun run X`,
// `deno run X`). When the wrapper matches, the subcommand is also skipped
// so the executable token resolves to the script path.
const KNOWN_WRAPPER_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set(["run", "x"]),
  deno: new Set(["run"]),
};

// Pattern for `NAME=value` env var assignments at the head of a command
// (e.g., `FOO=1 BAR=2 bun run X` or `env FOO=1 X`). PR #958 R6 BLOCKING
// fix.
const ENV_VAR_ASSIGNMENT_RE = /^[A-Z_][A-Z_0-9]*=/;

/**
 * Locate the executable token in a tokenised command — i.e., the first
 * token that is neither a `NAME=value` env-var assignment nor a known
 * wrapper (with optional subcommand). This is the only token whose
 * basename is checked against the hook filename — arguments after it are
 * never considered, which prevents false-positive matches from arg values
 * that happen to end with the hook's basename (PR #958 R5 + R6).
 */
function findExecutableToken(tokens: readonly string[]): string | null {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (ENV_VAR_ASSIGNMENT_RE.test(t)) {
      i++;
      continue;
    }
    if (KNOWN_WRAPPERS.has(t)) {
      const wrapper = t;
      i++;
      const subs = KNOWN_WRAPPER_SUBCOMMANDS[wrapper];
      if (subs && i < tokens.length && subs.has(tokens[i] as string)) {
        i++;
      }
      continue;
    }
    break;
  }
  return tokens[i] ?? null;
}

function commandMatchesHookFile(command: string, hookFilename: string): boolean {
  if (command === hookFilename) return true;
  // Tokenise on whitespace, then resolve the executable token by skipping
  // leading env-var assignments and known wrappers. Only that one token's
  // basename is checked. This rejects:
  //   - argument values that end with the hook basename (false positive)
  //   - non-executable strings in args (e.g., `echo X` — `echo` is not a
  //     wrapper so it becomes the exec token, doesn't match)
  // and accepts:
  //   - bare paths, wrapper invocations (`bun run X`, `node X`), env-prefix
  //     forms (`FOO=1 bun run X`, `env FOO=1 X`), quoted paths.
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  const execToken = findExecutableToken(tokens);
  if (execToken === null) return false;
  const dequoted = execToken.replace(/^['"]|['"]$/g, "");
  const normalised = dequoted.replace(/\\/g, "/");
  if (normalised === hookFilename) return true;
  if (normalised.endsWith(`/${hookFilename}`)) return true;
  return false;
}

interface FindHostCapOptions {
  events?: readonly string[];
  settingsPathForErrors?: string;
}

/**
 * Pure JSON-walker: given the contents of `.claude/settings.json` (already
 * read from disk), find the matcher entry whose `command` matches
 * `hookFilename` (exact or `<dir>/<basename>` suffix) and return its `timeout`.
 *
 * Split out from `readHostCap` so tests can exercise the parse + walk +
 * validate paths without touching the real filesystem.
 */
export function findHostCapInSettings(
  raw: string,
  hookFilename: string,
  options: FindHostCapOptions = {}
): HostCapInfo {
  const settingsPathForErrors = options.settingsPathForErrors ?? ".claude/settings.json";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      hostCapSec: DEFAULT_HOST_CAP_SEC,
      source: "default",
      warning: `Could not parse ${settingsPathForErrors}: ${err instanceof Error ? err.message : String(err)} — using default host cap (${DEFAULT_HOST_CAP_SEC}s)`,
    };
  }

  // Walk hooks.<event>[*].hooks[*].command. Settings shape:
  //   { hooks: { PreToolUse: [{ matcher, hooks: [{ command, timeout }] }] } }
  const settings = parsed as { hooks?: Record<string, unknown> };
  const allEvents = settings.hooks ?? {};
  // Empty array means "no filter" (scan all events) — the safer way to
  // express "any event" without conflating it with the default-PreToolUse
  // shorthand. Undefined also means "no filter" for backwards compat.
  const eventFilter = options.events && options.events.length > 0 ? options.events : null;
  for (const [eventName, eventEntries] of Object.entries(allEvents)) {
    if (eventFilter && !eventFilter.includes(eventName)) continue;
    if (!Array.isArray(eventEntries)) continue;
    for (const matcherEntry of eventEntries) {
      if (!matcherEntry || typeof matcherEntry !== "object") continue;
      const matcher = matcherEntry as { hooks?: unknown };
      if (!Array.isArray(matcher.hooks)) continue;
      for (const hookDef of matcher.hooks) {
        if (!hookDef || typeof hookDef !== "object") continue;
        const def = hookDef as { type?: unknown; command?: unknown; timeout?: unknown };
        // Settings.json supports a `type` discriminator on hooks ("command"
        // is the only one shipping today). Require an exact match so future
        // schema additions don't let a non-command entry's `command`-shaped
        // field misattribute a timeout (PR #958 R5 NON-BLOCKING #3).
        if (def.type !== "command") continue;
        if (typeof def.command !== "string") continue;
        if (!commandMatchesHookFile(def.command, hookFilename)) continue;
        if (typeof def.timeout !== "number" || !Number.isFinite(def.timeout) || def.timeout <= 0) {
          return {
            hostCapSec: DEFAULT_HOST_CAP_SEC,
            source: "default",
            warning: `Settings entry for ${hookFilename} has missing/invalid timeout — using default host cap (${DEFAULT_HOST_CAP_SEC}s)`,
          };
        }
        return { hostCapSec: def.timeout, source: "settings.json" };
      }
    }
  }

  return {
    hostCapSec: DEFAULT_HOST_CAP_SEC,
    source: "default",
    warning: `No matcher entry found referencing ${hookFilename} — using default host cap (${DEFAULT_HOST_CAP_SEC}s)`,
  };
}

// ---------------------------------------------------------------------------
// Budget derivation (shared util — mt#1546)
// ---------------------------------------------------------------------------
//
// Three timer constants govern hook wall-clock behaviour. They derive from
// the host-imposed `timeout` field via the ratios below. Future hooks with
// the same constraint reuse `deriveBudgets` from this util — no need to
// re-export the ratios from each hook module.

/**
 * Fraction of the host cap allocated to a hook's overall wall-clock budget.
 * The remaining 40% is headroom for process startup, stdout writes, OS
 * scheduling jitter, and a final-call overrun under the budget guard.
 */
export const OVERALL_BUDGET_RATIO = 0.6;

/**
 * Fraction of the overall budget granted to the network-bound `git fetch`.
 * Fetch dominates worst-case wall time and is the only off-host call.
 */
export const FETCH_TIMEOUT_RATIO = 0.55;

/**
 * Fraction of the overall budget granted to each local git probe. ~1/6 means
 * up to 6 sequential probes can run within budget.
 */
export const GIT_TIMEOUT_RATIO = 0.17;

export interface DerivedBudgets {
  /** Overall wall-clock budget for the hook (incl. fetch). */
  overallBudgetMs: number;
  /** Per-call timeout for the network-bound `git fetch`. */
  fetchTimeoutMs: number;
  /** Per-call timeout for fast local git operations. */
  gitTimeoutMs: number;
}

/**
 * Derive ms-valued budgets from a host cap (in seconds). Pure function.
 *
 * Each derived value is clamped to `MIN_DERIVED_BUDGET_MS` (100ms) so that
 * pathologically small host caps don't produce zero-or-near-zero per-call
 * budgets that every probe would instantly exceed. For realistic caps
 * (>= 5s) the clamp never fires.
 */
export function deriveBudgets(hostCapSec: number): DerivedBudgets {
  const overallBudgetMs = Math.max(
    MIN_DERIVED_BUDGET_MS,
    Math.floor(hostCapSec * 1000 * OVERALL_BUDGET_RATIO)
  );
  return {
    overallBudgetMs,
    fetchTimeoutMs: Math.max(
      MIN_DERIVED_BUDGET_MS,
      Math.floor(overallBudgetMs * FETCH_TIMEOUT_RATIO)
    ),
    gitTimeoutMs: Math.max(MIN_DERIVED_BUDGET_MS, Math.floor(overallBudgetMs * GIT_TIMEOUT_RATIO)),
  };
}
