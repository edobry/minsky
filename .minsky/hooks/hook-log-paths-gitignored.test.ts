/**
 * mt#2492 — every runtime log path a hook declares must be gitignored.
 *
 * These logs are local telemetry: they are written on ordinary turns, they
 * differ per machine and per session, and committing one puts one operator's
 * in-flight measurements into everyone's checkout. `.gitignore` covers them
 * with two globs (`**\/.minsky/*-calibration.jsonl`, `**\/.minsky/*-evaluations.jsonl`)
 * plus a few literals.
 *
 * The globs work. What had no check was whether a NEW producer's filename
 * actually lands inside one — and that is exactly how this test came to exist:
 * `cross-turn-hedge-detector.ts` hand-wrote `.minsky/cross-turn-hedge-evaluation.jsonl`,
 * SINGULAR, where all 31 siblings are plural. One character, so the glob missed
 * it, and it sat untracked for weeks. Nothing failed, because nothing looked:
 * a repo-wide grep for `check-ignore` returned zero matches before this file.
 *
 * The failure mode is invisible to every other gate — the file looks normal,
 * no test reads it, and CI never sees it. It surfaces only as untracked noise
 * in `git status` that a human eventually notices. So the check has to be
 * mechanical, and it has to run over the DECLARED paths rather than over
 * whatever happens to exist on disk: a path that no one has triggered yet has
 * no file, and is exactly the case worth catching before it does.
 */
/* eslint-disable custom/no-real-fs-in-tests -- this file's entire purpose is an
 * audit of the REAL repository: which paths the real hook sources declare, and
 * what the real `.gitignore` does with them. Mocking either side would mean
 * asserting against a fixture of the thing under test, which is precisely the
 * can't-fail probe this test exists to prevent. Same justification, and same
 * file-level form, as the sibling census `hook-module-inventory.test.ts`. */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS_DIR = join(import.meta.dir);

/**
 * Strip `//` and block comments, leaving string literals intact.
 *
 * A plain `.replace(/\/\/.*$/gm, "")` is wrong here: it would cut a URL inside
 * a string at its `//`, and more importantly the reverse case is what this
 * exists for — a path mentioned in PROSE is not a declaration. This file's own
 * subject is an example: `cross-turn-hedge-detector.ts` now documents the old
 * singular path in its docblock, and a scanner that could not tell comment from
 * code would read that as a live producer and fail the audit on a path nothing
 * writes. (PR #3474 review raised this; it was latent rather than firing,
 * because the docblock happens to use backticks.)
 *
 * So track string state while walking. Small, but the alternative is a check
 * that goes red on documentation.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Every `.minsky/<something>.json(l)` string literal appearing in hook CODE.
 *
 * Deliberately a source scan rather than an import-and-read-the-constant: the
 * constants are not uniformly named or exported (some are `EVALUATION_LOG`,
 * some `EVALUATION_LOG_NAME`, some inline), and importing every hook module to
 * enumerate them would execute their top-level side effects. The literal is
 * what ends up on disk, so the literal is what to check.
 */
function declaredLogPaths(): string[] {
  const paths = new Set<string>();
  for (const entry of readdirSync(HOOKS_DIR)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const src = stripComments(readFileSync(join(HOOKS_DIR, entry), "utf-8"));
    for (const m of src.matchAll(/["'](\.minsky\/[A-Za-z0-9._-]+\.jsonl?)["']/g)) {
      const p = m[1];
      if (p) paths.add(p);
    }
  }
  return [...paths].sort();
}

/** Paths the shared helper derives from a bare stream name (mt#3745). */
function derivedLogPaths(): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(HOOKS_DIR)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const src = stripComments(readFileSync(join(HOOKS_DIR, entry), "utf-8"));
    for (const m of src.matchAll(/EVALUATION_LOG_NAME\s*=\s*["']([A-Za-z0-9._-]+)["']/g)) {
      const n = m[1];
      if (n) names.add(`.minsky/${n}-evaluations.jsonl`);
    }
  }
  return [...names].sort();
}

function isIgnored(relPath: string): boolean {
  // `check-ignore` exits 0 when the path IS ignored, 1 when it is not. Run from
  // the repo root so relative paths resolve the way git will see them.
  // Bun.spawnSync rather than node:child_process per `bun_over_node.mdc`.
  const res = Bun.spawnSync(["git", "check-ignore", "-q", relPath], {
    cwd: join(HOOKS_DIR, "..", ".."),
    stdout: "ignore",
    stderr: "ignore",
  });
  return res.exitCode === 0;
}

describe("stripComments — the scanner only sees code (PR #3474 R1)", () => {
  it("drops a path mentioned in a line comment", () => {
    const src = '// was ".minsky/old-name.jsonl"\nconst X = ".minsky/real.jsonl";';
    expect(stripComments(src)).not.toContain("old-name");
    expect(stripComments(src)).toContain("real.jsonl");
  });

  it("drops a path mentioned in a block comment", () => {
    const src = '/* see ".minsky/doc-example.jsonl" */\nconst X = ".minsky/real.jsonl";';
    expect(stripComments(src)).not.toContain("doc-example");
    expect(stripComments(src)).toContain("real.jsonl");
  });

  it("does NOT cut a string at a URL's slashes", () => {
    // The naive `s/\/\/.*$//` fix would truncate here and silently drop any
    // declaration later on the same line.
    const src = 'const U = "https://example.com/x"; const X = ".minsky/real.jsonl";';
    expect(stripComments(src)).toContain("https://example.com/x");
    expect(stripComments(src)).toContain("real.jsonl");
  });

  it("keeps a comment-looking sequence that is inside a string", () => {
    const src = 'const S = "not /* a comment */ really"; const X = ".minsky/real.jsonl";';
    expect(stripComments(src)).toContain("not /* a comment */ really");
    expect(stripComments(src)).toContain("real.jsonl");
  });
});

describe("every hook log path is gitignored (mt#2492)", () => {
  const paths = [...new Set([...declaredLogPaths(), ...derivedLogPaths()])].sort();

  it("finds a non-trivial set of declared log paths", () => {
    // Guards the guard: an enumeration that silently returns [] would make every
    // assertion below vacuously pass, which is the shape this whole test exists
    // to prevent one level down. 20 is a floor well under the ~32 observed, so
    // it tolerates real churn without tolerating a broken scan.
    expect(paths.length).toBeGreaterThan(20);
  });

  it.each(paths)("%s is ignored", (relPath) => {
    expect(isIgnored(relPath)).toBe(true);
  });
});
