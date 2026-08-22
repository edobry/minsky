/**
 * Shared agent compile target (mt#3854)
 *
 * `claude-agents` and `codex-agents` read the same sources — the
 * `.minsky/agents/<name>/agent.ts` definition modules — validate them the same
 * way, and differ only in what they SERIALIZE the validated definition to:
 * Markdown-with-frontmatter for Claude, TOML for Codex.
 *
 * Discovery, dynamic import, schema validation and the dirName↔agent.name
 * invariant therefore live here once. Extracted from `claude-agents.ts`
 * (behaviour preserved exactly) for the same reason `hook-copy-target.ts` was:
 * mt#3854 exists because a hand-made second copy of the harness config drifted,
 * and answering that with a second copy of the target would move the drift into
 * code rather than remove it.
 *
 * The per-harness serializer is the injected part, because it is the only part
 * that genuinely differs.
 *
 * @see mt#3854 — the extraction and the codex sibling
 * @see mt#2280 / ADR-016 — compile pipeline convergence
 */

import { join } from "path";
import realFs from "fs/promises";
import { agentDefinitionSchema } from "../../definitions/schemas";
import type { AgentDefinition } from "../../definitions/types";
import type {
  MinskyCompileTarget,
  MinskyCompileResult,
  MinskyTargetOptions,
  MinskyCompileFsDeps,
} from "../types";

/** Injectable dynamic import — overridden in tests. */
export type DynamicImportFn = (path: string) => Promise<unknown>;

export const realDynamicImport: DynamicImportFn = (path: string) => import(path);

/**
 * Source directory where agents are authored — the same for every harness.
 * Pattern: `.minsky/agents/<name>/agent.ts`
 */
export function agentSourceDir(workspacePath: string): string {
  return join(workspacePath, ".minsky", "agents");
}

/**
 * Discover the names of sub-directories under `.minsky/agents/` that contain an
 * `agent.ts` file.
 */
export async function discoverAgentDirNames(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<string[]> {
  const sourceDir = agentSourceDir(workspacePath);
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return [];
  }

  const agentDirNames: string[] = [];
  for (const entry of entries) {
    const agentTsPath = join(sourceDir, entry, "agent.ts");
    try {
      await fs.access(agentTsPath);
      agentDirNames.push(entry);
    } catch {
      // No agent.ts here — skip
    }
  }
  return agentDirNames;
}

/**
 * Load and validate an agent definition from an imported module.
 * Accepts both `export default defineAgent(...)` and named `export { agent }`.
 */
export function extractAgentDefinition(
  mod: unknown,
  sourcePath: string
): { agent: AgentDefinition } | { error: string } {
  if (typeof mod !== "object" || mod === null) {
    return { error: `Module at ${sourcePath} did not export an object` };
  }

  const candidate =
    (mod as Record<string, unknown>)["default"] ?? (mod as Record<string, unknown>)["agent"];

  if (candidate === undefined) {
    return {
      error: `Module at ${sourcePath} has no default export or named 'agent' export`,
    };
  }

  const parsed = agentDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: `Invalid agent definition at ${sourcePath}: ${parsed.error.message}`,
    };
  }

  return { agent: parsed.data as AgentDefinition };
}

// ---------------------------------------------------------------------------
// Target factory
// ---------------------------------------------------------------------------

export interface AgentTargetConfig {
  /** Machine identifier, e.g. `"claude-agents"`. */
  id: string;
  /** Human-readable display name, e.g. `"Claude Agents"`. */
  displayName: string;
  /** Path segments below the workspace root for the output directory. */
  outputDirSegments: readonly string[];
  /** Output file extension INCLUDING the dot, e.g. `".md"` or `".toml"`. */
  outputExtension: string;
  /**
   * True when the output directory also holds hand-authored files, so `--check`
   * must skip orphan detection there. `.claude/agents/` is shared; a harness
   * directory Minsky generates wholesale is not.
   */
  sharedOutputDirectory: boolean;
  /** Serialize a validated definition to this harness's on-disk format. */
  buildContent(agent: AgentDefinition): string;
}

/** Build an agent target for one harness, injecting a dynamic-import fn for tests. */
export function makeAgentTarget(
  config: AgentTargetConfig,
  dynamicImport: DynamicImportFn = realDynamicImport
): MinskyCompileTarget {
  const outputDir = (workspacePath: string): string =>
    join(workspacePath, ...config.outputDirSegments);
  const outputPath = (workspacePath: string, agentName: string): string =>
    join(outputDir(workspacePath), `${agentName}${config.outputExtension}`);

  return {
    id: config.id,
    displayName: config.displayName,
    sharedOutputDirectory: config.sharedOutputDirectory,

    defaultOutputPath(workspacePath: string): string {
      return outputDir(workspacePath);
    },

    async listOutputFiles(
      _options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<string[]> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverAgentDirNames(workspacePath, fs);
      return dirNames.map((name) => outputPath(workspacePath, name));
    },

    async compile(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<MinskyCompileResult> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverAgentDirNames(workspacePath, fs);

      const filesWritten: string[] = [];
      const definitionsIncluded: string[] = [];
      const definitionsSkipped: string[] = [];
      const contentsByPath = new Map<string, string>();
      const dryRunParts: string[] = [];

      for (const dirName of dirNames) {
        const sourcePath = join(agentSourceDir(workspacePath), dirName, "agent.ts");

        let mod: unknown;
        try {
          mod = await dynamicImport(sourcePath);
        } catch {
          definitionsSkipped.push(dirName);
          continue;
        }

        const extracted = extractAgentDefinition(mod, sourcePath);
        if ("error" in extracted) {
          definitionsSkipped.push(dirName);
          continue;
        }

        const { agent } = extracted;
        // Enforce dirName === agent.name. Without this invariant, compile output
        // would live at `<outputDir>/<agent.name><ext>` but `listOutputFiles`
        // (which only sees dirNames) would expect `<outputDir>/<dirName><ext>`,
        // causing `--check` to always flag the target as stale. Keeping them in
        // lockstep is simpler than making listOutputFiles load every definition
        // just to discover the real name.
        if (dirName !== agent.name) {
          definitionsSkipped.push(dirName);
          continue;
        }

        const target = outputPath(workspacePath, agent.name);
        const content = config.buildContent(agent);

        if (options.dryRun) {
          contentsByPath.set(target, content);
          dryRunParts.push(`// ${target}\n${content}`);
        } else {
          await fs.mkdir(outputDir(workspacePath), { recursive: true });
          await fs.writeFile(target, content, "utf-8");
        }

        filesWritten.push(target);
        definitionsIncluded.push(agent.name);
      }

      return {
        target: config.id,
        filesWritten,
        definitionsIncluded,
        definitionsSkipped,
        content: options.dryRun ? dryRunParts.join("\n\n") : undefined,
        contentsByPath: options.dryRun ? contentsByPath : undefined,
      };
    },
  };
}
