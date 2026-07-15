// Types for Claude Code hook stdin/stdout contract
// Utility: spawnSync wrapper that returns { exitCode, stdout, stderr } without throwing

import { existsSync } from "node:fs";

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
    /**
     * UserPromptSubmit-only: sets the session's display title (Claude Code
     * extension beyond the documented hook-output schema). Added for
     * `auto-session-title.ts` (ADR-028 Phase 2b, mt#2687) — the one guard
     * whose output is a scalar session label rather than additive context.
     */
    sessionTitle?: string;
  };
}

// ---------------------------------------------------------------------------
// Crash-safe spawn + robust git-binary resolution (mt#2810)
// ---------------------------------------------------------------------------
//
// ## The incident
//
// Four `session_pr_merge` PreToolUse gates (require-review-before-merge,
// require-execution-evidence-before-merge, require-deploy-verification-
// before-merge, block-out-of-band-merge) all crashed with
// `ENOENT: posix_spawn 'git'` from the shared `pr-context.ts` fetch layer
// (`deriveRepoFromGit` -> `execWithPath` -> `Bun.spawnSync(["git", ...])`),
// on two separate days (2026-07-14 in a session workspace, 2026-07-15 in
// the main repo). Per each gate's documented fail-open posture, a hook that
// crashes before writing a `permissionDecision` is indistinguishable from
// one that ran and allowed — so the merges were silently permitted with
// ZERO gate enforcement, invisible to both agent and user, and the only
// trace was a raw uncaught-exception stack trace instead of a diagnosable
// warning.
//
// ## Two independent bugs, two independent fixes
//
// 1. **`Bun.spawnSync` THROWS on ENOENT instead of returning a failed
//    result.** Verified directly: `Bun.spawnSync(["git", ...], { env: {
//    PATH: "/nonexistent" } })` throws a synchronous `Error: Executable not
//    found in $PATH: "git" { code: "ENOENT", path: "git", errno: -2 }`
//    rather than returning `{ exitCode: <nonzero>, ... }`. Neither the
//    pre-mt#2810 `execSync` nor `execWithPath` wrapped the call in
//    try/catch, despite this file's own header comment claiming the
//    opposite ("spawnSync wrapper that returns { exitCode, stdout, stderr }
//    WITHOUT THROWING") — the comment described the intended contract; the
//    implementation didn't deliver it. `safeSpawnSync` below is the actual
//    fix: it catches ANY spawn-time throw (missing binary, exec permission
//    denied, etc.) and returns a synthetic non-zero `ExecResult` instead,
//    so a spawn failure degrades exactly like a normal non-zero command
//    exit — which every caller in this codebase (starting with
//    `deriveRepoFromGit` in `pr-context.ts`) already handles gracefully.
//    It also logs a loud `console.error` naming the failed command, so the
//    failure is visible in the hook's own stderr even for a caller (like
//    `require-review-before-merge.ts`, pre-mt#2810) that has no warning
//    path of its own for this branch.
//
// 2. **WHY the hook spawn env lacked PATH (root-cause finding, documented
//    per mt#2810 acceptance criteria).** `execWithPath`'s PATH augmentation
//    was `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` — it
//    assumes git lives under one of those two hardcoded prefixes, OR that
//    `process.env.PATH` (the hook subprocess's OWN inherited PATH, set by
//    whatever spawned the hook — Claude Code's main-agent process, or a
//    dispatched/backgrounded subagent's harness) already contains git's
//    location. Neither is guaranteed for every hook-spawn context:
//      - A dispatched/backgrounded subagent process is not guaranteed to
//        inherit the same interactive-shell PATH the main agent has (login
//        shells source `.zshrc`/`.zprofile`, which is what actually adds
//        Homebrew to `PATH` on a fresh shell — a non-interactive subprocess
//        spawn can plausibly skip that and hand the hook a minimal PATH).
//      - Even a well-formed inherited PATH can point at a distro layout
//        the hardcoded two-entry prefix doesn't anticipate (e.g. Debian/
//        Ubuntu's default `/usr/bin/git`, which this file's prefix did NOT
//        special-case — it relied entirely on `process.env.PATH` already
//        containing `/usr/bin`).
//    Net effect: `execWithPath`'s augmentation is a PATH *prefix*, not a
//    binary *resolution* strategy — it never actually asks "does a `git`
//    executable exist," it just hopes one of a few directories is both
//    present in the final PATH string AND contains git. `resolveGitBinary`
//    below replaces that hope with an actual resolution: `Bun.which`
//    first (respects whatever real PATH is present), then a filesystem
//    existence check against a short list of standard install locations
//    (no subprocess spawn, so this step can't itself throw ENOENT) — and
//    only falls through to the bare, unresolved `"git"` (still crash-safe
//    via `safeSpawnSync`) if truly nothing is found anywhere.

/** Options accepted by `Bun.spawnSync`'s `env` field. */
type SpawnEnv = Record<string, string | undefined>;

/**
 * Spawn a command synchronously WITHOUT throwing on failure to resolve or
 * exec the binary (mt#2810 fix #1 — see the module comment above). Every
 * exec helper in this module funnels through here so a spawn failure
 * (missing binary, permission denied, etc.) always degrades to a
 * structured `ExecResult` instead of crashing the hook process, and always
 * logs a loud, structured `console.error` naming the exact command that
 * failed to spawn — visible in the hook's own stderr regardless of whether
 * the caller has its own fail-open warning path.
 */
function safeSpawnSync(
  cmd: string[],
  options: { cwd?: string; timeout?: number; env?: SpawnEnv }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  try {
    const result = Bun.spawnSync(cmd, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeout,
      ...(options.env ? { env: options.env } : {}),
    });
    // mt#2810 PR #1952 R1 NON-BLOCKING: broadened from `signalCode ===
    // "SIGTERM"` — a timed-out `Bun.spawnSync` always reports `exitCode:
    // null` (it never completed normally), but the signal Bun uses to kill
    // it can vary by platform/version (e.g. SIGKILL after a grace period).
    // Gating on SIGTERM specifically produced a false negative (`timedOut:
    // false`) for any of those other signals. `exitCode === null` alone is
    // the reliable "did not exit normally" signal.
    const timedOut = result.exitCode === null;
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      timedOut,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Loud degradation signal (mt#2810 success criterion: "when git
    // genuinely cannot be resolved, emit a loud structured warning naming
    // the degradation — not a bare stack trace"). This is the lowest
    // common layer every gate's exec call funnels through, so it fires
    // regardless of which of the four gates (or future callers) triggered
    // it, and regardless of whether that caller has its own warning path.
    console.error(
      `[hook-exec] DEGRADED: failed to spawn \`${cmd.join(" ")}\` — ${message}. ` +
        `Returning a synthetic failed result instead of crashing; any gate check ` +
        `depending on this call will fail-open with that result (see the gate's own ` +
        `fail-open warning, if any, for which check was skipped).`
    );
    return {
      exitCode: 127, // conventional shell "command not found" exit code
      stdout: "",
      stderr: `spawn failed: ${message}`,
      timedOut: false,
    };
  }
}

/**
 * Standard-location fallbacks for `git`, tried when `Bun.which` can't
 * resolve it from the (PATH-augmented) spawn environment. Checked with
 * `existsSync` — no subprocess spawn, so this step can never itself throw
 * ENOENT. Covers macOS Homebrew (Apple Silicon `/opt/homebrew`, Intel
 * `/usr/local`), Xcode Command Line Tools / system git, and the common
 * Linux distro location.
 */
const GIT_FALLBACK_PATHS: readonly string[] = [
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
  "/usr/bin/git",
  "/bin/git",
];

/**
 * Module-level cache — git-binary resolution doesn't change mid-process.
 * Only a SUCCESSFUL resolution is ever cached (mt#2810 PR #1952 R1
 * NON-BLOCKING): caching a failed ("nothing resolved") attempt would
 * permanently lock the process into re-spawning bare `"git"` even if
 * whatever made resolution fail (e.g. a not-yet-mounted filesystem, a PATH
 * that gets repaired mid-process) is no longer true by the next call. Never
 * holds `null` — an unresolved state is represented by `undefined` so every
 * call retries full resolution until one succeeds.
 */
let cachedGitBinaryPath: string | undefined;

export interface ResolveGitBinaryOptions {
  /** Override the PATH string passed to `Bun.which` (tests only). */
  pathOverride?: string;
  /** Override the fallback candidate list (tests only). */
  fallbackPaths?: readonly string[];
  /** Override `existsSync` (tests only — simulate "nothing found"). */
  existsSyncFn?: (path: string) => boolean;
  /** Override `Bun.which` (tests only). */
  whichFn?: (command: string, options?: { PATH?: string }) => string | null;
  /** Bypass the module-level cache (tests only — production always caches). */
  noCache?: boolean;
}

/**
 * Resolve an absolute path to the `git` binary, robust to a hook spawn
 * environment whose PATH doesn't include it (mt#2810 fix #2 — see the
 * module comment above for the root-cause finding this replaces).
 *
 * Resolution order:
 *   1. `Bun.which("git", { PATH: <augmented PATH> })` — respects whatever
 *      real PATH customization is present (Homebrew, asdf, nix, etc.)
 *   2. `GIT_FALLBACK_PATHS`, checked via `existsSync` (no subprocess).
 *   3. Bare `"git"` as a last resort — spawning this can still fail if
 *      truly nothing resolves, but `safeSpawnSync` (above) now catches
 *      that failure instead of letting it crash the hook process.
 *
 * Cached for the lifetime of the hook process.
 */
export function resolveGitBinary(options: ResolveGitBinaryOptions = {}): string {
  if (!options.noCache && cachedGitBinaryPath) {
    return cachedGitBinaryPath;
  }
  const pathPrefix =
    options.pathOverride ?? `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const which =
    options.whichFn ?? ((cmd: string, opts?: { PATH?: string }) => Bun.which(cmd, opts));
  const exists = options.existsSyncFn ?? existsSync;
  const fallbacks = options.fallbackPaths ?? GIT_FALLBACK_PATHS;

  let resolved: string | null = null;
  try {
    resolved = which("git", { PATH: pathPrefix });
  } catch {
    resolved = null;
  }
  if (!resolved) {
    for (const candidate of fallbacks) {
      try {
        if (exists(candidate)) {
          resolved = candidate;
          break;
        }
      } catch {
        // Treat a filesystem-check error as "not found" — keep scanning.
      }
    }
  }
  // Only a successful resolution is cached — see the `cachedGitBinaryPath`
  // doc comment above (mt#2810 PR #1952 R1 NON-BLOCKING).
  if (!options.noCache && resolved) cachedGitBinaryPath = resolved;
  return resolved ?? "git";
}

/**
 * Test-only: reset the module-level git-binary resolution cache. Production
 * code never needs this — the cache is meant to persist for the hook
 * process's lifetime. Exists so tests can deterministically exercise the
 * cache-miss path without depending on ambient state from other tests or
 * production code paths that may have already populated the cache earlier
 * in the same test-runner process.
 */
export function __resetGitBinaryCacheForTests(): void {
  cachedGitBinaryPath = undefined;
}

/**
 * Substitute `cmd[0]` with the resolved absolute git path when the command
 * invokes `git` by bare name. No-op for any other command (e.g. `gh`).
 */
function resolveGitCommand(cmd: string[]): string[] {
  if (cmd[0] !== "git") return cmd;
  return [resolveGitBinary(), ...cmd.slice(1)];
}

// Sync exec helper — returns exit code + output without throwing
export function execSync(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  return safeSpawnSync(resolveGitCommand(cmd), {
    cwd: options?.cwd,
    timeout: options?.timeout,
  });
}

/**
 * PATH-augmented sync exec helper. Prepends common homebrew/system binary
 * directories to PATH so that `gh` resolves correctly regardless of the
 * shell PATH that launched Claude Code, and additionally resolves `git`
 * robustly via `resolveGitBinary` (mt#2810 — PATH augmentation alone is not
 * a resolution strategy, see the module comment above). Used by hooks that
 * call `gh`/`git`. Never throws — spawn failures degrade to a structured
 * `ExecResult` (see `safeSpawnSync`).
 */
export function execWithPath(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  return safeSpawnSync(resolveGitCommand(cmd), {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 10000,
    env: { ...process.env, PATH: pathPrefix },
  });
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
    // Same PATH-augmentation convention as execWithPath above (macOS/Linux
    // homebrew + local-bin prefixes). Minsky's hook toolchain is macOS/Linux-
    // only today (no Windows path-separator handling); if Windows support is
    // ever added, both helpers need updating together.
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
