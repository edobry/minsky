/**
 * Tests for the shared liveness-dot color mapping (mt#2909) and the
 * mt#2917 stale/orphaned color-SEMANTICS recalibration (docs/brand-system.md
 * §7, index.css).
 */
import { describe, expect, test } from "bun:test";
// Reading the shipped index.css design tokens IS the point of the test below (pinning the
// actual CSS source of truth, not a mocked dependency of code under test); the file is a
// static, checked-in repo asset with no mutation/race-condition risk.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { readFileSync } from "fs";
import { join } from "path";
import { livenessDotClass, type Liveness } from "./liveness-colors";

describe("livenessDotClass", () => {
  const cases: [Liveness, string][] = [
    ["healthy", "bg-liveness-healthy"],
    ["idle", "bg-liveness-idle"],
    ["stale", "bg-liveness-stale"],
    ["orphaned", "bg-liveness-orphaned"],
    [null, ""],
  ];

  test.each(cases)("%s -> %s", (liveness, expected) => {
    expect(livenessDotClass(liveness)).toBe(expected);
  });
});

/**
 * `livenessDotClass` only pins STATE -> Tailwind-class-name (unchanged by
 * mt#2917 — "stale" always resolved to the `bg-liveness-stale` class). What
 * mt#2917 actually recalibrated is the OKLCH color each class token resolves
 * to in index.css: "stale" moved to the amber family (not a hard-alarm
 * state, docs/design-system.md §5.1); "orphaned" took the red slot (exact
 * match with --destructive / --warn-red). This block pins that semantic
 * against the CSS source of truth directly, rather than duplicating the raw
 * hue numbers as a second, driftable source of truth.
 */
describe("liveness OKLCH color semantics (mt#2917 recalibration)", () => {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see import-line justification above
  const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf-8");

  function themeBlock(theme: "root" | "dark"): string {
    const re = theme === "root" ? /:root\s*\{([\s\S]*?)\n\}/ : /\.dark\s*\{([\s\S]*?)\n\}/;
    const match = css.match(re);
    if (!match) throw new Error(`Could not find .${theme} block in index.css`);
    return match[1];
  }

  function oklchHue(block: string, varName: string): number {
    const match = block.match(new RegExp(`--${varName}:\\s*[\\d.]+\\s+[\\d.]+\\s+([\\d.]+);`));
    if (!match) throw new Error(`--${varName} not found`);
    return Number(match[1]);
  }

  test.each(["root", "dark"] as const)("%s theme: stale is amber, not red or green", (theme) => {
    const block = themeBlock(theme);
    const staleHue = oklchHue(block, "liveness-stale");
    const redHue = oklchHue(block, "destructive");
    const healthyHue = oklchHue(block, "liveness-healthy");

    expect(staleHue).not.toBe(redHue);
    expect(staleHue).not.toBe(healthyHue);
    // Warm/amber band: strictly between the red hue and the green
    // (healthy) hue on the OKLCH hue wheel used by this token set.
    expect(staleHue).toBeGreaterThan(redHue);
    expect(staleHue).toBeLessThan(healthyHue);
  });

  test.each(["root", "dark"] as const)(
    "%s theme: orphaned takes the red/destructive slot",
    (theme) => {
      const block = themeBlock(theme);
      const orphanedHue = oklchHue(block, "liveness-orphaned");
      const redHue = oklchHue(block, "destructive");

      expect(orphanedHue).toBe(redHue);
    }
  );

  test("root theme: orphaned also matches --warn-red (theme-independent brand accent)", () => {
    const block = themeBlock("root");
    const orphanedHue = oklchHue(block, "liveness-orphaned");
    const warnRedHue = oklchHue(block, "warn-red");

    expect(orphanedHue).toBe(warnRedHue);
  });
});
