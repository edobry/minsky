#!/usr/bin/env bun
/**
 * mt#4954 SC2 — pin WHICH root a hook's own module path resolves to.
 *
 * ## What this answers, and why it needed a probe
 *
 * `deriveHookRepoRoot()` (`.minsky/hooks/types.ts`) is `findRepoRoot(import.meta.dir)`, and it is
 * used as the AUTHORITATIVE `projectDir` tier by calibration writers. mt#4885's planning pass
 * raised, and could not settle, whether that root is stable: a Minsky session workspace is a full
 * git clone that carries its OWN `.claude/hooks/` tree (verified: all 31 live session workspaces
 * have one, plus their own `.claude/settings.json` with 165 hook files), so if a CLONE's hook file
 * is the one executing, `import.meta.dir` resolves to the clone and the "stable root" property
 * fails.
 *
 * **The telemetry cannot answer it.** The only `deriveHookRepoRoot()` writer with a project-keyed
 * stream, `coverage-claim-path`, has ONE record ever — so its absence from session-derived keys is
 * a probe that cannot fail (mem#704), not evidence of stability. The other three users
 * (`warn-main-workspace-mutation`, which by construction only fires when cwd IS main;
 * `warn-stale-forward-reference`; `block-git-gh-cli`) write no strandable stream either.
 *
 * **So the answer comes from the REGISTRATION, not from the exhaust.** Every hook command in
 * `.claude/settings.json` is registered as `$CLAUDE_PROJECT_DIR/.claude/hooks/<name>.ts` — an
 * env-var-rooted absolute path — in the main repo AND in every session clone. The executing file
 * is therefore selected by `CLAUDE_PROJECT_DIR`, not by cwd and not by which `settings.json` was
 * read.
 *
 * **Consequence, which is the finding:** `deriveHookRepoRoot()` is NOT an independent stable root.
 * It is `CLAUDE_PROJECT_DIR` reached by a filesystem route instead of an env read — the same tier,
 * one indirection over. Anything relying on it as a root that outranks `CLAUDE_PROJECT_DIR` is
 * relying on an identity, not a precedence.
 *
 * ## What this script checks
 *
 * The invariant that makes the above true, so a future edit cannot silently break it: every
 * `command` in `.claude/settings.json` that points into the hook tree is `$CLAUDE_PROJECT_DIR`-
 * rooted. A bare relative path (`.claude/hooks/foo.ts`) would resolve against the harness's cwd
 * instead, reintroducing exactly the clone-vs-main ambiguity this probe closed.
 *
 * Exit 0 = every hook command is env-rooted. Exit 1 = at least one is not (the finding).
 * Exit 2 = the check could not run (settings.json unreadable) — never conflated with a pass.
 */
import { readFileSync } from "fs";
import { join } from "path";

/** The prefix every hook registration must carry for the root to be env-determined. */
const REQUIRED_PREFIX = "$CLAUDE_PROJECT_DIR/";

/** Marks a command as pointing into the hook tree at all (vs. some unrelated shell command). */
const HOOK_TREE_MARKER = ".claude/hooks/";

interface Finding {
  readonly command: string;
  readonly reason: string;
}

/**
 * Walk an arbitrary settings.json shape collecting every `command` string.
 *
 * Deliberately structure-agnostic: the settings schema nests hooks under
 * `hooks.<Event>[].hooks[].command`, and that shape is the harness's to change. Collecting by KEY
 * rather than by path means a schema reshuffle cannot silently empty this check — which is the
 * failure mode that would make it pass vacuously.
 */
export function collectCommands(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectCommands(item, out);
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "command" && typeof value === "string") out.push(value);
      else collectCommands(value, out);
    }
  }
  return out;
}

/** Classify one command. Returns null when the command is fine or out of scope. */
export function checkCommand(command: string): Finding | null {
  if (!command.includes(HOOK_TREE_MARKER)) return null; // not a hook-tree invocation
  if (command.includes(REQUIRED_PREFIX)) return null;
  return {
    command,
    reason:
      "hook-tree command is not $CLAUDE_PROJECT_DIR-rooted, so its module path — and therefore " +
      "deriveHookRepoRoot() — would resolve against the harness cwd rather than the project root",
  };
}

export function auditSettings(raw: string): { total: number; findings: Finding[] } {
  const parsed: unknown = JSON.parse(raw);
  const commands = collectCommands(parsed);
  const hookCommands = commands.filter((c) => c.includes(HOOK_TREE_MARKER));
  const findings = hookCommands.map(checkCommand).filter((f): f is Finding => f !== null);
  return { total: hookCommands.length, findings };
}

function main(): void {
  const settingsPath = join(process.cwd(), ".claude", "settings.json");
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch (err) {
    // Exit 2, never 0: "could not check" and "checked, clean" are different findings.
    console.error(`[verify-hook-root-resolution] cannot read ${settingsPath}: ${String(err)}`);
    process.exit(2);
  }

  let audit: { total: number; findings: Finding[] };
  try {
    audit = auditSettings(raw);
  } catch (err) {
    console.error(`[verify-hook-root-resolution] cannot parse ${settingsPath}: ${String(err)}`);
    process.exit(2);
  }

  if (audit.total === 0) {
    // An empty roster is the vacuous pass this check exists to avoid reporting as success.
    console.error(
      "[verify-hook-root-resolution] no hook-tree commands found in .claude/settings.json — " +
        "the roster is empty, which is a broken check rather than a clean result"
    );
    process.exit(2);
  }

  if (audit.findings.length > 0) {
    console.error(
      `[verify-hook-root-resolution] ${audit.findings.length} of ${audit.total} hook commands are not $CLAUDE_PROJECT_DIR-rooted:`
    );
    for (const f of audit.findings) console.error(`  - ${f.command}\n    ${f.reason}`);
    process.exit(1);
  }

  console.log(
    `[verify-hook-root-resolution] OK — all ${audit.total} hook-tree commands are $CLAUDE_PROJECT_DIR-rooted; ` +
      "deriveHookRepoRoot() resolves to the project root the harness names, not to the cwd."
  );
}

if (import.meta.main) main();
