/**
 * Brand-token drift check (mt#3411).
 *
 * `docs/brand-system.md` §2 is the declared source of truth for the brand palette. It carries a
 * Token / Hex / OKLCH table and states the precedence outright: "OKLCH is canonical; hex is
 * derived ... This prevents perceptual drift across surfaces", plus the sync obligation "commit
 * any refinement back to this table so all surfaces stay in sync."
 *
 * Both consumers already cite that section — `src/cockpit/web/index.css` ("Brand palette
 * additions (mt#1935; docs/brand-system.md §2)") and `services/site/src/styles/global.css` ("The
 * cascade order matches the pattern in docs/brand-system.md §2"). What was missing is that
 * NOTHING READ IT: the obligation was prose, and prose does not fail a build. The same seven
 * values are hand-copied into three places in three different syntaxes, so any one of them can
 * drift silently.
 *
 * This module makes the existing source authoritative. It deliberately does NOT introduce a
 * competing manifest — that would create a fourth copy of the same values, which is the opposite
 * of the point.
 *
 * ## The three copies
 *
 * | Surface | Syntax | Example |
 * | --- | --- | --- |
 * | cockpit `index.css` | bare OKLCH components (Tailwind/shadcn compose them) | `--signal-cyan: 0.745 0.124 215;` |
 * | site `global.css` | full `oklch()` | `--color-signal: oklch(0.745 0.124 215);` |
 * | site `@supports` fallback | sRGB hex, for engines without `oklch()` | `--color-signal: #00bfd8;` |
 *
 * ## Why the map is declared, not inferred
 *
 * Values coincide across surfaces without denoting the same token: cockpit's light-mode
 * `--primary` is `0.078 0 0`, the same triple as the site's `--color-bg-base`. Matching on VALUE
 * would silently pair unrelated tokens and then "verify" that pairing forever. The map below is
 * therefore explicit, and a token absent from a surface is simply not checked there.
 */

/** One row of the `docs/brand-system.md` §2 palette table. */
export interface CanonicalToken {
  /** Dotted token name as written in the table, e.g. `signal.cyan`. */
  name: string;
  /** Derived sRGB fallback, lowercased (e.g. `#00bfd8`). */
  hex: string;
  /** Canonical OKLCH components: [lightness, chroma, hue]. */
  oklch: [number, number, number];
}

/** A declared correspondence between the canonical token and each surface's variable name. */
export interface TokenMapping {
  /** Must match a `name` in the §2 table. */
  canonical: string;
  /** Variable in `src/cockpit/web/index.css`, without the leading `--`. Omitted when absent. */
  cockpitVar?: string;
  /** Variable in `services/site/src/styles/global.css`, without `--`. Omitted when absent. */
  siteVar?: string;
}

/**
 * The declared map. Adding a brand token means adding its row to `docs/brand-system.md` §2 AND
 * an entry here — the check fails closed on a canonical name it cannot resolve, so a new token
 * cannot be added to the table and silently go unchecked.
 */
export const TOKEN_MAP: readonly TokenMapping[] = [
  { canonical: "bg.base", siteVar: "color-bg-base" },
  { canonical: "bg.warm", cockpitVar: "bg-warm", siteVar: "color-bg-warm" },
  { canonical: "bg.elevated", siteVar: "color-bg-elevated" },
  { canonical: "text.primary", siteVar: "color-text-primary" },
  { canonical: "text.muted", siteVar: "color-text-muted" },
  { canonical: "text.subtle", cockpitVar: "text-subtle", siteVar: "color-text-subtle" },
  { canonical: "signal.cyan", cockpitVar: "signal-cyan", siteVar: "color-signal" },
  { canonical: "signal.cyan.dim", cockpitVar: "signal-cyan-dim", siteVar: "color-signal-dim" },
  { canonical: "warn.amber", cockpitVar: "warn-amber", siteVar: "color-warn-amber" },
  { canonical: "warn.red", cockpitVar: "warn-red", siteVar: "color-warn-red" },
  { canonical: "iso.pastel", cockpitVar: "iso-pastel", siteVar: "color-iso-pastel" },
] as const;

/** A single mismatch between a surface's declaration and the canonical table. */
export interface DriftFinding {
  /** Canonical token name. */
  token: string;
  /** Which copy disagrees — named so the failure message points at a file. */
  surface:
    | "cockpit index.css"
    | "site global.css (oklch)"
    | "site global.css (@supports hex fallback)";
  /** The variable that was compared, with its `--` prefix. */
  variable: string;
  expected: string;
  actual: string;
}

/**
 * Parses the §2 palette table.
 *
 * Rows look like:
 * `| \`signal.cyan\` | \`#00BFD8\` | \`oklch(0.745 0.124 215)\` | Primary accent... |`
 *
 * Scoped to the `## 2. Color` section so a later table (contrast targets, also `|`-delimited and
 * also containing token names in backticks) cannot contribute phantom rows.
 */
export function parseCanonicalTokens(markdown: string): CanonicalToken[] {
  const sectionStart = markdown.indexOf("## 2. Color");
  if (sectionStart === -1) {
    throw new Error(
      "brand-token-drift: could not find '## 2. Color' in docs/brand-system.md — the canonical " +
        "palette table moved or was renamed. Update this parser rather than deleting the check."
    );
  }
  // End at the first sub-heading; the palette table is the first thing in the section.
  const rest = markdown.slice(sectionStart + "## 2. Color".length);
  const sectionEnd = rest.search(/\n#{2,3} /);
  const section = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd);

  const tokens: CanonicalToken[] = [];
  const rowPattern =
    /^\|\s*`([a-z0-9.]+)`\s*\|\s*`(#[0-9a-fA-F]{6})`\s*\|\s*`oklch\(([^)]+)\)`\s*\|/gm;

  for (const match of section.matchAll(rowPattern)) {
    const [, name, hex, oklchBody] = match;
    if (!name || !hex || !oklchBody) continue;
    const components = parseOklchComponents(oklchBody);
    if (!components) continue;
    tokens.push({ name, hex: hex.toLowerCase(), oklch: components });
  }

  if (tokens.length === 0) {
    throw new Error(
      "brand-token-drift: parsed 0 rows from the '## 2. Color' palette table. The table format " +
        "changed; a silently-empty canonical set would make this check vacuously pass."
    );
  }
  return tokens;
}

/** Parses `L C H` (whitespace- or slash-separated alpha ignored) into numbers. */
function parseOklchComponents(body: string): [number, number, number] | null {
  const parts = body.trim().split("/")[0]?.trim().split(/\s+/);
  if (!parts || parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number.parseFloat(p));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return [nums[0] as number, nums[1] as number, nums[2] as number];
}

/**
 * Extracts `--name: <L C H>;` declarations whose value is BARE OKLCH components — the cockpit's
 * form, because Tailwind/shadcn wrap them in `oklch()` at use site.
 */
export function parseBareOklchDeclarations(css: string): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  const pattern = /^\s*--([a-z0-9-]+):\s*([0-9.]+\s+[0-9.]+\s+[0-9.]+)\s*;/gim;
  for (const match of css.matchAll(pattern)) {
    const [, name, value] = match;
    if (!name || !value) continue;
    const components = parseOklchComponents(value);
    if (components) out.set(name, components);
  }
  return out;
}

/** Extracts `--name: oklch(...)` declarations — the site's modern form. */
export function parseOklchFunctionDeclarations(css: string): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  const pattern = /^\s*--([a-z0-9-]+):\s*oklch\(([^)]+)\)\s*;/gim;
  for (const match of css.matchAll(pattern)) {
    const [, name, body] = match;
    if (!name || !body) continue;
    const components = parseOklchComponents(body);
    if (components) out.set(name, components);
  }
  return out;
}

/**
 * Extracts `--name: #rrggbb;` declarations from INSIDE the legacy-engine fallback block only.
 *
 * Scoping matters: hex outside `@supports not (color: oklch(0 0 0))` is not part of the fallback
 * contract, and picking it up would compare unrelated declarations against the palette.
 */
export function parseHexFallbackDeclarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const blockStart = css.search(/@supports\s+not\s*\(\s*color:\s*oklch\([^)]*\)\s*\)/i);
  if (blockStart === -1) return out;

  // Walk braces from the @supports to its matching close, so a nested `:root { }` is included
  // and the scan stops at the block's real end rather than the first `}`.
  const from = css.indexOf("{", blockStart);
  if (from === -1) return out;
  let depth = 0;
  let end = css.length;
  for (let i = from; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const block = css.slice(from, end);
  const pattern = /^\s*--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gim;
  for (const match of block.matchAll(pattern)) {
    const [, name, hex] = match;
    if (name && hex) out.set(name, hex.toLowerCase());
  }
  return out;
}

/**
 * True when two OKLCH triples are the same value.
 *
 * Compared NUMERICALLY, not as strings: the surfaces legitimately format the same value
 * differently (`0.56` in the cockpit vs `0.560` on the site, `0.18` vs `0.180`). A string compare
 * would report drift on every one of those and be turned off within a day.
 */
export function oklchEquals(a: [number, number, number], b: [number, number, number]): boolean {
  const EPSILON = 1e-9;
  return a.every((component, i) => Math.abs(component - (b[i] as number)) < EPSILON);
}

export interface DriftInputs {
  brandSystemMarkdown: string;
  cockpitCss: string;
  siteCss: string;
}

/**
 * Compares every mapped token against all three copies. Returns one finding per mismatch;
 * an empty array means the surfaces agree with the canonical table.
 *
 * A token mapped to a variable that is ABSENT from that surface is a finding too — the map says
 * it should be there, so a silent deletion is drift, not an opt-out.
 */
export function findBrandTokenDrift(inputs: DriftInputs): DriftFinding[] {
  const canonical = new Map(
    parseCanonicalTokens(inputs.brandSystemMarkdown).map((t) => [t.name, t])
  );
  const cockpit = parseBareOklchDeclarations(inputs.cockpitCss);
  const siteOklch = parseOklchFunctionDeclarations(inputs.siteCss);
  const siteHex = parseHexFallbackDeclarations(inputs.siteCss);

  const findings: DriftFinding[] = [];

  for (const mapping of TOKEN_MAP) {
    const token = canonical.get(mapping.canonical);
    if (!token) {
      findings.push({
        token: mapping.canonical,
        surface: "cockpit index.css",
        variable: "(n/a)",
        expected: `a row for \`${mapping.canonical}\` in docs/brand-system.md §2`,
        actual: "no such row — TOKEN_MAP and the canonical table disagree",
      });
      continue;
    }

    if (mapping.cockpitVar) {
      const actual = cockpit.get(mapping.cockpitVar);
      if (!actual) {
        findings.push({
          token: token.name,
          surface: "cockpit index.css",
          variable: `--${mapping.cockpitVar}`,
          expected: formatOklch(token.oklch),
          actual: "declaration missing",
        });
      } else if (!oklchEquals(actual, token.oklch)) {
        findings.push({
          token: token.name,
          surface: "cockpit index.css",
          variable: `--${mapping.cockpitVar}`,
          expected: token.oklch.join(" "),
          actual: actual.join(" "),
        });
      }
    }

    if (mapping.siteVar) {
      const actualOklch = siteOklch.get(mapping.siteVar);
      if (!actualOklch) {
        findings.push({
          token: token.name,
          surface: "site global.css (oklch)",
          variable: `--${mapping.siteVar}`,
          expected: formatOklch(token.oklch),
          actual: "declaration missing",
        });
      } else if (!oklchEquals(actualOklch, token.oklch)) {
        findings.push({
          token: token.name,
          surface: "site global.css (oklch)",
          variable: `--${mapping.siteVar}`,
          expected: formatOklch(token.oklch),
          actual: formatOklch(actualOklch),
        });
      }

      const actualHex = siteHex.get(mapping.siteVar);
      if (!actualHex) {
        findings.push({
          token: token.name,
          surface: "site global.css (@supports hex fallback)",
          variable: `--${mapping.siteVar}`,
          expected: token.hex,
          actual: "declaration missing",
        });
      } else if (actualHex !== token.hex) {
        findings.push({
          token: token.name,
          surface: "site global.css (@supports hex fallback)",
          variable: `--${mapping.siteVar}`,
          expected: token.hex,
          actual: actualHex,
        });
      }
    }
  }

  return findings;
}

function formatOklch(components: [number, number, number]): string {
  return `oklch(${components.join(" ")})`;
}

/** Renders findings as an operator-readable failure message. */
export function formatDriftReport(findings: DriftFinding[]): string {
  if (findings.length === 0) return "No brand-token drift.";
  const lines = findings.map(
    (f) =>
      `  - ${f.token} (${f.variable}) in ${f.surface}\n` +
      `      canonical: ${f.expected}\n` +
      `      found:     ${f.actual}`
  );
  return (
    `${findings.length} brand-token drift finding(s). docs/brand-system.md §2 is canonical — ` +
    `fix the surface, or change the table and re-derive the surfaces from it:\n${lines.join("\n")}`
  );
}
