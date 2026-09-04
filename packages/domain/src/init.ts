import * as path from "path";
import { z } from "zod";
import { enumSchemas } from "./configuration/schemas/base";
import { createDirectoryIfNotExists, createFileIfNotExists } from "./init/file-system";
import type { FsLike } from "./interfaces/fs-like";
import { createRealFs } from "./interfaces/real-fs";
import { getMinskyConfigContentYaml } from "./init/config-content";
import { mergeProjectConfigYaml, preservedTopLevelKeys } from "./init/config-merge";
import { generateRulesWithTemplateSystem } from "./init/rule-templates";
import { RULE_FORMAT_OUTPUT_DIR } from "./rules/types";
import { runMinskyCompile } from "./compile/compile";
/**
 * The per-target rule accounting {@link initializeProject} consumes (mt#4770).
 *
 * Declared here rather than as a `Pick<>` of the compile service's result so
 * this seam — and the tests that stub it — do not have to know the compile
 * service's typing (PR #3489 R1). The tie to the real pipeline is still
 * enforced by the compiler: the default `compileForHarness` below returns
 * `runMinskyCompile`'s result directly, so if `MinskyCompileServiceResult`
 * ever stops carrying these two fields, that assignment fails typecheck.
 */
export interface HarnessCompileAccounting {
  definitionsIncluded: string[];
  definitionsSkipped: string[];
}
import {
  resolveRepositoryFromGitRemote,
  type ResolvedRepositoryConfig,
} from "./session/repository-backend-detection";
import { performSetup } from "./setup";
import { provisionObservabilityHooks } from "./setup/hook-provisioning";
import { resolveInitClient } from "./runtime/harness-detection";
import { log } from "./utils/logger";

export type { ResolvedRepositoryConfig } from "./session/repository-backend-detection";

/**
 * Detects the repository backend configuration from the git remote URL at the given path.
 * Convenience wrapper around resolveRepositoryFromGitRemote for use in init commands.
 */
export function detectRepositoryBackend(repoPath: string): ResolvedRepositoryConfig {
  return resolveRepositoryFromGitRemote(repoPath);
}

// Re-export content helpers for consumers that may reference them
export { getMinskyConfigContentYaml } from "./init/config-content";
export {
  getMinskyRuleContent,
  getRulesIndexContent,
  generateRulesWithTemplateSystem,
} from "./init/rule-templates";

export const initializeProjectParamsSchema = z.object({
  repoPath: z.string(),
  backend: enumSchemas.backendType,
  ruleFormat: z.enum(["cursor", "generic", "minsky"] as const),
  mcp: z
    .object({
      enabled: z.boolean().optional().default(true),
      transport: z.enum(["stdio", "sse", "httpStream"]).optional().default("stdio"),
      port: z.number().optional(),
      host: z.string().optional(),
    })
    .optional(),
  overwrite: z.boolean().optional().default(false),
  repository: z
    .object({
      backend: z.enum(["github", "gitlab", "local"]),
      url: z.string().optional(),
      github: z
        .object({
          owner: z.string(),
          repo: z.string(),
        })
        .optional(),
    })
    .optional(),
});

export type InitializeProjectParams = z.infer<typeof initializeProjectParamsSchema>;

/**
 * The interface-agnostic function for initializing a project with Minsky configuration.
 * This function acts as the primary domain function for the init command.
 */
export async function initializeProjectFromParams(params: InitializeProjectParams): Promise<void> {
  // Validate the parameters
  const validatedParams = initializeProjectParamsSchema.parse(params);

  // Call the original initialization function
  return initializeProject(validatedParams);
}

export interface InitializeProjectOptions {
  repoPath: string;
  backend: z.infer<typeof enumSchemas.backendType>;
  ruleFormat: "cursor" | "generic" | "minsky";
  mcp?: {
    enabled: boolean;
    transport?: "stdio" | "sse" | "httpStream";
    port?: number;
    host?: string;
  };
  overwrite?: boolean;
  repository?: ResolvedRepositoryConfig;
}

/**
 * Orchestrates project initialization in two phases:
 *
 * Phase 1 (project-init): Creates project-level files checked into the repo —
 *   .minsky/config.yaml (with mcp section), process/tasks/ dir, rules directory,
 *   rule files. No harness-specific files.
 *
 * Phase 2 (developer-setup): Calls performSetup() to handle developer-local
 *   configuration — MCP client registration (.cursor/mcp.json) and
 *   .minsky/config.local.yaml with workspace.mainPath and harness field.
 *   Skipped when mcp.enabled is false.
 */
/**
 * Injectable collaborators for {@link initializeProject} (mt#4715).
 *
 * `compileForHarness` exists as a SEAM rather than a direct `runMinskyCompile`
 * call because that function resolves and writes through the REAL filesystem,
 * while `initializeProject` is otherwise driven by an injected {@link FsLike}.
 * Calling it unguarded would make a unit test with a mock filesystem reach the
 * actual repo — so the collaborator is handed in instead of reached for, per
 * `testing-standards.mdc §Testable Design`.
 */
export interface InitializeProjectDeps {
  /**
   * Compile one target into `workspacePath`. Defaults to the real pipeline.
   *
   * Returns the target's per-rule accounting (mt#4770). This used to be
   * `Promise<void>`: the result was awaited and discarded, so init could not
   * tell whether the rules it had just scaffolded actually landed anywhere the
   * running harness reads.
   *
   * **Every supplier of this seam is in-repo and enumerable** — `@minsky/domain`
   * is `private: true` and never published, and the only sites passing it are
   * this package's own tests (PR #3489 R1 adoption sweep). A caller that omits
   * `deps` entirely, which is every production call site, is unaffected.
   */
  compileForHarness?: (target: string, workspacePath: string) => Promise<HarnessCompileAccounting>;
  /** Which MCP client / harness is running init. Defaults to real detection. */
  resolveClient?: () => string;
  /**
   * Operator-facing warning sink (mt#4770). Defaults to `log.cliWarn`.
   *
   * Injected for the same reason `compileForHarness` is: the messages below
   * are the observable behavior under test, and the alternative is patching
   * the logger module the function reaches itself — the shape
   * `testing-standards.mdc §Testable Design` tells us to treat as design
   * feedback rather than work around with a spy.
   */
  warn?: (message: string) => void;
}

export async function initializeProject(
  { repoPath, backend, ruleFormat, mcp, overwrite = false, repository }: InitializeProjectOptions,
  fileSystem: FsLike = createRealFs(),
  deps: InitializeProjectDeps = {}
): Promise<void> {
  const resolveClient = deps.resolveClient ?? resolveInitClient;
  const warn = deps.warn ?? ((message: string) => log.cliWarn(message));
  const compileForHarness =
    deps.compileForHarness ??
    (async (target: string, workspacePath: string) => runMinskyCompile({ target, workspacePath }));
  // Resolved ONCE and reused: the rule-scaffolding step below and performSetup
  // must agree about which harness is running, or a project could be scaffolded
  // for one client and registered with another.
  const initClient = resolveClient();
  // === Phase 1: Project initialization ===

  // Create process/tasks directory structure
  const tasksDir = path.join(repoPath, "process", "tasks");
  await createDirectoryIfNotExists(tasksDir, fileSystem);

  // Initialize the tasks backend based on user selection
  switch (backend) {
    case "github-issues":
      // GitHub Issues backend uses external GitHub repository - no local files needed
      // Configuration will be set up in the config file below
      break;

    case "minsky":
      // Minsky backend uses database - no task files needed
      // Database configuration will be set up in the config file below
      break;

    default:
      throw new Error(`Backend "${backend}" is not supported.`);
  }

  // Create rule file directory.
  //
  // mt#4714: the format→directory mapping is `RULE_FORMAT_OUTPUT_DIR` — the SAME
  // constant `RuleTemplateService.getOutputDir` uses, so init can no longer
  // disagree with it. This was a two-way ternary (`=== "cursor" ? .cursor/rules
  // : .ai/rules`), which sent `ruleFormat: "minsky"` to `.ai/rules` — the
  // `generic` location — while every other consumer resolved it to
  // `.minsky/rules`.
  //
  // The resolved path is still passed to `generateRulesWithTemplateSystem` as an
  // explicit `outputDir` rather than letting the service resolve it. That is
  // deliberate and NOT the override the bug was about: the mapping is now shared,
  // so the explicit value cannot diverge. Dropping the argument entirely would
  // also require reshaping that function, which derives the service's
  // `workspacePath` from this very path (`path.dirname` twice) — mt#4715 reworks
  // this call path and is the right place for it.
  const rulesDirPath = path.join(repoPath, ...RULE_FORMAT_OUTPUT_DIR[ruleFormat].split("/"));
  await createDirectoryIfNotExists(rulesDirPath, fileSystem);

  // Generate rules using template system (tolerate missing command registry in tests)
  try {
    await generateRulesWithTemplateSystem(
      rulesDirPath,
      ruleFormat,
      overwrite,
      mcp?.enabled ?? false
    );
  } catch (_e) {
    // Skip rule generation when the command registry isn't available (unit tests)
  }

  // mt#4715: scaffolding SOURCES is only half the job. `ruleFormat` picks a
  // directory, and Claude Code reads NONE of the three it can pick — it reads
  // `CLAUDE.md` and `.claude/rules`, which the compile pipeline produces FROM
  // `.minsky/rules/*.mdc` sources. Those are exactly what the step above just
  // wrote (`getRulePath` emits `<id>.mdc`, bodies carry YAML frontmatter), so
  // this is a wiring step, not a format conversion. Without it a Claude Code
  // project is scaffolded with files its own harness never opens.
  //
  // Only the two channels Claude Code actually implements are compiled
  // (mt#3107): `claude.md` for the always-apply corpus and `claude-rules` for
  // path-scoped `.claude/rules/<id>.md`. Cursor's other two rule types have no
  // delivery mechanism here, so emitting more targets would write files nothing
  // reads — the very defect this step removes.
  //
  // Gated on the FORMAT as well as the harness (PR #3431 R1). The compile
  // pipeline reads `.minsky/rules` (ADR-016), which is where sources land only
  // under `ruleFormat: "minsky"`. An explicit `--rule-format cursor` under
  // Claude Code puts them in `.cursor/rules` instead — compiling then reads an
  // empty directory and produces nothing, so the project would end up with
  // neither the Cursor files it asked for nor the Claude ones it cannot use.
  // Channel note (mt#4770). Every operator-facing message in this block uses
  // `log.cliWarn`, never `log.warn`. `log.warn` routes through
  // `emitDiagnostic` (`packages/shared/src/logger.ts`), which DISCARDS in HUMAN
  // mode when stderr is a terminal — i.e. exactly the interactive `minsky init`
  // these messages are written for. That is mt#3119's finding, and it is why
  // the two warnings here were invisible to the operator they addressed. This
  // is the init surface only; the compile pipeline's own `SkipLogFn` default
  // still uses `log.warn` and stays mt#3119's to fix.
  const sourcesAreWhereCompileReads = ruleFormat === "minsky";
  if (initClient === "claude-code" && !sourcesAreWhereCompileReads) {
    warn(
      `minsky init: --rule-format "${ruleFormat}" writes rules to ` +
        `${RULE_FORMAT_OUTPUT_DIR[ruleFormat]}, which Claude Code does not read, so no ` +
        `CLAUDE.md was generated. Re-run with --rule-format minsky for the Claude Code layout.`
    );
  }
  if (initClient === "claude-code" && sourcesAreWhereCompileReads) {
    // mt#4770: scaffolding the sources and compiling them is STILL not the
    // whole job — a rule can compile cleanly into NEITHER Claude Code target
    // and leave no trace of having done so, which is how a fresh project ends
    // up with a 90-byte CLAUDE.md, an empty .claude/rules, and no signal that
    // anything is wrong. An empty ruleset is otherwise indistinguishable from
    // a correctly-tiered one.
    //
    // Reachability is READ from the pipeline's own per-rule accounting, not
    // re-derived here: `buildClaudeRulesContent` already records every rule
    // failing `isEligibleForClaudeRules` in `definitionsSkipped`, and
    // `buildClaudeMdContent` records every non-ALWAYS_APPLY rule the same way.
    // Re-applying those two predicates at this call site would be a second
    // source of truth that a later change to either one could silently falsify.
    const reachable = new Set<string>();
    const compiled = new Set<string>();
    let accountingComplete = true;

    for (const target of ["claude.md", "claude-rules"]) {
      try {
        const result = await compileForHarness(target, repoPath);
        for (const id of result.definitionsIncluded ?? []) {
          reachable.add(id);
          compiled.add(id);
        }
        for (const id of result.definitionsSkipped ?? []) {
          compiled.add(id);
        }
      } catch (error) {
        // SURFACED, not swallowed (mt#4715 SC5). `init` must still succeed —
        // a project with sources but no compiled output is recoverable by
        // running `minsky compile` — but a silently un-scaffolded project is
        // the defect, not the mitigation (`work-completion.mdc §Invocation
        // path`), so the failure has to reach someone.
        accountingComplete = false;
        warn(
          `minsky init: could not compile "${target}" for claude-code. The rule sources in ` +
            `.minsky/rules were written; run \`minsky compile\` to produce CLAUDE.md and ` +
            `.claude/rules. Cause: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Assert unreachability ONLY when both targets actually reported (SC3). A
    // rule absent because a target THREW is not evidence that it is
    // ineligible — the per-target failure above already covers that case, and
    // stacking an "unreachable" claim on top of it would state a conclusion
    // this run cannot support.
    if (accountingComplete) {
      const unreachable = [...compiled].filter((id) => !reachable.has(id)).sort();
      if (unreachable.length > 0) {
        warn(
          `minsky init: ${unreachable.length} scaffolded rule(s) are not reachable by Claude ` +
            `Code — ${unreachable.join(", ")}. They were written to .minsky/rules, but land in ` +
            `neither CLAUDE.md (which carries rules marked alwaysApply: true) nor .claude/rules ` +
            `(which carries rules that declare globs). Nothing in Claude Code retrieves them ` +
            `automatically; an agent has to ask for one by name with \`rules_get <name>\`.`
        );
      }
    }
  }

  // Create main Minsky configuration file with user's backend choice
  const minskyDir = path.join(repoPath, ".minsky");
  await createDirectoryIfNotExists(minskyDir, fileSystem);

  const configPath = path.join(minskyDir, "config.yaml");
  const mcpForConfig =
    mcp?.enabled !== false
      ? { transport: mcp?.transport, port: mcp?.port, host: mcp?.host }
      : undefined;
  // Pass repoPath so getMinskyConfigContentYaml can auto-derive the project slug
  // from the git remote (mt#2414). Falls back gracefully when no remote exists.
  // `mcpForConfig` is NOT passed here any more (mt#4699) — it now goes to
  // performSetup below, which writes it to the machine-local overlay instead of
  // the committed config.
  const configContent = getMinskyConfigContentYaml(backend, repository, {
    repoPath,
  });

  // mt#4866 SC2: `--overwrite` MERGES rather than replaces. `init` returns early
  // when the config exists and `--overwrite` is absent, so this is the only
  // re-init path — and it used to delete every top-level key `init` does not
  // emit. Measured: a `rules:` block AND an unrelated key both vanished.
  //
  // The merge lives here, in `init`, rather than in `getMinskyConfigContentYaml`
  // (SC2 is explicit about this): the generator's job is to say what the vendor
  // owns, and teaching it about `rules:` would make it own a key it does not
  // emit. It also must NOT change `createFileIfNotExists`, whose other callers
  // (`setup.ts`, `mcp/registration.ts`, and every rule-file write in this
  // function) rely on plain overwrite semantics.
  let existingConfigYaml: string | null = null;
  if (overwrite && (await fileSystem.exists(configPath))) {
    try {
      existingConfigYaml = await fileSystem.readFile(configPath, "utf8");
    } catch (error) {
      // Readable-but-not-readable is not a reason to abort a re-init, but it IS
      // a reason to say so: merging is what preserves the user's keys, and
      // falling back to a plain overwrite silently would reintroduce the exact
      // data loss this block exists to prevent.
      warn(
        `minsky init: could not read the existing ${configPath} to merge into, so ` +
          `--overwrite will replace it and any keys minsky init does not emit will be ` +
          `lost. Cause: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const mergedConfigContent = mergeProjectConfigYaml(existingConfigYaml, configContent);
  const preserved = preservedTopLevelKeys(existingConfigYaml, configContent);
  if (preserved.length > 0) {
    log.debug("minsky init: preserved existing top-level config keys across --overwrite", {
      configPath,
      preserved,
    });
  }

  await createFileIfNotExists(configPath, mergedConfigContent, overwrite, fileSystem);

  // === Phase 2: Developer-local setup ===
  // Skipped when MCP is explicitly disabled (e.g. in tests or non-MCP workflows).
  // performSetup() writes .minsky/config.local.yaml (with harness field) and
  // registers Minsky with the MCP client (e.g. .cursor/mcp.json).
  if (mcp?.enabled !== false) {
    // mt#4676: resolve the harness from the environment (CLAUDECODE=1, etc.)
    // before falling back to filesystem installed-ness, rather than
    // hardcoding "cursor" regardless of what is actually running `init`.
    // mt#4699: hand the MCP options straight to performSetup rather than
    // routing them through the committed config.yaml it used to read them
    // back out of. They land in `.minsky/config.local.yaml`, which is where
    // machine-scope settings belong.
    await performSetup(
      // `initClient`, not a second resolveInitClient() call (mt#4715): rule
      // scaffolding above already branched on it, and two independent
      // resolutions could disagree.
      { repoPath, client: initClient, overwrite, mcp: mcpForConfig },
      fileSystem
    );

    // Install the observability baseline so this project's conversations are
    // visible to cockpit attach + presence (mt#3499). Automatic, per ask#6671.
    // Developer-local like the rest of Phase 2: the hooks register in
    // `.claude/settings.local.json` and install into a Minsky-owned state
    // directory, so nothing lands in the project's committed tree.
    //
    // Non-fatal: a project that is otherwise correctly initialized must not
    // fail `init` because instrumentation could not be installed. The failure
    // is surfaced, not swallowed — a silently un-instrumented project is the
    // exact bug this provisioning exists to fix, so it must never look like
    // success.
    try {
      await provisionObservabilityHooks({ repoPath }, fileSystem);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // mt#4770: `warn`, not `log.warn` — the comment above says this "must
      // never look like success", which is exactly what `log.warn` produces in
      // HUMAN mode. Same class as the rule-reachability messages; see the
      // channel note above.
      warn(
        `Minsky observability hooks were NOT installed: ${reason}\n` +
          `The project is initialized, but its conversations will not appear in the cockpit ` +
          `(attach and presence will read UNKNOWN). Re-run 'minsky init' after resolving the above.`
      );
    }
  }
}
