import { describe, expect, it } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests -- reading the REAL files is the invariant under
   test. This suite asserts that the brand palette declared in docs/brand-system.md §2 matches
   what src/cockpit/web/index.css and services/site/src/styles/global.css actually ship; against
   an in-memory fixture it would assert only that the checker parses its own fixture, which is
   exactly the vacuous-probe failure mode the check exists to prevent (mem#704). Mirrors the
   scoped-disable rationale in require-execution-evidence-before-merge.test.ts. The pure parsing
   and comparison logic IS injectable and is unit-tested below against synthetic strings. */
import { readFileSync } from "node:fs";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "node:path";

import type { DriftInputs } from "./brand-token-drift";
import {
  findBrandTokenDrift,
  formatDriftReport,
  normalizeHex,
  oklchEquals,
  parseBareOklchDeclarations,
  parseCanonicalTokens,
  parseHexFallbackDeclarations,
  parseOklchFunctionDeclarations,
  TOKEN_MAP,
} from "./brand-token-drift";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BRAND_SYSTEM = join(REPO_ROOT, "docs", "brand-system.md");
const COCKPIT_CSS = join(REPO_ROOT, "src", "cockpit", "web", "index.css");
const SITE_CSS = join(REPO_ROOT, "services", "site", "src", "styles", "global.css");

/** `readFileSync`'s overloads widen to `string | Buffer` under this tsconfig regardless of the
 *  encoding form, so the cast is the repo convention (see `src/tools/check-title-duplication.ts`,
 *  `src/mcp/disconnect-tracker.test.ts`). */
function readText(path: string): string {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- import-site rationale above: the on-disk content IS the subject of this assertion.
  return readFileSync(path, "utf-8") as string;
}

/**
 * Rewrites one declaration's VALUE, locating it by variable name (PR #2488 R1).
 *
 * The mutation tests originally matched an exact literal like `--signal-cyan: 0.745 0.124 215;`.
 * Any benign reformatting — a prettier pass, a spacing change, a re-rounded value — would make
 * `.replace()` a no-op, and the test would then assert against an UNMUTATED file. Locating by
 * name is robust to all of that, and the throw makes a genuinely-missing declaration loud
 * instead of silent.
 *
 * `occurrence` selects which match to rewrite: the site stylesheet declares each token twice
 * (the `oklch()` form, then the hex fallback), so the fallback tests target the second.
 */
function mutateDeclaration(css: string, varName: string, newValue: string, occurrence = 1): string {
  const pattern = new RegExp(`(^[ \\t]*--${varName}:[ \\t]*)([^;\\n]+)(;)`, "gm");
  const matches = [...css.matchAll(pattern)];
  if (matches.length < occurrence) {
    throw new Error(
      `mutateDeclaration: --${varName} occurrence ${occurrence} not found (saw ` +
        `${matches.length}) — the fixture is stale, not the checker.`
    );
  }
  const target = matches[occurrence - 1] as RegExpMatchArray;
  const start = target.index as number;
  return `${css.slice(0, start)}${target[1]}${newValue}${target[3]}${css.slice(
    start + target[0].length
  )}`;
}

/** Deletes a declaration entirely, located by name. */
function deleteDeclaration(css: string, varName: string): string {
  const pattern = new RegExp(`^[ \\t]*--${varName}:[^;\\n]+;[ \\t]*\\n?`, "m");
  if (!pattern.test(css)) {
    throw new Error(`deleteDeclaration: --${varName} not found — the fixture is stale.`);
  }
  return css.replace(pattern, "");
}

function readReal(): DriftInputs {
  return {
    brandSystemMarkdown: readText(BRAND_SYSTEM),
    cockpitCss: readText(COCKPIT_CSS),
    siteCss: readText(SITE_CSS),
  };
}

// ---------------------------------------------------------------------------
// AT1 / AT3 — the real surfaces agree with the canonical table.
// ---------------------------------------------------------------------------

describe("brand-token drift (live files)", () => {
  it("AT1: every mapped token resolves in docs/brand-system.md §2", () => {
    const canonical = parseCanonicalTokens(readReal().brandSystemMarkdown);
    const names = new Set(canonical.map((t) => t.name));
    for (const mapping of TOKEN_MAP) {
      expect(names.has(mapping.canonical)).toBe(true);
    }
  });

  it("AT3: the cockpit and site stylesheets carry no drift from the canonical table", () => {
    const findings = findBrandTokenDrift(readReal());
    // Printed rather than a bare count so a failure names the token and file.
    expect(formatDriftReport(findings)).toBe("No brand-token drift.");
    expect(findings).toEqual([]);
  });

  it("does not fire on unrelated CSS edits — parsing is scoped to declarations it maps", () => {
    const real = readReal();
    const withUnrelatedEdit = {
      ...real,
      cockpitCss: `${real.cockpitCss}\n.some-new-class { color: red; padding: 4px; }\n`,
    };
    expect(findBrandTokenDrift(withUnrelatedEdit)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AT2 — a mutated surface is caught, and the report names the token + surface.
// ---------------------------------------------------------------------------

describe("AT2: mutating one surface's copy is detected", () => {
  it("catches a changed OKLCH value in the cockpit stylesheet", () => {
    const real = readReal();
    const mutated = {
      ...real,
      cockpitCss: mutateDeclaration(real.cockpitCss, "signal-cyan", "0.700 0.124 215"),
    };
    expect(mutated.cockpitCss).not.toBe(real.cockpitCss);

    const findings = findBrandTokenDrift(mutated);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.token).toBe("signal.cyan");
    expect(findings[0]?.surface).toBe("cockpit index.css");
    expect(findings[0]?.variable).toBe("--signal-cyan");

    const report = formatDriftReport(findings);
    expect(report).toContain("signal.cyan");
    expect(report).toContain("cockpit index.css");
    expect(report).toContain("docs/brand-system.md §2 is canonical");
  });

  it("catches a changed oklch() value in the site stylesheet", () => {
    const real = readReal();
    const mutated = {
      ...real,
      siteCss: mutateDeclaration(real.siteCss, "color-warn-amber", "oklch(0.756 0.180 90)"),
    };
    expect(mutated.siteCss).not.toBe(real.siteCss);

    const findings = findBrandTokenDrift(mutated);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.token).toBe("warn.amber");
    expect(findings[0]?.surface).toBe("site global.css (oklch)");
  });

  it("catches a changed HEX FALLBACK — the copy nobody looks at", () => {
    const real = readReal();
    const mutated = {
      ...real,
      // occurrence 2 — the first `--color-signal` is the oklch() form, the second is the
      // @supports hex fallback this test targets.
      siteCss: mutateDeclaration(real.siteCss, "color-signal", "#00bfd9", 2),
    };
    expect(mutated.siteCss).not.toBe(real.siteCss);

    const findings = findBrandTokenDrift(mutated);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.surface).toBe("site global.css (@supports hex fallback)");
    expect(findings[0]?.expected).toBe("#00bfd8");
    expect(findings[0]?.actual).toBe("#00bfd9");
  });

  it("catches a DELETED declaration, not just a changed one", () => {
    const real = readReal();
    const mutated = {
      ...real,
      cockpitCss: deleteDeclaration(real.cockpitCss, "iso-pastel"),
    };
    expect(mutated.cockpitCss).not.toBe(real.cockpitCss);

    const findings = findBrandTokenDrift(mutated);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.actual).toBe("declaration missing");
  });
});

// ---------------------------------------------------------------------------
// Parser units — the formatting-tolerance property this check depends on.
// ---------------------------------------------------------------------------

describe("numeric comparison, not string comparison", () => {
  it("treats 0.56 and 0.560 as the same value", () => {
    expect(oklchEquals([0.56, 0.092, 220], [0.56, 0.092, 220])).toBe(true);
  });

  it("still distinguishes genuinely different values", () => {
    expect(oklchEquals([0.56, 0.092, 220], [0.57, 0.092, 220])).toBe(false);
  });

  it("tolerates the real formatting difference between the two surfaces", () => {
    const cockpit = parseBareOklchDeclarations("  --signal-cyan-dim: 0.56 0.092 220;");
    const site = parseOklchFunctionDeclarations("  --color-signal-dim: oklch(0.560 0.092 220);");
    const a = cockpit.get("signal-cyan-dim");
    const b = site.get("color-signal-dim");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(oklchEquals(a as [number, number, number], b as [number, number, number])).toBe(true);
  });
});

// PR #2488 R1 — the three real defects the review found.
describe("R1: CSS comments are not parsed as declarations", () => {
  it("ignores a commented-out declaration that would otherwise override the real one", () => {
    const css = [
      ":root {",
      "  --signal-cyan: 0.745 0.124 215;",
      "  /* was, before the retune:",
      "  --signal-cyan: 0.900 0.124 215;",
      "  */",
      "}",
    ].join("\n");
    // Without comment-stripping the commented line parses LAST and wins, reporting drift on a
    // file that is actually correct.
    expect(parseBareOklchDeclarations(css).get("signal-cyan")).toEqual([0.745, 0.124, 215]);
  });

  it("ignores a commented-out oklch() declaration on the site side", () => {
    const css = [
      ":root {",
      "  --color-signal: oklch(0.745 0.124 215);",
      "  /* --color-signal: oklch(0.900 0.124 215); */",
      "}",
    ].join("\n");
    expect(parseOklchFunctionDeclarations(css).get("color-signal")).toEqual([0.745, 0.124, 215]);
  });
});

describe("R1: hex comparison is format-insensitive", () => {
  it("treats #abc and #aabbcc as the same color", () => {
    expect(normalizeHex("#abc")).toBe(normalizeHex("#AABBCC"));
  });

  it("drops a fully-opaque alpha but keeps a partial one", () => {
    expect(normalizeHex("#00bfd8ff")).toBe("#00bfd8");
    expect(normalizeHex("#00bfd880")).toBe("#00bfd880");
  });

  it("does not report drift for an equivalent shorthand in the fallback block", () => {
    // One declaration per line: the parsers are line-anchored, matching the prettier-formatted
    // shape both real stylesheets are in.
    const css = [
      "@supports not (color: oklch(0 0 0)) {",
      "  :root {",
      "    --color-x: #FFF;",
      "  }",
      "}",
    ].join("\n");
    expect(parseHexFallbackDeclarations(css).get("color-x")).toBe("#ffffff");
  });
});

describe("R1: CSS Color 4 percentage notation", () => {
  it("reads lightness percentages as their 0-1 equivalent", () => {
    const pct = parseOklchFunctionDeclarations("--a: oklch(56% 0.092 220);").get("a");
    const num = parseOklchFunctionDeclarations("--b: oklch(0.56 0.092 220);").get("b");
    expect(pct).toBeDefined();
    expect(oklchEquals(pct as [number, number, number], num as [number, number, number])).toBe(
      true
    );
  });

  it("reads chroma percentages against the CSS 100% = 0.4 basis", () => {
    const pct = parseOklchFunctionDeclarations("--a: oklch(0.56 23% 220);").get("a");
    expect(pct?.[1]).toBeCloseTo(0.092, 12);
  });
});

describe("hex-fallback parsing is scoped to the @supports block", () => {
  it("ignores hex declared outside the legacy fallback block", () => {
    const css = [
      ":root {",
      "  --color-signal: oklch(0.745 0.124 215);",
      "  --unrelated-hex: #123456;",
      "}",
      "@supports not (color: oklch(0 0 0)) {",
      "  :root {",
      "    --color-signal: #00bfd8;",
      "  }",
      "}",
    ].join("\n");
    const fallback = parseHexFallbackDeclarations(css);
    expect(fallback.get("color-signal")).toBe("#00bfd8");
    expect(fallback.has("unrelated-hex")).toBe(false);
  });

  it("returns empty when there is no fallback block, rather than throwing", () => {
    expect(parseHexFallbackDeclarations(":root { --x: #fff; }").size).toBe(0);
  });
});

describe("canonical-table parsing fails loudly rather than vacuously passing", () => {
  it("throws when the Color section is missing", () => {
    expect(() => parseCanonicalTokens("# Brand\n\n## 1. Type\n")).toThrow(/## 2. Color/);
  });

  it("throws when the section exists but yields no rows", () => {
    expect(() => parseCanonicalTokens("## 2. Color\n\nProse only, no table.\n")).toThrow(
      /parsed 0 rows/
    );
  });

  it("does not pick up rows from the later contrast-targets table", () => {
    const md = [
      "## 2. Color",
      "",
      "| Token | Hex | OKLCH | Use |",
      "| --- | --- | --- | --- |",
      "| `signal.cyan` | `#00BFD8` | `oklch(0.745 0.124 215)` | Primary accent. |",
      "",
      "### Contrast targets",
      "",
      "| Foreground | Background | Required | Notes |",
      "| --- | --- | --- | --- |",
      "| `text.primary` | `bg.base` | 4.5:1 | n/a |",
    ].join("\n");
    const tokens = parseCanonicalTokens(md);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.name).toBe("signal.cyan");
    expect(tokens[0]?.hex).toBe("#00bfd8");
  });
});
