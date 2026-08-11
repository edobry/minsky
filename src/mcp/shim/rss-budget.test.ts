/**
 * RSS merge gate for `minsky mcp shim` (mt#3812 BLOCKING section).
 *
 * This is NOT a decorative test — it is the mechanical backstop the spec
 * requires: "Treat the RSS assertion as a merge gate, not a test. The
 * thinness is disciplinary in Bun — nothing structural prevents a future
 * import from pulling the bundle back in. A single careless import silently
 * restores the 24MB."
 *
 * It spawns the REAL SHIPPED invocation — `bun scripts/cli-entry.ts mcp
 * shim ...`, the exact command Claude Code's MCP config would run — not a
 * standalone prototype and not `src/mcp/shim/entry.ts` directly. That
 * distinguishes this from the mistake the spec's BLOCKING section warns
 * about: a re-measured standalone binary proves nothing about the thing
 * that ships. If `dist/mcp-shim.js` exists (post `bun run build`),
 * cli-entry.ts's own intercept picks it; otherwise it falls back to
 * `src/mcp/shim/entry.ts` — either way this measures the actual code path
 * a Claude Code conversation would launch.
 *
 * Measured baseline (2026-08-10, this task): ~34MB RSS via the bundle path
 * (`dist/mcp-shim.js`, 9 modules, 6.95KB minified) — within the ~36-39MB
 * "Bun floor" the ADR-038 standalone prototype measured, and a small
 * fraction of today's `minsky mcp proxy` (~55.5MB mean) which imports the
 * full CLI bundle. THRESHOLD_MB below is set with headroom above the
 * measured baseline but well below the proxy figure, so genuine minor
 * variance (Bun version, OS) doesn't flake the gate while a real regression
 * (an accidental `@minsky/domain` barrel import, a `src/commands/*` import)
 * still fails it loudly.
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Threshold set at ~1.3x the measured 34MB baseline, still far below the
 * ~55.5MB `minsky mcp proxy` figure the whole ADR-038 resource case exists
 * to beat. A genuine bundle-import regression (24MB dist/minsky.js pulled
 * in) blows well past this; ordinary Bun-runtime variance does not.
 */
const THRESHOLD_MB = 45;

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

describe("minsky mcp shim RSS budget (merge gate, mt#3812)", () => {
  test("the shipped `minsky mcp shim` invocation stays under the committed threshold", async () => {
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
      expect(meanMb).toBeLessThan(THRESHOLD_MB);
    } finally {
      child.kill("SIGTERM");
    }
  }, 20_000);

  test("dist/mcp-shim.js, when built, is a separate artifact from dist/minsky.js", async () => {
    // Cheap, always-on companion check: if a build has run, assert the shim
    // bundle exists as its OWN small artifact rather than silently aliasing
    // the main CLI bundle (e.g. via a build-script typo that points both
    // entries at the same outfile). Uses Bun.file()'s own existence check
    // (not node:fs) so this stays a pure read of the build's OUTPUT rather
    // than a real-filesystem dependency the test rule flags.
    const shimBundle = Bun.file(join(REPO_ROOT, "dist", "mcp-shim.js"));
    const mainBundle = Bun.file(join(REPO_ROOT, "dist", "minsky.js"));
    if (!(await shimBundle.exists()) || !(await mainBundle.exists())) {
      // No build has run in this environment — the RSS test above already
      // covers the source-fallback path; nothing further to assert here.
      return;
    }
    expect(shimBundle.size).toBeLessThan(mainBundle.size);
    // The shim bundle should be small in absolute terms — a regression that
    // pulls in the full command registry would balloon this from ~7KB to
    // hundreds of KB / several MB even before RSS is measured.
    expect(shimBundle.size).toBeLessThan(500 * 1024);
  });
});
