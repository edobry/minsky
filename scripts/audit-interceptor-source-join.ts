#!/usr/bin/env bun
/**
 * Account for every hook FILE on disk against the interceptor catalog (mt#4229).
 *
 * ## Why this exists
 *
 * `/plant/interlock-history` used to LIST all 160 files under `.minsky/hooks/`
 * and `.claude/hooks/`, calling each an "interlock". mt#4229 absorbed that page
 * into `/interceptors`, which is keyed by `guardName` and carries 134 entries —
 * so the rows that do not correspond to a catalog entry stopped being rendered
 * anywhere.
 *
 * That is the CORRECT outcome for most of them: `dispatcher.ts`, `fire-log.ts`,
 * `known-guard-names.ts` and the catalog's own data modules are shared library
 * code, not enforcement points, and the old page was over-inclusive in calling
 * them interlocks. But "correctly not rendered" and "silently dropped" look
 * identical from outside, which is exactly the absence-vs-declaration
 * conflation the umbrella (mt#3754) exists to end. So the disappearance is
 * ACCOUNTED FOR here rather than assumed benign.
 *
 * ## The three states, and which one can fail
 *
 * Every file lands in exactly one:
 *
 *   - JOINED         — a catalog entry names it via `sourceFile`. It renders on
 *                      `/interceptors/:name` with its install provenance.
 *   - SUPPORT MODULE — nothing claims it intercepts: no catalog entry, and no
 *                      registration in `.claude/settings.json`. Shared code.
 *   - UNRESOLVED     — something DOES claim it intercepts (it is registered)
 *                      but no catalog entry names it. A real gap: the corpus
 *                      says this file enforces something and the catalog cannot
 *                      show it.
 *
 * Only UNRESOLVED fails. The other two counts are REPORTED on every run rather
 * than left implicit — a number a reader can watch move is the difference
 * between "we checked" and "we assumed zero" (mem#704).
 *
 * Note the direction: this walks FILES and asks what the catalog knows. The
 * sibling `audit-settings-hook-coverage.ts` walks REGISTRATIONS and asks the
 * same. Neither subsumes the other — a file nothing registers is invisible to
 * that one, and a registration with no file is invisible to this one.
 *
 * Usage:
 *   bun scripts/audit-interceptor-source-join.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSettingsHookNames } from "./interceptor-coordinate-input";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CATALOG_PATH = join(REPO_ROOT, "src", "generated", "interceptor-catalog.json");
const HOOK_DIRS = [".minsky/hooks", ".claude/hooks"] as const;

/**
 * A hook SOURCE file. Excludes tests and type-only siblings the same way the
 * topology derivation does — a `.test.ts` is not a candidate interceptor, and
 * counting one would manufacture an unresolved row that no fix could clear.
 */
function isHookSourceFile(filename: string): boolean {
  if (!filename.endsWith(".ts")) return false;
  if (filename.endsWith(".test.ts") || filename.endsWith(".d.ts")) return false;
  return true;
}

function hookFilesOnDisk(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const dir of HOOK_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(join(REPO_ROOT, dir));
    } catch {
      continue;
    }
    for (const filename of entries) {
      if (!isHookSourceFile(filename)) continue;
      const name = filename.slice(0, -".ts".length);
      // `.minsky/hooks` wins: `.claude/hooks` is its generated copy.
      if (!byName.has(name) || dir === ".minsky/hooks") byName.set(name, dir);
    }
  }
  return byName;
}

interface CatalogShape {
  entries?: { guardName?: string; sourceFile?: string | null }[];
}

function main(): void {
  let catalog: CatalogShape;
  try {
    catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as CatalogShape;
  } catch {
    console.error(
      `FAIL: could not read the catalog at ${CATALOG_PATH}.\n` +
        "  Run `bun run build:interceptor-catalog` first."
    );
    process.exit(1);
    return;
  }
  const entries = catalog.entries ?? [];
  const claimedFiles = new Set(
    entries.map((e) => e.sourceFile).filter((f): f is string => typeof f === "string")
  );

  // A failure to READ the registrations is not "nothing is registered" — that
  // would silently reclassify every unresolved row as a support module, which is
  // the direction that hides a gap.
  const registered = readSettingsHookNames();
  if (!registered) {
    console.error(
      "FAIL: could not derive hook registrations from .claude/settings.json.\n" +
        "  Without them an unresolved file is indistinguishable from a support module,\n" +
        "  so this audit cannot report a result it would stand behind."
    );
    process.exit(1);
    return;
  }
  const registeredSet = new Set(registered);

  const files = hookFilesOnDisk();
  const joined: string[] = [];
  const support: string[] = [];
  const unresolved: string[] = [];

  for (const [name] of [...files].sort()) {
    if (claimedFiles.has(name)) joined.push(name);
    else if (registeredSet.has(name)) unresolved.push(name);
    else support.push(name);
  }

  console.log("interceptor source-join audit (mt#4229)");
  console.log("");
  console.log(`     hook source files on disk : ${files.size}`);
  console.log(`     JOINED to a catalog entry : ${joined.length}`);
  console.log(`     support modules (unclaimed): ${support.length}`);
  console.log(`     UNRESOLVED                : ${unresolved.length}`);

  if (unresolved.length > 0) {
    const lines = unresolved.map((n) => `  UNRESOLVED: ${n}`).join("\n");
    console.error(
      `\nFAIL: ${unresolved.length} hook file(s) are REGISTERED but have no catalog entry\n` +
        `naming them:\n${lines}\n\n` +
        "  Something claims these intercept, and the catalog cannot show them. Either\n" +
        "  author a description whose `provenance[0]` points at the file, or remove the\n" +
        "  registration."
    );
    process.exit(1);
  }

  console.log("\nOK");
}

main();
