/**
 * Compile Operation
 *
 * Top-level operation that the CLI adapter calls. Encapsulates target lookup,
 * stale-check routing, and dry-run handling.
 */

import { resolveWorkspacePath } from "../workspace";
import { createMinskyCompileService } from "./compile-service";
import type { MinskyCompileServiceResult } from "./compile-service";

export interface RunMinskyCompileOptions {
  /** Target to compile. Defaults to "claude-skills". */
  target?: string;
  /** Override output path/directory. */
  output?: string;
  /** Print content without writing files. */
  dryRun?: boolean;
  /** Exit non-zero if output is stale. Does not write files. */
  check?: boolean;
  /** Workspace path (resolved automatically if omitted). */
  workspacePath?: string;
}

export async function runMinskyCompile(
  options: RunMinskyCompileOptions
): Promise<MinskyCompileServiceResult> {
  const workspacePath = options.workspacePath ?? (await resolveWorkspacePath({}));

  const targetId = options.target ?? "claude-skills";
  const compileService = createMinskyCompileService();

  if (!compileService.getTarget(targetId)) {
    throw new Error(
      `Unknown compile target: "${targetId}". Available targets: ${compileService.getAvailableTargets().join(", ")}`
    );
  }

  return compileService.compile(targetId, {
    workspacePath,
    outputPath: options.output,
    dryRun: options.dryRun,
    check: options.check,
  });
}
