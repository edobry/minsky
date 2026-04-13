/**
 * Determine if the current environment supports interactive prompts.
 *
 * Returns false in CI, when --non-interactive is set, or when stdin/stdout aren't TTYs.
 * The MINSKY_NON_INTERACTIVE env var is set by the CLI when --non-interactive flag is used.
 */
export function isInteractive(): boolean {
  if (process.env.MINSKY_NON_INTERACTIVE === "1" || process.env.MINSKY_NON_INTERACTIVE === "true") {
    return false;
  }
  if (process.env.CI === "true" || process.env.CI === "1") {
    return false;
  }
  if (process.env.TERM === "dumb") {
    return false;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return false;
  }
  return true;
}
