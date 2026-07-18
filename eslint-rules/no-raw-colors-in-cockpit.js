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
 * enumerates `src/cockpit/web/**` as the covered glob AND passes the
 * `statusFiles` allowlist (the blessed healthy/warning widgets) plus any
 * fully-exempted files (via a subsequent config block turning the rule
 * `"off"` for those exact paths, each with an inline justification comment —
 * the same technique `no-raw-console`'s CLI-exclude block uses). Config, not
 * rule-internal path heuristics, determines both scope and exceptions.
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
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawHex:
        "Raw hex color '{{match}}' in src/cockpit/web — never allowed, even in the blessed healthy/warning exception (docs/design-system.md §5.2). Use a semantic token (bg-background, text-destructive, bg-warn-amber, ...) instead.",
      rawPalette:
        "Raw Tailwind palette class '{{className}}' in src/cockpit/web — only the blessed healthy/warning hues ({{blessedHues}}) are allowed, and only in declared status-indicator widgets (docs/design-system.md §5.2). Use a semantic token, or if this is a genuinely new status-indicator widget, add this file to the rule's statusFiles option in eslint.config.js.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const blessedHues = options.blessedHues || DEFAULT_BLESSED_HUES;
    const statusFileSuffixes = options.statusFiles || [];

    const filename = normalizePath(context.filename ?? context.getFilename());
    const isStatusFile = statusFileSuffixes.some((suffix) => filename.endsWith(suffix));

    function checkText(value, node) {
      if (typeof value !== "string" || value.length === 0) return;

      const hexMatch = HEX_COLOR_RE.exec(value);
      HEX_COLOR_RE.lastIndex = 0;
      if (hexMatch) {
        context.report({ node, messageId: "rawHex", data: { match: hexMatch[0] } });
        return;
      }

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
