/**
 * Thinness merge gate for `minsky mcp shim` (mt#3812 BLOCKING section).
 *
 * This is NOT a decorative test — it is the mechanical backstop the spec
 * requires: "Treat the RSS assertion as a merge gate, not a test. The
 * thinness is disciplinary in Bun — nothing structural prevents a future
 * import from pulling the bundle back in. A single careless import silently
 * restores the 24MB."
 *
 * Two independent checks, deliberately given DIFFERENT weight:
 *
 *   1. **Bundle-size (PRIMARY, deterministic).** Builds
 *      `src/mcp/shim/entry.ts` in-process via `Bun.build()` — no spawn, no
 *      dependency on a prior `bun run build:mcp-shim`, no OS/allocator
 *      involvement — and asserts the output stays small. A module graph is
 *      the same graph on every platform; this cannot drift with runner
 *      architecture the way a live RSS reading can, and it is the assertion
 *      that should be trusted first when this gate fires.
 *   2. **RSS (SECONDARY, loose sanity bound).** Spawns the real shipped
 *      invocation and samples live RSS via `ps`. Kept because it is the one
 *      check that observes the ACTUAL running process rather than its
 *      source graph, but the threshold below carries real headroom for
 *      cross-platform variance — see the calibration note.
 *
 * Calibration note (PR #2820 R2, 2026-08-10): the RSS threshold was
 * originally set at 45MB from a single macOS measurement (~34MB healthy).
 * CI's Linux runner measured a HEALTHY shim at 45.54MB on the exact same
 * code — the platforms differ by ~11-12MB in baseline RSS for identical
 * work, apparently allocator/libc accounting, not a defect. A deliberate
 * regression (see `client.ts`'s history / PR #2820 body's "Negative
 * control" section — routing the shim through a heavy `@minsky/domain`
 * import) measured ~67MB on macOS. The threshold below sits between the
 * highest known-healthy reading (45.54MB, Linux CI) and the lowest known
 * regressed reading (67MB, macOS) with margin on both sides, so a healthy
 * shim passes on every platform actually observed while the measured
 * regression still trips it comfortably. If a THIRD platform's healthy
 * baseline is ever measured above this threshold, the deterministic
 * bundle-size check above still catches the regression class this gate
 * exists for — RSS is not the only backstop, which is why it is allowed to
 * carry a loose bound instead of a tight one.
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/** PRIMARY gate: the shim's own bundle must stay small in absolute terms. */
const BUNDLE_SIZE_THRESHOLD_BYTES = 50 * 1024;

/**
 * SECONDARY gate: loose cross-platform RSS sanity bound. See the file
 * docblock's "Calibration note" for the two reference points this sits
 * between (45.54MB healthy on Linux CI; 67MB regressed on macOS).
 */
const RSS_THRESHOLD_MB = 60;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sampleRssKb(pid: number): number | null {
  try {
    const out = (
      execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" }) as unknown as string
    ).trim();
    if (!out) return null;
    const kb = Number.parseInt(out, 10);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("minsky mcp shim bundle-size budget (PRIMARY merge gate, mt#3812)", () => {
  test("the shim's own build stays under the committed size threshold", async () => {
    // Self-contained: builds src/mcp/shim/entry.ts directly via the Bun.build()
    // API, independent of whether `bun run build:mcp-shim` has run in this
    // environment. Same source graph in, same byte count out, on every
    // platform — the deterministic half of this gate.
    const result = await Bun.build({
      entrypoints: [join(REPO_ROOT, "src", "mcp", "shim", "entry.ts")],
      target: "bun",
      minify: true,
    });

    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);

    const entryOutput = result.outputs.find((o) => o.kind === "entry-point") ?? result.outputs[0];
    expect(entryOutput).toBeDefined();

    // Fails LOUDLY with the actual measured size — a regression that pulls
    // in the full command registry balloons this from ~7.5KB to hundreds of
    // KB / megabytes (measured: 915,833 bytes under the mt#3812 PR #2820
    // negative control), two-plus orders of magnitude past this threshold.
    expect(entryOutput?.size).toBeLessThan(BUNDLE_SIZE_THRESHOLD_BYTES);
  });
});

describe("minsky mcp shim RSS budget (SECONDARY sanity bound, mt#3812)", () => {
  test("the shipped `minsky mcp shim` invocation stays under the loose cross-platform threshold", async () => {
    // Bind nothing, talk to no real daemon: the RSS defect class this
    // guards against (an accidental heavy import) is visible at idle
    // startup, before any request is ever sent. `--url` points at a
    // closed port deliberately — the shim must never dial out just to
    // start up.
    const child = spawn(
      "bun",
      [
        join(REPO_ROOT, "scripts", "cli-entry.ts"),
        "mcp",
        "shim",
        "--url",
        "http://127.0.0.1:1/mcp",
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    try {
      expect(child.pid).toBeDefined();
      const pid = child.pid as number;

      // Let module loading settle before sampling (mirrors the live-ps
      // census methodology ADR-038's own measurements used).
      await sleep(1200);

      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const kb = sampleRssKb(pid);
        if (kb !== null) samples.push(kb);
        await sleep(300);
      }

      expect(samples.length).toBeGreaterThan(0);
      const meanKb = samples.reduce((a, b) => a + b, 0) / samples.length;
      const meanMb = meanKb / 1024;

      // Fails LOUDLY with the actual measured value — never a silent skip.
      expect(meanMb).toBeLessThan(RSS_THRESHOLD_MB);
    } finally {
      child.kill("SIGTERM");
    }
  }, 20_000);
});
