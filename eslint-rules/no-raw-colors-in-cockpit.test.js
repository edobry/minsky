/**
 * @fileoverview Tests for custom/no-raw-colors-in-cockpit (mt#2916).
 *
 * Verifies both violation classes against `docs/design-system.md` §5.2's
 * exact boundary:
 *   (a) raw hex literals — never allowed, even in a statusFiles-allowlisted
 *       file.
 *   (b) raw Tailwind palette classes — allowed only for the blessed
 *       healthy/warning hue set, only in files declared via the
 *       `statusFiles` option.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-raw-colors-in-cockpit.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";

const statusFile = "src/cockpit/web/widgets/MemoriesHealth.tsx";
const otherFile = "src/cockpit/web/widgets/Changesets.tsx";

const tsxTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

const withStatusOption = [{ statusFiles: [statusFile] }];

tsxTester.run("no-raw-colors-in-cockpit", rule, {
  valid: [
    // Semantic tokens everywhere — always fine, regardless of file.
    {
      filename: otherFile,
      code: `const c = "bg-background text-foreground border-border";`,
    },
    {
      filename: otherFile,
      code: `function C() { return <div className="bg-destructive text-destructive-foreground" />; }`,
    },
    // Blessed healthy/warning hues, in a declared status-indicator file.
    {
      filename: statusFile,
      code: `const cls = status === "healthy" ? "bg-emerald-500" : "bg-amber-500";`,
      options: withStatusOption,
    },
    {
      filename: statusFile,
      code: `function C() { return <span className="text-green-400 border-amber-400" />; }`,
      options: withStatusOption,
    },
    // Template-literal className with a blessed-hue ternary, in a status file.
    {
      filename: statusFile,
      code: 'function C({ active }) { return <div className={`flex items-center ${active ? "bg-emerald-500" : "bg-amber-500"}`} />; }',
      options: withStatusOption,
    },
    // Task/PR references that look hex-shaped must not false-positive.
    {
      filename: otherFile,
      code: `const label = "See mt#2916 for details";`,
    },
    {
      filename: otherFile,
      code: 'const prNumber = pr.number != null ? `#${pr.number}` : "—";',
    },
    // Custom blessedHues option narrows/widens the allowed set explicitly.
    {
      filename: statusFile,
      code: `const cls = "bg-sky-500";`,
      options: [{ statusFiles: [statusFile], blessedHues: ["sky"] }],
    },
  ],

  invalid: [
    // Raw hex literal — never allowed, anywhere.
    {
      filename: otherFile,
      code: `const style = { color: "#4a5568" };`,
      errors: [{ messageId: "rawHex" }],
    },
    // Raw hex in a Tailwind arbitrary-value class — never allowed, even in
    // a statusFiles-allowlisted file (hex has no exception, per §5.2).
    {
      filename: statusFile,
      code: `const cls = "bg-[#10b981]";`,
      options: withStatusOption,
      errors: [{ messageId: "rawHex" }],
    },
    // Raw palette class outside any statusFiles allowlist.
    {
      filename: otherFile,
      code: `const cls = "bg-emerald-500";`,
      errors: [{ messageId: "rawPalette" }],
    },
    // Non-blessed hue, even inside a declared status file.
    {
      filename: statusFile,
      code: `const cls = "bg-sky-500";`,
      options: withStatusOption,
      errors: [{ messageId: "rawPalette" }],
    },
    // Blessed hue, but the file is NOT in the statusFiles allowlist.
    {
      filename: otherFile,
      code: `const cls = "text-amber-400";`,
      options: withStatusOption,
      errors: [{ messageId: "rawPalette" }],
    },
    // JSX className, non-blessed hue, no allowlist.
    {
      filename: otherFile,
      code: `function C() { return <div className="border-violet-500 text-violet-400" />; }`,
      errors: [{ messageId: "rawPalette" }, { messageId: "rawPalette" }],
    },
  ],
});
