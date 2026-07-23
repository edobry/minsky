/**
 * mt#3067 regression tests: piped stdout must not be truncated when the
 * process exits immediately after writing.
 *
 * These spawn real child processes with a PIPE for stdout, because that is the
 * only configuration that reproduces the bug — an in-process assertion cannot
 * observe it (writes to a file, and writes in a process that does not exit,
 * were never lossy).
 *
 * The suite deliberately includes a NEGATIVE CONTROL (`without the patch`):
 * a regression test for this bug is worthless unless it can actually see the
 * bug, and the pre-fix behavior is what it must see.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** Comfortably above the 64 KiB boundaries the truncation lands on. */
const PAYLOAD_BYTES = 1024 * 1024;

/** Repo root, from `packages/shared/src/` — child processes resolve imports from here. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Run a child that writes `PAYLOAD_BYTES` to stdout and then immediately calls
 * `process.exit(0)`, capturing stdout through a PIPE. Returns the byte count
 * that actually survived.
 */
async function pipedByteCount(options: { withPatch: boolean }): Promise<number> {
  const enable = options.withPatch
    ? 'const m = await import("@minsky/shared/stdout-sync"); m.enableSynchronousStdout();'
    : "";

  const source = `
    ${enable}
    process.stdout.write("x".repeat(${PAYLOAD_BYTES}));
    process.exit(0);
  `;

  const child = Bun.spawn(["bun", "-e", source], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;

  if (stdout.length === 0 && stderr.length > 0) {
    throw new Error(`child produced no stdout; stderr was: ${stderr.slice(0, 500)}`);
  }
  return stdout.length;
}

describe("enableSynchronousStdout (mt#3067)", () => {
  test("negative control: without the patch, piped stdout IS truncated on exit", async () => {
    const bytes = await pipedByteCount({ withPatch: false });

    // The bug: the child wrote a full payload but the pipe received less.
    expect(bytes).toBeLessThan(PAYLOAD_BYTES);
    // And it truncates on a 64 KiB boundary rather than at an arbitrary point,
    // which is what identifies this as a buffer-drain race and not corruption.
    expect(bytes % (64 * 1024)).toBe(0);
  }, 30000);

  test("with the patch, the full payload survives the pipe", async () => {
    const bytes = await pipedByteCount({ withPatch: true });

    expect(bytes).toBe(PAYLOAD_BYTES);
  }, 30000);

  test("a reader that closes early (EPIPE) does not crash the writer", async () => {
    // `head -c 10` closes the pipe after 10 bytes. The synchronous writer must
    // swallow the resulting EPIPE exactly as a stream would.
    const source = `
      const m = await import("@minsky/shared/stdout-sync");
      m.enableSynchronousStdout();
      process.stdout.write("x".repeat(${PAYLOAD_BYTES}));
      process.exit(0);
    `;
    const proc = Bun.spawn(["sh", "-c", `bun -e '${source.replace(/'/g, "'\\''")}' | head -c 10`], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout.length).toBe(10);
  }, 30000);
});
