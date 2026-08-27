#!/usr/bin/env bun
/**
 * @fileoverview One-shot codemod for mt#4639: convert every site
 * `custom/prefer-loggable-error-summary` flags into a `getLoggableErrorSummary`
 * call, adding the import and dropping a now-orphaned `getErrorMessage` import.
 *
 * ## Why it is driven by ESLint's report rather than by a regex
 *
 * The rule already answers the only hard question — WHICH bare renderings flow
 * into a log call from inside an error handler. A raw grep for the expression
 * finds 878 sites; the rule flags 660, because 279 are throws/returns/plain
 * assignments that must NOT be converted (`getLoggableErrorSummary`'s own
 * docblock is explicit that a `{ cause }` re-wrap must not be truncated at the
 * throw) and the rest sit outside any handler. Re-deriving that judgment in a
 * codemod would be reimplementing the rule, badly. So this reads the rule's
 * JSON report and rewrites exactly the AST ranges it reported: the codemod's
 * population IS the rule's population, and the two cannot drift.
 *
 * That is also why the rule needs to be at `"error"` before this runs — ESLint's
 * `--rule` CLI flag cannot force it on, because the `custom` plugin is
 * registered on a scoped config object and the flag's implicit config object
 * has no plugins (`Could not find "prefer-loggable-error-summary" in plugin
 * "custom"`). mt#4639 flips the posture as part of the same change, so by the
 * time this runs the rule reports normally.
 *
 * ## Boundary validation
 *
 * Every replacement is checked against the exact shape the rule matches before
 * it is applied, and anything that does not match is SKIPPED and reported
 * rather than guessed at:
 *
 *   - `ConditionalExpression` — the range text must be
 *     `<E> instanceof Error ? <E>.message : String(<E>)`, with the SAME `<E>`
 *     in all three positions. A mismatch means the rule matched a shape this
 *     codemod does not understand.
 *   - `CallExpression` — the range text must start `getErrorMessage(` and end
 *     `)`. Only the callee name is rewritten, so any argument expression
 *     (nested parens, casts, member chains) is carried through byte-identically.
 *
 * ## What it deliberately does NOT touch
 *
 * Generated trees. `.claude/hooks/**` and `.codex/hooks/**` are compile outputs
 * of `.minsky/hooks/**`; converting the source and regenerating is the only
 * correct order, and the generated-file-edit guard blocks the alternative.
 *
 * Usage:
 *   bun scripts/codemod-loggable-error-summary.ts            # dry run
 *   bun scripts/codemod-loggable-error-summary.ts --execute  # write
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative, dirname, resolve } from "node:path";

const RULE_ID = "custom/prefer-loggable-error-summary";
const HELPER = "getLoggableErrorSummary";
const OLD_HELPER = "getErrorMessage";
const PACKAGE_SPECIFIER = "@minsky/domain/errors/index";

/** Compile outputs — convert the source tree and regenerate instead. */
const GENERATED_PREFIXES = [".claude/hooks/", ".codex/hooks/"];

interface Site {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  nodeType: string;
}

interface FileOutcome {
  file: string;
  converted: number;
  skipped: { line: number; text: string; reason: string }[];
  importAdded: boolean;
  oldImportRemoved: boolean;
}

/** Run ESLint over the repo and return the flagged sites, keyed by repo-relative path. */
function collectSites(repoRoot: string): Map<string, Site[]> {
  // ESLint exits non-zero when it finds errors, which is the EXPECTED case here
  // — the JSON report on stdout is what we want either way, so the exit code is
  // deliberately not treated as failure. `Bun.spawnSync` returns rather than
  // throwing on non-zero, which is why it suits this better than a `node:child_process`
  // call that would have to be caught (and `bun_over_node.mdc` requires it anyway).
  const proc = Bun.spawnSync(["bunx", "eslint", ".", "--format", "json"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = new TextDecoder().decode(proc.stdout);
  if (raw.trim().length === 0) {
    const stderr = new TextDecoder().decode(proc.stderr);
    throw new Error(`eslint produced no JSON report (exit ${proc.exitCode}): ${stderr}`);
  }

  const report = JSON.parse(raw) as {
    filePath: string;
    messages: (Site & { ruleId: string | null })[];
  }[];

  const sites = new Map<string, Site[]>();
  for (const entry of report) {
    const hits = entry.messages.filter((m) => m.ruleId === RULE_ID);
    if (hits.length === 0) continue;
    const rel = relative(repoRoot, entry.filePath);
    if (GENERATED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    sites.set(
      rel,
      hits.map((m) => ({
        line: m.line,
        column: m.column,
        endLine: m.endLine,
        endColumn: m.endColumn,
        nodeType: m.nodeType,
      }))
    );
  }
  return sites;
}

/**
 * The replacement text for one flagged range, or a reason it was skipped.
 *
 * `<E>` is carried through verbatim rather than assumed to be an identifier —
 * the rule matches on the AST shape, so the tested expression can be a member
 * chain or a cast, and reproducing it byte-for-byte is both simpler and safer
 * than parsing it.
 */
function rewriteRange(
  text: string,
  nodeType: string
): { ok: true; text: string } | { ok: false; reason: string } {
  if (nodeType === "ConditionalExpression") {
    const marker = " instanceof Error";
    const at = text.indexOf(marker);
    if (at <= 0) return { ok: false, reason: "no ' instanceof Error' in reported range" };
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- not a truncation for display: `at` is an index INTO this string found by indexOf, so it is already a valid UTF-16 boundary. safeTruncate would move the boundary and corrupt the splice.
    const expr = text.slice(0, at);
    // The same expression must appear in BOTH branches, or this is not the
    // shape the rule documents and we should not touch it.
    if (!text.endsWith(`String(${expr})`)) {
      return { ok: false, reason: `alternate is not String(${expr})` };
    }
    const consequentStart = text.indexOf("?", at);
    const colon = text.lastIndexOf(":");
    if (consequentStart < 0 || colon < consequentStart) {
      return { ok: false, reason: "could not locate ternary punctuation" };
    }
    const consequent = text.slice(consequentStart + 1, colon).trim();
    if (consequent !== `${expr}.message` && consequent !== `${expr}?.message`) {
      return { ok: false, reason: `consequent is ${consequent}, not ${expr}.message` };
    }
    return { ok: true, text: `${HELPER}(${expr})` };
  }

  if (nodeType === "CallExpression") {
    const prefix = `${OLD_HELPER}(`;
    if (!text.startsWith(prefix) || !text.endsWith(")")) {
      return { ok: false, reason: `not a ${OLD_HELPER}(...) call` };
    }
    // Rewrite ONLY the callee name; the argument text is carried through
    // untouched so nested parens and casts survive exactly.
    return { ok: true, text: HELPER + text.slice(OLD_HELPER.length) };
  }

  return { ok: false, reason: `unhandled nodeType ${nodeType}` };
}

/** Every top-level `import ... from "..."` statement, in source order. */
function findImportStatements(
  source: string
): { start: number; end: number; specifier: string; text: string }[] {
  const found: { start: number; end: number; specifier: string; text: string }[] = [];
  const re = /^import\s[\s\S]*?from\s+["']([^"']+)["'];[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const specifier = m[1];
    if (specifier === undefined) continue;
    found.push({ start: m.index, end: m.index + m[0].length, specifier, text: m[0] });
  }
  return found;
}

/**
 * Which module specifier this file should import the helper from.
 *
 * Files inside the domain package import it relatively — that is what all 20+
 * existing adopters do, and a package self-reference would be a new convention.
 */
function helperSpecifierFor(relPath: string): string {
  const DOMAIN_SRC = "packages/domain/src/";
  if (!relPath.startsWith(DOMAIN_SRC)) return PACKAGE_SPECIFIER;
  const target = resolve("/", DOMAIN_SRC, "errors/index");
  let rel = relative(resolve("/", dirname(relPath)), target);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Is this specifier the same errors module, written some other way? */
function isErrorsModule(specifier: string, wanted: string): boolean {
  if (specifier === wanted) return true;
  return (
    specifier === PACKAGE_SPECIFIER ||
    specifier === "@minsky/domain/errors" ||
    /(^|\/)errors(\/index)?$/.test(specifier)
  );
}

/** Add `getLoggableErrorSummary` to an existing named-import list, or return null. */
function addToExistingImport(source: string, wanted: string): string | null {
  for (const imp of findImportStatements(source)) {
    if (!isErrorsModule(imp.specifier, wanted)) continue;
    if (imp.text.startsWith("import type")) continue;
    const open = imp.text.indexOf("{");
    const close = imp.text.lastIndexOf("}");
    if (open < 0 || close < open) continue;
    const inner = imp.text.slice(open + 1, close);
    const multiline = inner.includes("\n");
    const rewritten = multiline
      ? `${imp.text.slice(0, close)}  ${HELPER},\n${imp.text.slice(close)}`
      : `${imp.text.slice(0, close).replace(/[\s,]*$/, "")}, ${HELPER} ${imp.text.slice(close)}`;
    return source.slice(0, imp.start) + rewritten + source.slice(imp.end);
  }
  return null;
}

/** Insert a fresh import line after the last existing import statement. */
function insertNewImport(source: string, wanted: string): string {
  const imports = findImportStatements(source);
  const line = `import { ${HELPER} } from "${wanted}";`;
  if (imports.length === 0) {
    // No imports at all — put it after any leading shebang/comment block, i.e.
    // at the first blank line, falling back to the very top.
    const firstBlank = source.indexOf("\n\n");
    if (firstBlank < 0) return `${line}\n${source}`;
    return `${source.slice(0, firstBlank + 1)}\n${line}${source.slice(firstBlank + 1)}`;
  }
  const last = imports[imports.length - 1];
  if (last === undefined) return `${line}\n${source}`;
  return `${source.slice(0, last.end)}\n${line}${source.slice(last.end)}`;
}

/** Does the file still USE `getErrorMessage` anywhere outside its import statements? */
function stillUsesOldHelper(source: string): boolean {
  let stripped = source;
  for (const imp of findImportStatements(source).reverse()) {
    stripped = stripped.slice(0, imp.start) + stripped.slice(imp.end);
  }
  return new RegExp(`\\b${OLD_HELPER}\\b`).test(stripped);
}

/**
 * Drop `getErrorMessage` from its import, removing the whole statement if it was
 * the only specifier. Returns null when there was nothing to remove.
 *
 * The word-boundary anchors matter: `getErrorMessageWithCause` is a DIFFERENT
 * export that several of these files also import, and a substring match would
 * silently mangle it.
 */
function removeOldHelperImport(source: string): string | null {
  for (const imp of findImportStatements(source)) {
    if (!new RegExp(`\\b${OLD_HELPER}\\b`).test(imp.text)) continue;
    const open = imp.text.indexOf("{");
    const close = imp.text.lastIndexOf("}");
    if (open < 0 || close < open) continue;
    const names = imp.text
      .slice(open + 1, close)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!names.includes(OLD_HELPER)) continue;
    const kept = names.filter((n) => n !== OLD_HELPER);
    if (kept.length === 0) {
      // Remove the statement and the newline it sits on.
      let end = imp.end;
      if (source[end] === "\n") end += 1;
      return source.slice(0, imp.start) + source.slice(end);
    }
    const rewritten = `${imp.text.slice(0, open)}{ ${kept.join(", ")} }${imp.text.slice(close + 1)}`;
    return source.slice(0, imp.start) + rewritten + source.slice(imp.end);
  }
  return null;
}

function processFile(repoRoot: string, relPath: string, sites: Site[]): FileOutcome {
  const abs = resolve(repoRoot, relPath);
  const original = readFileSync(abs, "utf8");
  const lines = original.split("\n");
  const outcome: FileOutcome = {
    file: relPath,
    converted: 0,
    skipped: [],
    importAdded: false,
    oldImportRemoved: false,
  };

  // Bottom-up so earlier columns keep their offsets as later ones are spliced.
  const ordered = [...sites].sort((a, b) => b.line - a.line || b.column - a.column);
  for (const site of ordered) {
    if (site.line !== site.endLine) {
      outcome.skipped.push({
        line: site.line,
        text: "<multi-line range>",
        reason: "range spans lines",
      });
      continue;
    }
    const lineText = lines[site.line - 1];
    if (lineText === undefined) {
      outcome.skipped.push({ line: site.line, text: "", reason: "line out of range" });
      continue;
    }
    const text = lineText.slice(site.column - 1, site.endColumn - 1);
    const rewrite = rewriteRange(text, site.nodeType);
    if (!rewrite.ok) {
      outcome.skipped.push({ line: site.line, text, reason: rewrite.reason });
      continue;
    }

    // eslint-disable-next-line custom/no-unsafe-string-truncation -- not a truncation for display: ESLint reports columns as UTF-16 code-unit offsets, so this is exactly the node's start boundary. safeTruncate would move it and splice the wrong text.
    const before = lineText.slice(0, site.column - 1);
    const after = lineText.slice(site.endColumn - 1);
    lines[site.line - 1] = before + rewrite.text + after;
    outcome.converted += 1;
  }

  if (outcome.converted === 0) return outcome;

  let updated = lines.join("\n");

  const wanted = helperSpecifierFor(relPath);
  if (!new RegExp(`\\b${HELPER}\\b`).test(original)) {
    const merged = addToExistingImport(updated, wanted);
    updated = merged ?? insertNewImport(updated, wanted);
    outcome.importAdded = true;
  }

  if (!stillUsesOldHelper(updated)) {
    const pruned = removeOldHelperImport(updated);
    if (pruned !== null) {
      updated = pruned;
      outcome.oldImportRemoved = true;
    }
  }

  if (process.argv.includes("--execute")) writeFileSync(abs, updated, "utf8");
  return outcome;
}

function main(): void {
  const execute = process.argv.includes("--execute");
  const repoRoot = process.cwd();

  console.log(`${execute ? "EXECUTE" : "DRY RUN"} — collecting ${RULE_ID} sites via eslint...`);
  const sites = collectSites(repoRoot);
  const totalSites = [...sites.values()].reduce((n, s) => n + s.length, 0);
  console.log(`Found ${totalSites} sites across ${sites.size} files (generated trees excluded).\n`);

  const outcomes: FileOutcome[] = [];
  for (const [relPath, fileSites] of [...sites.entries()].sort()) {
    outcomes.push(processFile(repoRoot, relPath, fileSites));
  }

  const converted = outcomes.reduce((n, o) => n + o.converted, 0);
  const skipped = outcomes.flatMap((o) => o.skipped.map((s) => ({ ...s, file: o.file })));
  const importsAdded = outcomes.filter((o) => o.importAdded).length;
  const importsRemoved = outcomes.filter((o) => o.oldImportRemoved).length;

  for (const o of outcomes) {
    if (o.converted === 0 && o.skipped.length === 0) continue;
    const flags = [
      o.importAdded ? "+import" : "",
      o.oldImportRemoved ? `-${OLD_HELPER}` : "",
    ].filter(Boolean);
    console.log(
      `${String(o.converted).padStart(3)}  ${o.file}${flags.length ? `  [${flags.join(" ")}]` : ""}`
    );
  }

  console.log(`\nconverted:       ${converted}`);
  console.log(`imports added:   ${importsAdded}`);
  console.log(`imports removed: ${importsRemoved}`);
  console.log(`skipped:         ${skipped.length}`);
  for (const s of skipped) {
    console.log(`  SKIP ${s.file}:${s.line} — ${s.reason}\n       ${s.text}`);
  }

  if (converted + skipped.length !== totalSites) {
    console.error(
      `\nACCOUNTING MISMATCH: ${converted} converted + ${skipped.length} skipped != ${totalSites} reported.`
    );
    process.exit(2);
  }

  if (!execute) console.log("\nNo files written. Re-run with --execute to apply.");
  process.exit(skipped.length > 0 ? 1 : 0);
}

main();
