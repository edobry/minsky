/**
 * Observability-hook provisioning for Minsky-managed projects (mt#3499).
 *
 * `minsky init` makes a project Minsky-managed; until this module, that did not
 * make it OBSERVABLE. Attach (mt#3095) and presence (mt#3201) both key on a
 * `conversation_run_state` row, and that row is only written by a hook — which
 * only existed in the Minsky repo's own `.claude/settings.json`. A project
 * initialized anywhere else read `UNKNOWN` and was refused.
 *
 * ## The product/plant split (beyond-Minsky RFC amendment 2026-08-01 §2)
 *
 * This repo's ~45 registered hooks are its own development policy — merge
 * gates, spec-read checks, dispatch guards. They are PLANT: they encode how
 * Minsky is built and would be meaningless or hostile in someone else's
 * project. {@link OBSERVABILITY_BASELINE_HOOKS} is the PRODUCT tier: the
 * minimal set that makes a project observable to its own operator's cockpit,
 * authored for that purpose. Rules already have this split (init's curated
 * template list in `init/rule-templates.ts`); this gives hooks the same one.
 *
 * ## Why the files live outside the target repo
 *
 * Claude Code's settings docs distinguish `.claude/settings.json` ("checked
 * into source control and shared with your team") from
 * `.claude/settings.local.json` ("not checked in, useful for personal
 * preferences"). The baseline POSTs to the operator's OWN cockpit daemon on
 * 127.0.0.1, so it is personal instrumentation, not team policy — it registers
 * in the local file. The hook FILES follow the registration: they install into
 * a Minsky-owned state directory rather than the user's repo, so provisioning
 * writes nothing a user would commit, needs no gitignore management, and has
 * no in-repo copy that can drift. One shared copy serves every project, since
 * the baseline is identical for all of them.
 *
 * @see mt#3503 — closed the baseline's dependency graph; these files import
 *   nothing outside the hooks directory, which is what makes them runnable
 *   from an arbitrary install path.
 */

import * as path from "path";
import * as os from "os";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import type { FsLike } from "../interfaces/fs-like";
import { createRealFs } from "../interfaces/real-fs";
import { OBSERVED_HOOK_EVENTS } from "../conversation-run-state/event-mapping";

// ---------------------------------------------------------------------------
// The product baseline (the mt#3499 "which hooks" declaration)
// ---------------------------------------------------------------------------

/**
 * Hooks installed into every Minsky-managed project. Deliberately minimal —
 * each entry must be justifiable as "this makes the project observable to its
 * operator", not "this is how Minsky develops Minsky".
 */
export const OBSERVABILITY_BASELINE_HOOKS = [
  /** Feeds `conversation_run_state`; what attach + presence read. */
  "record-conversation-run-state.ts",
  /** Ingests the transcript at SessionEnd so the conversation is readable. */
  "transcript-ingest-on-session-end.ts",
] as const;

/**
 * Non-entrypoint modules the baseline imports. Copied alongside so the
 * installed set is self-contained — enforced from the other direction by
 * `.minsky/hooks/self-containment.test.ts`, which walks this exact closure.
 */
export const BASELINE_SUPPORT_FILES = ["types.ts"] as const;

/** Every file provisioning installs. */
export const BASELINE_INSTALL_FILES: readonly string[] = [
  ...OBSERVABILITY_BASELINE_HOOKS,
  ...BASELINE_SUPPORT_FILES,
];

/**
 * Per-hook budget, matching this repo's own registration. The run-state hook
 * itself budgets 500 ms for its POST; 5 s is the harness-level ceiling that
 * keeps a wedged hook from stalling a turn.
 */
export const BASELINE_HOOK_TIMEOUT_SECONDS = 5;

/**
 * Events whose settings.json entries carry a tool-name `matcher`. The rest are
 * lifecycle events that fire unconditionally and take no matcher — mirroring
 * `.minsky/hooks/registry-matcher-pairs.ts`'s `NON_TOOL_SCOPED_EVENTS` distinction.
 */
const TOOL_SCOPED_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
]);

/** The event the transcript-ingest hook registers on. */
const TRANSCRIPT_INGEST_EVENT = "SessionEnd";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Mirrors `.minsky/hooks/dispatch-intent-store.ts`'s `getStateDir()`. */
function getStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    env["XDG_STATE_HOME"] || path.join(env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

/**
 * Where provisioned hooks are installed: `<state-dir>/hooks`. Shared across
 * every Minsky-managed project on the machine.
 */
export function resolveHookInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getStateDir(env), "hooks");
}

/**
 * Locate the compiled baseline hook sources inside the Minsky installation.
 *
 * Mirrors `resolveMigrationsFolder()` (mt#1767): an ordered candidate list
 * ending in a LOUD failure naming every path tried, rather than a silent
 * skip. Provisioning that quietly installs nothing would reproduce exactly the
 * invisible-project bug this task exists to fix.
 *
 * Candidates, first existing wins:
 *   1. `MINSKY_HOOK_SOURCE_DIR` override (errors loud if set but missing).
 *   2. `./hooks` beside the compiled module — the bundled-install layout.
 *   3. `../../../../.claude/hooks` — the dev/source layout: this file sits at
 *      `packages/domain/src/setup/`, so four levels up is the repo root.
 */
export function resolveHookSourceDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["MINSKY_HOOK_SOURCE_DIR"];
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `MINSKY_HOOK_SOURCE_DIR=${override} but that directory does not exist. ` +
          `Point it at a directory containing ${BASELINE_INSTALL_FILES.join(", ")}, or unset it to use the default.`
      );
    }
    return override;
  }

  const candidates = [
    fileURLToPath(new URL("./hooks", import.meta.url)),
    fileURLToPath(new URL("../../../../.claude/hooks", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, OBSERVABILITY_BASELINE_HOOKS[0]))) return candidate;
  }
  throw new Error(
    `Minsky hook sources not found. Tried: ${candidates.join(", ")}. ` +
      `This indicates the installed build does not ship .claude/hooks/. ` +
      `Set MINSKY_HOOK_SOURCE_DIR to an absolute path containing ${BASELINE_INSTALL_FILES.join(", ")}.`
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface HookCommandEntry {
  type: "command";
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

/**
 * Build the `hooks` fragment registering the baseline at `installDir`.
 *
 * Run-state's event set is derived from `OBSERVED_HOOK_EVENTS` — the same
 * constant `mapHookEventToRunState` branches on — so the registration cannot
 * drift from the events the ingest path actually understands.
 */
export function buildBaselineRegistration(installDir: string): Record<string, HookGroup[]> {
  const commandFor = (hookFile: string): HookCommandEntry => ({
    type: "command",
    command: path.join(installDir, hookFile),
    timeout: BASELINE_HOOK_TIMEOUT_SECONDS,
  });

  const registration: Record<string, HookGroup[]> = {};

  for (const event of OBSERVED_HOOK_EVENTS) {
    const group: HookGroup = TOOL_SCOPED_EVENTS.has(event)
      ? { matcher: "*", hooks: [commandFor("record-conversation-run-state.ts")] }
      : { hooks: [commandFor("record-conversation-run-state.ts")] };
    registration[event] = [group];
  }

  const ingestGroup: HookGroup = { hooks: [commandFor("transcript-ingest-on-session-end.ts")] };
  registration[TRANSCRIPT_INGEST_EVENT] = [
    ...(registration[TRANSCRIPT_INGEST_EVENT] ?? []),
    ingestGroup,
  ];

  return registration;
}

/** True when every command in the group points into `installDir` — i.e. it is ours. */
function isMinskyOwnedGroup(group: unknown, installDir: string): boolean {
  if (typeof group !== "object" || group === null) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  return hooks.every(
    (h) =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as { command?: unknown }).command === "string" &&
      (h as { command: string }).command.startsWith(installDir)
  );
}

/**
 * Merge `registration` into an existing settings object.
 *
 * Non-destructive and idempotent: unrelated top-level keys and unrelated hook
 * groups are preserved untouched, and a re-run REPLACES Minsky's own groups
 * rather than appending duplicates (identified by their command path, not by
 * position).
 */
export function mergeHookRegistration(
  current: Record<string, unknown>,
  registration: Record<string, HookGroup[]>,
  installDir: string
): Record<string, unknown> {
  const currentHooks =
    typeof current["hooks"] === "object" && current["hooks"] !== null
      ? ({ ...(current["hooks"] as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  for (const [event, ourGroups] of Object.entries(registration)) {
    const existing = Array.isArray(currentHooks[event]) ? (currentHooks[event] as unknown[]) : [];
    const foreign = existing.filter((g) => !isMinskyOwnedGroup(g, installDir));
    currentHooks[event] = [...foreign, ...ourGroups];
  }

  return { ...current, hooks: currentHooks };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionHooksOptions {
  /** The project being initialized. */
  repoPath: string;
  /** Override the environment used for path resolution (testing). */
  env?: NodeJS.ProcessEnv;
  /** Override where hook sources are read from (testing). */
  sourceDir?: string;
  /** Override where hooks are installed (testing). */
  installDir?: string;
}

export interface ProvisionHooksResult {
  installDir: string;
  settingsPath: string;
  filesInstalled: string[];
  /** Events registered, for the caller's report. */
  eventsRegistered: string[];
}

/** The settings file provisioning writes — personal, gitignored by Claude Code. */
export const PROJECT_LOCAL_SETTINGS_FILENAME = "settings.local.json";

/**
 * Install the observability baseline for `repoPath` and register it.
 *
 * Automatic per ask#6671 (2026-08-01): a project set up with Minsky is
 * observable, with no extra flag. The hooks fail open — they POST to the local
 * cockpit daemon on a 500 ms budget and no-op when it is not running — so a
 * project whose operator never starts the cockpit pays nothing but the spawn.
 */
export async function provisionObservabilityHooks(
  options: ProvisionHooksOptions,
  fileSystem: FsLike = createRealFs()
): Promise<ProvisionHooksResult> {
  const env = options.env ?? process.env;
  const sourceDir = options.sourceDir ?? resolveHookSourceDir(env);
  const installDir = options.installDir ?? resolveHookInstallDir(env);

  // 1. Install the hook files into the Minsky-owned directory.
  await fileSystem.mkdir(installDir, { recursive: true });
  const filesInstalled: string[] = [];
  for (const fileName of BASELINE_INSTALL_FILES) {
    const from = path.join(sourceDir, fileName);
    const to = path.join(installDir, fileName);
    const contents = await fileSystem.readFile(from, "utf-8");
    await fileSystem.writeFile(to, contents);
    // The hooks carry a `#!/usr/bin/env bun` shebang and are invoked by path,
    // so the executable bit is load-bearing. `chmod` is optional on FsLike so
    // in-memory test doubles need not implement it.
    await fileSystem.chmod?.(to, 0o755);
    filesInstalled.push(to);
  }

  // 2. Register them in the project-local settings file, merging.
  const claudeDir = path.join(options.repoPath, ".claude");
  const settingsPath = path.join(claudeDir, PROJECT_LOCAL_SETTINGS_FILENAME);
  await fileSystem.mkdir(claudeDir, { recursive: true });

  let current: Record<string, unknown> = {};
  if (await fileSystem.exists(settingsPath)) {
    const raw = await fileSystem.readFile(settingsPath, "utf-8");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
      // A non-object JSON body (array, string, number) is not a settings file;
      // fall through with `current = {}` and let the merge write a valid one.
    } catch {
      // Unparseable existing file: treat as empty rather than throwing, so a
      // corrupt settings file cannot fail the whole init. The merge below
      // writes a well-formed file.
    }
  }

  const registration = buildBaselineRegistration(installDir);
  const merged = mergeHookRegistration(current, registration, installDir);
  await fileSystem.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);

  return {
    installDir,
    settingsPath,
    filesInstalled,
    eventsRegistered: Object.keys(registration),
  };
}
