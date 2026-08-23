/**
 * @fileoverview mt#4132 — the staleness backstop for `allowedExact` in
 * `custom/no-node-import-in-cockpit-web`.
 *
 * The rule exempts a specifier by STRING and never opens the target module: `isBannedSpecifier`
 * returns false as soon as `allowedExact.includes(spec)`, before the prefix check. So an
 * allowlisted module that LATER grows a Node dependency is silently exempt from the guard that
 * exists to catch it — the rule's own doc says exactly that. The author's spot-check at
 * authoring time was the only thing holding the bar, and nothing re-ran it. This file re-runs it
 * on every CI run.
 *
 * **The bar enforced here is the one the rule documents: no Node dependency ONE HOP DEEP.**
 * Not "no runtime imports at all" — `@minsky/domain/ask/state-machine` carries a real runtime
 * edge to a leaf module and is safe, so that stricter reading would flag a shipped, correct
 * entry. Not the full transitive walk either, which the rule deliberately does not attempt: a
 * chain deeper than one hop FAILS here, with a message saying that clearing it needs the
 * transitive walk (out of scope per mt#4132 `## Scope`), not a quieter criterion.
 *
 * Erasure semantics match the rule's own `isTypeOnly` exactly: a whole-declaration `import type`
 * / `export type` is erased at build and contributes no runtime edge; anything else is one. An
 * inline-type-only import (`import { type X } from "y"`) counts as a runtime edge here,
 * deliberately — the rule itself flags that form, so an allowlist entry resting on it would be
 * exempt from a check the rule would otherwise apply.
 */

import config from "../eslint.config";
import * as tsParser from "@typescript-eslint/parser";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const RULE_ID = "custom/no-node-import-in-cockpit-web";
const REPO_ROOT = resolve(import.meta.dir, "..");
const NODE_BUILTINS = new Set(builtinModules);
const NODE_GLOBALS = new Set(["process", "__dirname", "__filename"]);

/** Every flat-config block that registers the rule — read from the config, never hand-copied. */
const blocks = config.filter((entry) => entry?.rules?.[RULE_ID]);

function optionsOf(block) {
  const entry = block.rules[RULE_ID];
  return Array.isArray(entry) ? entry[1] : undefined;
}

function repoRelative(file) {
  return relative(REPO_ROOT, file);
}

/**
 * Depth-first AST walk. Skips the non-computed `property` of a member expression and the
 * non-computed `key` of a property, so `foo.process` and `{ process: 1 }` are not mistaken for
 * a reference to the Node global.
 *
 * Detection is by NAME, not by scope: a module that declares its own local `process` or
 * `require` would be flagged (PR #3035 R1). That is deliberate rather than unnoticed. The
 * error is one-directional — it fails CLOSED, naming the file and line, on a module that
 * shadows a Node global while claiming to be browser-safe — and the alternative is scope
 * analysis over every allowlisted module to spare a shape that appears nowhere in this
 * corpus. If that false positive ever fires, the entry deserves the second look anyway.
 */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);

  let skip;
  if (node.type === "MemberExpression" && !node.computed) skip = "property";
  else if ((node.type === "Property" || node.type === "PropertyDefinition") && !node.computed) {
    skip = "key";
  }

  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range" || key === skip) continue;
    walk(node[key], visit);
  }
}

/** The runtime import edges and Node-global references of one file. */
function analyze(file) {
  const ast = tsParser.parse(readFileSync(file, "utf8"), {
    sourceType: "module",
    loc: true,
    // Per-extension, not global: `.tsx` needs the JSX flag, and setting it for `.ts` would
    // misparse the type-assertion form `<T>expr`. Without it a `.tsx` module — which
    // `resolveRelativeSpecifier` will happily resolve — throws a parse error instead of
    // reporting a finding (PR #3035 R1). No `project` option: this is syntax-only analysis,
    // and type-aware parsing would cost a full program build for nothing.
    ecmaFeatures: { jsx: file.endsWith(".tsx") },
  });
  const imports = [];
  const nodeGlobals = [];

  for (const node of ast.body) {
    const isImport = node.type === "ImportDeclaration";
    const isReExport =
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      Boolean(node.source);
    if (!isImport && !isReExport) continue;
    // Matches the rule's `isTypeOnly`: whole-declaration type imports/exports are erased.
    if ((node.importKind ?? node.exportKind) === "type") continue;
    imports.push({ spec: node.source.value, line: node.loc.start.line });
  }

  walk(ast, (node) => {
    if (node.type === "Identifier" && NODE_GLOBALS.has(node.name)) {
      nodeGlobals.push({ name: node.name, line: node.loc.start.line });
      return;
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      nodeGlobals.push({ name: "require()", line: node.loc.start.line });
    }
  });

  return { imports, nodeGlobals };
}

/** Resolve a `@minsky/<pkg>[/<subpath>]` specifier through that package's own `exports` map. */
function resolveWorkspaceSpecifier(spec) {
  const match = /^@minsky\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (!match) return null;

  const pkgDir = join(REPO_ROOT, "packages", match[1]);
  const manifest = join(pkgDir, "package.json");
  if (!existsSync(manifest)) return null;

  const exportsMap = JSON.parse(readFileSync(manifest, "utf8")).exports ?? {};
  const subpath = match[2] ? `./${match[2]}` : ".";

  // Explicit entries win over the `"./*"` catch-all, so `@minsky/domain/tasks` resolves to its
  // declared `src/tasks/index.ts` rather than a nonexistent `src/tasks.ts`.
  let target = exportsMap[subpath];
  if (target === undefined) {
    for (const [pattern, value] of Object.entries(exportsMap)) {
      const star = pattern.indexOf("*");
      if (star === -1) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      if (subpath.length < prefix.length + suffix.length) continue;
      target = value.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
      break;
    }
  }

  if (typeof target !== "string") return null;
  const file = join(pkgDir, target);
  return existsSync(file) ? file : null;
}

/** Resolve a relative specifier from `fromFile`, trying the extensions this repo actually uses. */
function resolveRelativeSpecifier(spec, fromFile) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith(".")) return fromFile ? resolveRelativeSpecifier(spec, fromFile) : null;
  return resolveWorkspaceSpecifier(spec);
}

/**
 * Node-dependency findings for ONE file, reported under `label`. `bannedExact` comes from the
 * rule's own options so a hit names the module the guard bans by name.
 */
function nodeDependencies(file, label, bannedExact) {
  const { imports, nodeGlobals } = analyze(file);
  const findings = [];

  for (const { spec, line } of imports) {
    const where = `${label} (${repoRelative(file)}:${line})`;
    if (spec.startsWith("node:") || NODE_BUILTINS.has(spec)) {
      findings.push(`${where} imports the Node built-in "${spec}"`);
    } else if (bannedExact.includes(spec)) {
      findings.push(`${where} imports "${spec}", which this rule bans outright`);
    }
  }

  for (const { name, line } of nodeGlobals) {
    findings.push(
      `${label} (${repoRelative(file)}:${line}) references the Node global \`${name}\``
    );
  }

  return { findings, imports };
}

/** Every reason `spec` is no longer safe to exempt. Empty means the entry still holds. */
function stalenessFindings(spec, options) {
  const bannedExact = options.bannedExact ?? [];
  const file = resolveSpecifier(spec, null);
  if (!file) {
    return [
      `${spec} does not resolve to a source file — the allowlist entry is stale or misspelled`,
    ];
  }

  const direct = nodeDependencies(file, spec, bannedExact);
  const findings = [...direct.findings];

  for (const { spec: hopSpec, line } of direct.imports) {
    const at = `${spec} (${repoRelative(file)}:${line}) imports "${hopSpec}"`;
    const hopFile = resolveSpecifier(hopSpec, file);

    if (!hopFile) {
      findings.push(
        `${at}, which does not resolve — this check cannot confirm it is Node-free, so the entry fails closed`
      );
      continue;
    }

    const hop = nodeDependencies(hopFile, `${spec} -> "${hopSpec}"`, bannedExact);
    findings.push(...hop.findings);

    if (hop.imports.length > 0) {
      const [first] = hop.imports;
      findings.push(
        `${at}, which itself imports "${first.spec}" (${repoRelative(hopFile)}:${first.line}) — two hops, past what this check verifies. Clearing that needs the transitive walk mt#4132 leaves out of scope, not a looser criterion here.`
      );
    }
  }

  return findings;
}

describe("the rule's coverage stays whole (mt#4132)", () => {
  test("it is registered for both cockpit-web trees, .ts and .tsx", () => {
    const globs = blocks.flatMap((block) => block.files ?? []);
    expect(globs.every((glob) => glob.startsWith("src/cockpit/web/"))).toBe(true);
    expect(globs.some((glob) => glob.endsWith("*.ts"))).toBe(true);
    expect(globs.some((glob) => glob.endsWith("*.tsx"))).toBe(true);
  });

  test("every registering block enforces the same options", () => {
    // Both blocks reference one shared const today. What matters is that they enforce the same
    // policy, not that they are the same object — so this compares by value: a second copy is
    // fine until it drifts, and the drift is what silently halves coverage.
    expect(blocks.length).toBeGreaterThan(1);
    const [first, ...rest] = blocks.map(optionsOf);
    expect(first).toBeDefined();
    for (const other of rest) expect(other).toEqual(first);
  });
});

describe("every allowedExact entry is still Node-free one hop deep (mt#4132)", () => {
  const options = optionsOf(blocks[0]) ?? {};
  const allowed = options.allowedExact ?? [];

  test("the allowlist is read from the config and is non-empty", () => {
    expect(allowed.length).toBeGreaterThan(0);
  });

  test.each(allowed)("%s", (spec) => {
    expect(stalenessFindings(spec, options)).toEqual([]);
  });
});
