/**
 * Read the `InterceptionPoint` union from each of its three declarations, and
 * the runtime `POINTS` gate (mt#4129).
 *
 * The union is declared three times and the duplication is structurally forced:
 * the hook tree may not import from `src/` (mt#4010's generated-artifact
 * boundary, pinned by `tests/unit/hook-tree-import-boundary.test.ts`), and
 * cockpit-web may not import from `.minsky/hooks/**` (the
 * `no-node-import-in-cockpit-web` guard, mt#3239). Nothing structural can make
 * them one declaration, so something has to assert they stay identical — a
 * one-sided widening is silently unenforced coverage, which is mt#4129's own
 * subject.
 *
 * The reading lives HERE rather than in the test for the same reason
 * `derivePrecommitStepNames` does: `custom/no-real-fs-in-tests` forbids a test
 * touching the filesystem, and the established shape is a script module that
 * reads while the test asserts.
 *
 * Compared as SOURCE TEXT because a type union has no runtime representation. A
 * hand-maintained runtime array beside each union would be a fourth copy with
 * the same drift problem it exists to catch.
 *
 * @see scripts/precommit-step-names.ts — the read-in-a-script-module precedent
 * @see tests/unit/interceptor-points.test.ts — the assertions over this
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Where each copy of the union lives, labelled for the failure message. */
export const INTERCEPTION_POINT_SOURCES: Readonly<Record<string, string>> = {
  "cockpit-web reader": "src/cockpit/web/hooks/useInterceptors.ts",
  "widget model": "src/cockpit/widgets/interceptors.ts",
  "hook-tree resolver": ".minsky/hooks/interceptor-coordinates.ts",
};

/** Strip block and line comments so annotations inside a declaration are ignored. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The string-literal members of the `InterceptionPoint` union declared in `source`.
 *
 * Comments are stripped from the WHOLE source before the declaration is matched,
 * not from the captured body afterwards: the declaration match runs non-greedily
 * to the first `;`, so a comment containing one — mt#4129 annotates its
 * additions inline, mid-union — truncates the capture and yields a short member
 * list that reads as a source divergence rather than a parser bug. It did, on
 * this parser's first run.
 */
export function parseUnionMembers(source: string): string[] {
  const declaration = /export type InterceptionPoint\s*=([\s\S]*?);/.exec(stripComments(source));
  if (!declaration?.[1]) throw new Error("no `export type InterceptionPoint` declaration found");
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").sort();
}

/** The members of a named `readonly string[]` / `Set<string>` list in `source`. */
function parseNamedList(source: string, declaration: RegExp, label: string): string[] {
  const match = declaration.exec(stripComments(source));
  if (!match?.[1]) throw new Error(`no \`${label}\` declaration found`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").sort();
}

/** The members of the runtime `POINTS` Set that gates `derivePoint`. */
export function parsePointsGate(source: string): string[] {
  return parseNamedList(source, /const POINTS = new Set<string>\(\[([\s\S]*?)\]\)/, "POINTS");
}

/**
 * The members of `VALID_POINTS`, the runtime validator `parseCatalog` throws on.
 *
 * A fifth site carrying these names, and the one with the loudest failure: a
 * point missing here rejects the whole catalog rather than degrading. mt#4129
 * missed it, and the pre-commit related-test gate caught it — which is why it is
 * pinned here now rather than left to the next widening.
 */
export function parseValidPoints(source: string): string[] {
  return parseNamedList(
    source,
    /const VALID_POINTS: readonly string\[\] = \[([\s\S]*?)\]/,
    "VALID_POINTS"
  );
}

/**
 * File contents as a string.
 *
 * `String(...)` rather than the encoding overload: under this project's tsconfig
 * `readFileSync` resolves to `string | Buffer` even with an encoding argument,
 * and both branches stringify to the same UTF-8 text.
 */
function readSource(relativePath: string): string {
  return String(readFileSync(join(REPO_ROOT, relativePath)));
}

/** Every declaration's members, keyed by the label its source is known as. */
export function readInterceptionPointUnions(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [label, path] of Object.entries(INTERCEPTION_POINT_SOURCES)) {
    result[label] = parseUnionMembers(readSource(path));
  }
  return result;
}

/** The runtime gate's members, read from the resolver that declares it. */
export function readPointsGate(): string[] {
  return parsePointsGate(readSource(".minsky/hooks/interceptor-coordinates.ts"));
}

/** `VALID_POINTS`' members, read from the widget model that declares it. */
export function readValidPoints(): string[] {
  return parseValidPoints(readSource("src/cockpit/widgets/interceptors.ts"));
}

/**
 * The axis-1 point list in the ontology doc, between its `axis-1-points` markers.
 *
 * A SIXTH copy, and the only one in prose — so the only one that would rot with
 * nothing failing (PR #3057 R1 caught exactly that). Fencing it in HTML comments
 * and parsing it turns the caveat into an assertion. Every name in the list must
 * be backticked; the markers say so at the site.
 */
export function readDocPoints(): string[] {
  const source = readSource("docs/architecture/interceptors.md");
  const block = /<!-- axis-1-points:start[\s\S]*?-->([\s\S]*?)<!-- axis-1-points:end -->/.exec(
    source
  );
  if (!block?.[1]) throw new Error("no `axis-1-points` marker block found");
  return [...block[1].matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").sort();
}
