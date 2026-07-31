/**
 * @fileoverview Flag raw hex colors and raw Tailwind-palette color utility
 * classes in `src/cockpit/web/**` (mt#2916), structurally enforcing the
 * "semantic tokens only" convention that `src/cockpit/CLAUDE.md`'s §Design
 * vocabulary previously stated as prose only.
 *
 * Two violation classes (mirrors `docs/design-system.md` §5.2's exact
 * boundary):
 *
 *   (a) Raw hex color literals anywhere in a string — a JSX style-object
 *       value (`"#4a5568"`) or a Tailwind arbitrary-value class
 *       (`"bg-[#10b981]"`). NEVER allowed, no exceptions — per §5.2's
 *       "never raw hex or arbitrary values" boundary, which applies even to
 *       the blessed healthy/warning exception below.
 *   (b) Raw Tailwind palette color utility classes (`bg-emerald-500`,
 *       `text-sky-400`, `border-red-400`, ...) — allowed ONLY for the
 *       blessed healthy/warning hue set (`emerald`/`green`/`amber`, default)
 *       in files declared as status-indicator widgets via the `statusFiles`
 *       option, per `docs/design-system.md` §5.2's exact boundary. Anywhere
 *       else, flagged.
 *
 * Coverage model (mirrors `no-entity-id-param-drift.js` / `eslint.config.js`'s
 * declared-coverage pattern, mt#2779/mt#2780): the ESLint config block
 * enumerates `src/cockpit/web/**` as the covered glob AND passes two
 * allowlists as rule options — `statusFiles` (the blessed healthy/warning
 * widgets, restricted to `blessedHues`) and `paletteExemptFiles` (files with
 * a genuinely non-status categorical raw-palette need — syntax highlighting,
 * message-role chips, a third-party color convention — where ANY hue is
 * permitted). Critically, `paletteExemptFiles` exempts ONLY the palette-class
 * check: the hex-literal check below has NO file-based exemption at all and
 * runs unconditionally everywhere, per §5.2's "never raw hex or arbitrary
 * values" boundary applying even to blessed/exempted files (mt#2916 PR #2045
 * review R1 — an earlier draft used a config-level `"off"` for exempt files,
 * which would have silently let hex slip through unflagged there too).
 * Config, not rule-internal path heuristics, determines scope and exceptions.
 *
 * Detection strategy: scan every string `Literal` and `TemplateElement` (raw
 * template-literal text) in the file for the two patterns above. This is
 * deliberately JSX-attribute-agnostic — it catches `className="..."`,
 * `className={cn(...)}`, `className={\`...${x ? "a" : "b"}\`}`, and
 * `style={{ color: "#..." }}` alike, without needing to special-case each
 * call/attribute shape. Comments are never visited (they are not `Literal`
 * or `TemplateElement` AST nodes), so a JSDoc comment that MENTIONS a raw
 * class name (e.g. explaining a past migration) is never flagged — only
 * live code is.
 *
 * False-positive guard for hex detection: Minsky task/PR references
 * (`mt#2916`, `PR#123`) are decimal digit runs after `#` that can coincidence
 * -match a 3/4-digit hex shorthand. The hex regex requires the `#` NOT be
 * immediately preceded by a letter or digit (a negative lookbehind), which
 * excludes `mt#2916` (preceded by `t`) while still matching a standalone
 * `"#4a5568"` or a bracketed Tailwind arbitrary value `"bg-[#4a5568]"`
 * (preceded by `[`).
 *
 * Known limitation (mt#2916 PR #2045 review R1, non-blocking): dynamically
 * CONSTRUCTED class strings — `"bg-" + hue + "-500"`, or a `TemplateLiteral`
 * whose color segment is itself inside an `${...}` expression rather than a
 * literal quasi — are NOT detected, since only contiguous string `Literal`/
 * `TemplateElement` text is scanned. This is a deliberate scope boundary, not
 * an oversight: cockpit code in practice always spells out full Tailwind
 * class names as literal strings (a Tailwind/PostCSS constraint independent
 * of this rule — the JIT compiler itself can't see dynamically-assembled
 * class names either, so the existing codebase convention already avoids
 * this pattern). If dynamic class construction appears in cockpit code,
 * prefer a static lookup table (object literal mapping a discriminant to a
 * literal class string, as the codebase already does everywhere — see
 * `statusDotColor()` in `MemoriesHealth.tsx`) over string concatenation; a
 * lookup table keeps every branch statically greppable AND lint-visible.
 */

import { sep as pathSep } from "node:path";

const DEFAULT_BLESSED_HUES = ["emerald", "green", "amber"];

const TAILWIND_COLOR_FAMILIES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
].join("|");

const TAILWIND_COLOR_PREFIXES = [
  "bg",
  "text",
  "border",
  "ring",
  "ring-offset",
  "fill",
  "stroke",
  "from",
  "to",
  "via",
  "shadow",
  "outline",
  "decoration",
  "divide",
  "caret",
  "accent",
  "placeholder",
].join("|");

// A hex color: 3, 4, 6, or 8 hex digits, not immediately preceded/followed by
// another hex-ish char (so we don't slice a longer digit run), and not
// preceded by a letter/digit (excludes `mt#2916`-style task/PR refs).
const HEX_COLOR_RE =
  /(?<![A-Za-z0-9])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;

const PALETTE_CLASS_RE = new RegExp(
  `\\b(?:${TAILWIND_COLOR_PREFIXES})-(${TAILWIND_COLOR_FAMILIES})-(?:50|100|200|300|400|500|600|700|800|900|950)\\b`,
  "g"
);

function normalizePath(filename) {
  return filename.split(pathSep).join("/");
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flag raw hex colors and raw Tailwind palette color classes in src/cockpit/web outside the declared blessed healthy/warning exception (mt#2916, docs/design-system.md §5.2)",
    },
    schema: [
      {
        type: "object",
        properties: {
          statusFiles: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-relative path suffixes of files where the blessed healthy/warning raw-palette exception applies.",
          },
          blessedHues: {
            type: "array",
            items: { type: "string" },
            description:
              "Tailwind color families allowed in statusFiles (default: emerald, green, amber).",
          },
          paletteExemptFiles: {
            type: "array",
            items: { type: "string" },
            description:
              "Repo-relative path suffixes of files fully exempt from the palette-class check (any hue permitted) for a recorded non-status categorical need. Hex literals are still ALWAYS flagged in these files — this option never exempts the hex check.",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawHex:
        "Raw hex color '{{match}}' in src/cockpit/web — never allowed, even in the blessed healthy/warning exception or a paletteExemptFiles entry (docs/design-system.md §5.2). Use a semantic token (bg-background, text-destructive, bg-warn-amber, ...) instead.",
      rawPalette:
        "Raw Tailwind palette class '{{className}}' in src/cockpit/web — only the blessed healthy/warning hues ({{blessedHues}}) are allowed, and only in declared status-indicator widgets (docs/design-system.md §5.2). Use a semantic token, or if this is a genuinely new status-indicator widget, add this file to the rule's statusFiles option in eslint.config.js.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const blessedHues = options.blessedHues || DEFAULT_BLESSED_HUES;
    const statusFileSuffixes = options.statusFiles || [];
    const paletteExemptSuffixes = options.paletteExemptFiles || [];

    const filename = normalizePath(context.filename ?? context.getFilename());
    const isStatusFile = statusFileSuffixes.some((suffix) => filename.endsWith(suffix));
    const isPaletteExempt = paletteExemptSuffixes.some((suffix) => filename.endsWith(suffix));

    function checkText(value, node) {
      if (typeof value !== "string" || value.length === 0) return;

      // Hex has NO file-based exemption, ever — checked unconditionally
      // before anything else, including for paletteExemptFiles entries.
      const hexMatch = HEX_COLOR_RE.exec(value);
      HEX_COLOR_RE.lastIndex = 0;
      if (hexMatch) {
        context.report({ node, messageId: "rawHex", data: { match: hexMatch[0] } });
        return;
      }

      // A declared non-status categorical need (syntax highlighting, message
      // -role chips, a third-party color convention) — any hue permitted,
      // hex still banned (checked above).
      if (isPaletteExempt) return;

      PALETTE_CLASS_RE.lastIndex = 0;
      let m;
      while ((m = PALETTE_CLASS_RE.exec(value))) {
        const hue = m[1];
        if (isStatusFile && blessedHues.includes(hue)) continue;
        context.report({
          node,
          messageId: "rawPalette",
          data: { className: m[0], blessedHues: blessedHues.join("/") },
        });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") checkText(node.value, node);
      },
      TemplateElement(node) {
        checkText(node.value.raw, node);
      },
    };
  },
};
