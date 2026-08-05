/**
 * Resolve the TypeScript checker binary this repo PINS (mt#3657).
 *
 * Every typecheck surface used to spawn `bunx @typescript/native-preview`, and that command
 * does not run the pinned dependency. `bunx` looks for a local bin matching the PACKAGE
 * name; this package's bin is `tsgo`, so the lookup misses and bunx fetches `@latest` from
 * the registry into a temp dir instead. Measured on 2026-08-04:
 *
 *   ./node_modules/.bin/tsgo --version          -> 7.0.0-dev.20260419.1   (what package.json pins)
 *   bunx @typescript/native-preview --version   -> 7.0.0-dev.20260707.2   (what actually ran)
 *
 * Three months of drift between the declared compiler and the running one, plus a download
 * racing the typecheck inside the same invocation — the two together produced the SIGKILLs
 * and the phantom `lib`-mismatch error walls recorded on mt#3657, mt#3546, and mt#1383.
 *
 * **There is deliberately no `bunx` fallback.** Falling back would silently restore the exact
 * behavior this module exists to remove, and it would do so at the moment the local install is
 * broken — i.e. when the operator most needs to be told. A missing binary is reported as a TOOL
 * failure naming the remedy; callers must not treat it as "no type errors".
 *
 * @see .minsky/hooks/types.ts `resolveTsgoBinary` — the hook-tree sibling. The hooks cannot
 *   import from `src/`, so the resolution is stated once per tree rather than shared.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

/** The npm package that provides the checker. Its bin is `tsgo`, NOT the package name. */
export const TSGO_PACKAGE = "@typescript/native-preview";

/** Where a `bun install` puts the checker's bin, relative to the directory it ran in. */
export const TSGO_BIN_RELATIVE = join("node_modules", ".bin", "tsgo");

export type TsgoBinaryResolution =
  | {
      kind: "resolved";
      binaryPath: string;
      /** The directory whose `node_modules` provided the binary — where the pin lives. */
      installRoot: string;
    }
  | { kind: "missing"; searchedPaths: string[]; message: string };

/**
 * Decide which binary to run, given a starting directory and an existence predicate.
 *
 * Walks UP from `start`, the way a package manager resolves a bin. This is not incidental:
 * `services/reviewer` is a workspace with its own tsconfig and NO `node_modules/.bin` of its
 * own — the install is hoisted to the repo root. Resolving only in `start` reported that
 * workspace as "checker missing" and silently stopped typechecking it, which
 * `scripts/smoke-validate-typecheck-workspaces.ts` caught during this task's own
 * implementation (AT-3 flagged `workspaces=[]`). The `bunx` path this replaces never had the
 * problem because it resolved globally rather than from the tree.
 *
 * Pure — the predicate is the only I/O, injected so both branches are testable without
 * touching a real `node_modules`.
 */
export function decideTsgoBinary(
  start: string,
  exists: (path: string) => boolean
): TsgoBinaryResolution {
  const searchedPaths: string[] = [];
  let dir = start;

  for (;;) {
    const candidate = join(dir, TSGO_BIN_RELATIVE);
    searchedPaths.push(candidate);
    if (exists(candidate)) {
      return { kind: "resolved", binaryPath: candidate, installRoot: dir };
    }
    const parent = dirname(dir);
    // `dirname("/") === "/"` — the fixed point IS the termination condition.
    if (parent === dir) break;
    dir = parent;
  }

  return {
    kind: "missing",
    searchedPaths,
    message:
      `the TypeScript checker did not run — no ${TSGO_PACKAGE} binary found in any ` +
      `node_modules from ${start} upward (looked in ${searchedPaths.length} location(s), ` +
      `nearest: ${searchedPaths[0]}). Run \`bun install\`. Nothing was typechecked, so this ` +
      "is a TOOL failure and says nothing about whether the code has type errors.",
  };
}

/** {@link decideTsgoBinary} against the real filesystem. */
export function resolveTsgoBinary(root: string): TsgoBinaryResolution {
  return decideTsgoBinary(root, existsSync);
}

/**
 * The checker version `package.json` declares, from its text.
 *
 * Pure. Returns null when the file is unparseable or declares no pin — callers report the
 * version they actually ran either way; the pin is only used to say what SHOULD run.
 */
export function parsePinnedTsgoVersion(packageJsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const deps = (parsed as { devDependencies?: unknown }).devDependencies;
  if (typeof deps !== "object" || deps === null) return null;
  const pin = (deps as Record<string, unknown>)[TSGO_PACKAGE];
  return typeof pin === "string" && pin.length > 0 ? pin : null;
}

/** {@link parsePinnedTsgoVersion} against the real filesystem. Null when unreadable. */
export function readPinnedTsgoVersion(root: string): string | null {
  try {
    return parsePinnedTsgoVersion(readFileSync(join(root, "package.json"), "utf8").toString());
  } catch {
    return null;
  }
}
