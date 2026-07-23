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
 *
 * Payload size is pinned ABOVE the task's 5 MB success criterion, not merely
 * above the observed 64 KiB truncation boundary — a fix that happened to work
 * at 1 MiB but not at 6 MiB would still fail the criterion.
 *
 * File-vs-pipe comparison is done by having the CHILD write the file and
 * report its size, so this test never imports `node:fs` (which would trip
 * `custom/no-real-fs-in-tests`).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** 6 MiB — comfortably above the task's "at least 5 MB" success criterion. */
const PAYLOAD_BYTES = 6 * 1024 * 1024;

/** Repo root, from `packages/shared/src/` — child processes resolve imports from here. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Source for a child that writes the payload to stdout and exits immediately. */
function childSource(options: { withPatch: boolean }): string {
  const enable = options.withPatch
    ? 'const m = await import("@minsky/shared/stdout-sync"); m.enableSynchronousStdout();'
    : "";
  return `
    ${enable}
    process.stdout.write("x".repeat(${PAYLOAD_BYTES}));
    process.exit(0);
  `;
}

/** Run the child with stdout on a PIPE; return how many bytes survived. */
async function pipedByteCount(options: { withPatch: boolean }): Promise<number> {
  const child = Bun.spawn(["bun", "-e", childSource(options)], {
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

/**
 * Run the child with stdout redirected to a FILE and return the file's byte
 * count, as measured by the shell (`wc -c`) rather than by this process.
 */
async function fileByteCount(options: { withPatch: boolean }): Promise<number> {
  const inner = childSource(options).replace(/'/g, "'\\''");
  const script = `f=$(mktemp); bun -e '${inner}' > "$f"; wc -c < "$f"; rm -f "$f"`;

  const proc = Bun.spawn(["sh", "-c", script], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  const parsed = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`could not read file byte count from shell output: ${JSON.stringify(out)}`);
  }
  return parsed;
}

describe("enableSynchronousStdout (mt#3067)", () => {
  test("negative control: without the patch, piped stdout IS truncated on exit", async () => {
    const bytes = await pipedByteCount({ withPatch: false });

    // This control exists so the suite can demonstrate it actually SEES the
    // bug — a regression test that passes against the broken state is worse
    // than no test (the mt#3046 lesson).
    //
    // Only the FACT of truncation is asserted, not WHERE it lands. The
    // truncation offset is platform-dependent: macOS cuts on exact 64 KiB
    // buffer boundaries, while Linux CI cuts at an arbitrary offset (an
    // earlier revision asserted `bytes % 65536 === 0` and failed CI with a
    // remainder of 59200). Data loss is the property that matters and is
    // reproducible on both.
    expect(bytes).toBeLessThan(PAYLOAD_BYTES);
  }, 60000);

  test("with the patch, the full payload survives the pipe", async () => {
    const bytes = await pipedByteCount({ withPatch: true });

    expect(bytes).toBe(PAYLOAD_BYTES);
  }, 60000);

  test("piped output is byte-for-byte identical to file-redirected output", async () => {
    const [piped, toFile] = await Promise.all([
      pipedByteCount({ withPatch: true }),
      fileByteCount({ withPatch: true }),
    ]);

    // File writes were never lossy; the pipe must now match them exactly.
    expect(piped).toBe(toFile);
    expect(piped).toBe(PAYLOAD_BYTES);
  }, 60000);

  test("a reader that closes early (EPIPE) does not crash the writer", async () => {
    // `head -c 10` closes the pipe after 10 bytes. The synchronous writer must
    // swallow the resulting EPIPE exactly as a stream would.
    const inner = childSource({ withPatch: true }).replace(/'/g, "'\\''");
    const proc = Bun.spawn(["sh", "-c", `bun -e '${inner}' | head -c 10`], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout.length).toBe(10);
  }, 60000);
});
