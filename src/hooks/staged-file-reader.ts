/**
 * Shared helper for pre-commit checks that need the STAGED (index) content of
 * a file rather than its working-tree content — a partially-staged edit
 * would otherwise make a check pass or fail on the wrong bytes. Extracted
 * from `migration-guard-detector.ts` (mt#3299) so the sibling
 * `duplicate-generated-content-detector.ts` check doesn't re-implement the
 * same `git show :<path>` argv-spawn logic.
 */

/** Read a staged git blob (`git show :<path>`) as text, via argv (no shell). */
export async function readStagedFileContent(
  projectRoot: string,
  filePath: string,
  timeoutMs = 5000
): Promise<string> {
  const proc = Bun.spawn(["git", "-C", projectRoot, "show", `:${filePath}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const textPromise = new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderrText = await new Response(proc.stderr).text();
      throw new Error(
        `git show :${filePath} exited ${exitCode}: ${stderrText.trim() || "no stderr"}`
      );
    }
    return await textPromise;
  } finally {
    clearTimeout(timer);
  }
}
