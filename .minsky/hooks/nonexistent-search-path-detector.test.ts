/**
 * Unit tests for nonexistent-search-path-detector (mt#4215).
 *
 * The SILENT cases carry more weight here than the firing one. This guard's whole design bet is
 * that a nonexistent path argument is distinguishable from the four legitimate shapes that surround
 * it — a glob that matches nothing, a path in a variable, a pattern that looks like a path, and a
 * `--include`/`--exclude` filter value. Every one of those appears in ordinary correct commands, so
 * a guard that cannot tell them apart becomes the unmatchable noise mem#719 records as eroding
 * trust in a detector's true positives.
 *
 * AT1 is also a false-positive assertion, not only a recall one: the originating command carries a
 * real path (`cockpit-tray/src`) beside its two broken ones, so the same test proves the guard
 * discriminates within a single argument list.
 */

import { describe, test, expect } from "bun:test";
import {
  buildWarning,
  editDistance,
  isUnresolvable,
  pathArgs,
  positionalArgs,
  renderWorstCase,
  scanCommand,
  suppliesPattern,
  tokenize,
  type SearchPathFs,
} from "./nonexistent-search-path-detector";

const REPO = "/repo";

/**
 * The originating incident's tree, as it actually is — verified against the real repo 2026-08-17.
 * `cockpit-tray/src` EXISTS (it is the Tauri frontend tree); the tray's Rust source lives under
 * `cockpit-tray/src-tauri/src`. The spec originally recorded all three paths as nonexistent, and
 * this fixture is where that correction is pinned.
 */
const EXISTING = new Set([
  "/repo",
  "/repo/src",
  "/repo/src/cockpit",
  "/repo/packages",
  "/repo/infra",
  "/repo/cockpit-tray",
  "/repo/cockpit-tray/src",
  "/repo/cockpit-tray/src-tauri",
  "/repo/cockpit-tray/src-tauri/src",
  "/repo/scripts",
  "/repo/scripts/build.ts",
]);

const LISTINGS: Record<string, string[]> = {
  "/repo": ["src", "packages", "infra", "cockpit-tray", "scripts"],
  "/repo/src": ["cockpit", "adapters", "domain"],
  "/repo/src/cockpit": ["auth.ts", "conversation-id-space.ts", "web"],
  "/repo/cockpit-tray": ["src", "src-tauri"],
};

const fakeFs: SearchPathFs = {
  existsSync: (p) => EXISTING.has(p),
  readdirSync: (p) => LISTINGS[p] ?? [],
  isDirectory: (p) => EXISTING.has(p) && !p.endsWith(".ts"),
};

const scan = (command: string, cwd = REPO, relativeBaseKnown = true) =>
  scanCommand(command, { cwd, relativeBaseKnown, fs: fakeFs });

// ---------------------------------------------------------------------------
// AT1 — the originating command
// ---------------------------------------------------------------------------

describe("AT1 — the originating incident's exact command", () => {
  const ORIGINATING =
    "grep -rniE 'memory|ceiling|footprint|rss' --include='*.ts' " +
    "src/cockpit/tray src/tray cockpit-tray/src 2>/dev/null";

  test("fires, and names exactly the TWO nonexistent paths", () => {
    const result = scan(ORIGINATING);
    expect(result.matched).toBe(true);
    expect(result.binary).toBe("grep");
    expect(result.missing.map((m) => m.raw)).toEqual(["src/cockpit/tray", "src/tray"]);
  });

  test("does NOT name `cockpit-tray/src`, which exists", () => {
    // The false-positive half. That path returned nothing because `--include='*.ts'` excluded
    // every file under it — the filter-mismatch cause, which this guard is explicitly not for.
    const result = scan(ORIGINATING);
    expect(result.missing.map((m) => m.raw)).not.toContain("cockpit-tray/src");
  });

  test("locates the boundary between what exists and what does not", () => {
    const [first, second] = scan(ORIGINATING).missing;
    expect(first?.deepestExistingAncestor).toBe("src/cockpit");
    expect(first?.failedSegment).toBe("tray");
    expect(second?.deepestExistingAncestor).toBe("src");
    expect(second?.failedSegment).toBe("tray");
  });

  test("offers no suggestion when nothing in the ancestor resembles the failed segment", () => {
    // `cockpit-tray` is at the repo root, not under `src/cockpit`. A guard in THIS family that
    // guessed it from `src/cockpit/tray` would be committing the error it exists to prevent.
    for (const entry of scan(ORIGINATING).missing) {
      expect(entry.suggestions).toEqual([]);
    }
  });

  test("stderr suppression is irrelevant to whether it fires", () => {
    const withoutSuppression = ORIGINATING.replace(" 2>/dev/null", "");
    expect(scan(withoutSuppression).matched).toBe(true);
    expect(scan(ORIGINATING).matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AT2 — mem#500's originating shape
// ---------------------------------------------------------------------------

describe("AT2 — mem#500's originating shape (a `src/cockpit/` path from cwd `infra/`)", () => {
  test("fires, and reports that `src` itself is what does not resolve from here", () => {
    const result = scan(
      "grep -rn 'credential' --include='*.ts' src/cockpit/ 2>/dev/null",
      "/repo/infra"
    );
    expect(result.matched).toBe(true);
    expect(result.missing[0]?.raw).toBe("src/cockpit/");
    expect(result.missing[0]?.failedSegment).toBe("src");
  });

  test("the same command from the repo root is silent", () => {
    expect(scan("grep -rn 'credential' --include='*.ts' src/cockpit/", REPO).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT3 — the four legitimate shapes, each asserted individually
// ---------------------------------------------------------------------------

describe("AT3 — legitimate shapes produce silence", () => {
  test("(a) a glob that intentionally matches nothing", () => {
    expect(scan("grep -rn foo src/*.nonexistent").matched).toBe(false);
    expect(scan("grep -rn foo 'src/**/*.rs'").matched).toBe(false);
  });

  test("(b) a path supplied by a variable the guard cannot resolve", () => {
    expect(scan('grep -rn foo "$DIR"').matched).toBe(false);
    expect(scan("grep -rn foo $(git rev-parse --show-toplevel)/nope").matched).toBe(false);
  });

  test("(c) a pattern that merely LOOKS like a path", () => {
    // `src/foo` is the PATTERN; `.` is the only path argument, and it exists.
    const result = scan("grep -r 'src/foo' .");
    expect(result.matched).toBe(false);
  });

  test("(d) `--include` / `--exclude` values are filters, not targets", () => {
    // Both the attached (`=`) and detached forms, and a value that would look damning if read as
    // a path: `node_modules` does not exist in the fixture tree.
    expect(scan("grep -rn foo --include='*.ts' --exclude-dir=node_modules src").matched).toBe(
      false
    );
    expect(scan("grep -rn foo --include '*.ts' --exclude-dir node_modules src").matched).toBe(
      false
    );
    expect(scan("rg foo -g '!*.test.ts' src").matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT4 — a correct search stays silent, with and without suppression
// ---------------------------------------------------------------------------

describe("AT4 — a correct search over real paths is silent", () => {
  test("with and without `2>/dev/null`", () => {
    expect(scan("grep -rn foo src packages 2>/dev/null").matched).toBe(false);
    expect(scan("grep -rn foo src packages").matched).toBe(false);
  });

  test("a file path, not only a directory", () => {
    expect(scan("grep -n foo scripts/build.ts").matched).toBe(false);
  });

  test("no path argument at all (reads stdin)", () => {
    expect(scan("cat x.txt | grep foo").matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT5 — unresolvable path arguments produce silence, not a guess
// ---------------------------------------------------------------------------

describe("AT5 — an unresolvable path argument is silence, never a guess", () => {
  test('`grep -r X "$DIR"` does not fire, and records the argument as unresolved', () => {
    const result = scan('grep -r X "$DIR"');
    expect(result.matched).toBe(false);
    expect(result.unresolvedCount).toBe(1);
  });

  test("a relative path under `session_exec` is unresolvable — its cwd is the session workspace", () => {
    const result = scanCommand("grep -rn foo src/tray", {
      cwd: REPO,
      relativeBaseKnown: false,
      fs: fakeFs,
    });
    expect(result.matched).toBe(false);
    expect(result.unresolvedCount).toBe(1);
  });

  test("an ABSOLUTE path is checked even when the relative base is unknown", () => {
    const result = scanCommand("grep -rn foo /repo/src/tray", {
      cwd: null,
      relativeBaseKnown: false,
      fs: fakeFs,
    });
    expect(result.matched).toBe(true);
    expect(result.missing[0]?.raw).toBe("/repo/src/tray");
  });

  test("a `cd` re-bases relative paths, so they go unchecked — absolutes still do not", () => {
    expect(scan("cd packages && grep -rn foo src/tray").matched).toBe(false);
    expect(scan("cd packages && grep -rn foo /repo/src/tray").matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Binary coverage
// ---------------------------------------------------------------------------

describe("the other search binaries", () => {
  test("`rg` uses the same PATTERN [PATH...] grammar", () => {
    expect(scan("rg 'foo' src/tray").matched).toBe(true);
    expect(scan("rg 'foo' src").matched).toBe(false);
  });

  test("`find` takes paths FIRST, before the expression", () => {
    expect(scan("find src/tray -name '*.ts'").matched).toBe(true);
    expect(scan("find src -name '*.ts'").matched).toBe(false);
    expect(scan("find -L src -type f").matched).toBe(false);
  });

  test("`find`'s expression operands are never read as paths", () => {
    // `-newer` takes a filename that is NOT a search target. A getopt-style walk would have to
    // know that `-newer` consumes its operand; stopping at the expression means it never matters.
    expect(scan("find src -newer nonexistent-reference.txt").matched).toBe(false);
    expect(scan("find src -samefile also-nonexistent").matched).toBe(false);
  });

  test("`-e` supplies the pattern, so every positional is then a path", () => {
    // Without this branch, `src` would be swallowed as the pattern and `src/tray` never checked.
    expect(scan("grep -rn -e foo src/tray").matched).toBe(true);
    expect(scan("grep -rne foo src/tray").matched).toBe(true);
  });

  // PR #3149 R1 (BLOCKING, reviewer-caught): the ATTACHED spelling. The original matcher anchored
  // on `$`, so `-ePATTERN` did not register as pattern-supplying and `pathArgs` dropped the real
  // path as if it were the pattern — the command checked ZERO paths and said nothing.
  test("`-e`/`-f` with an ATTACHED value still supplies the pattern", () => {
    expect(pathArgs("grep", tokenize("grep -ePATTERN src/tray"))).toEqual(["src/tray"]);
    expect(pathArgs("grep", tokenize("grep -rnePATTERN src/tray"))).toEqual(["src/tray"]);
    expect(pathArgs("grep", tokenize("grep -fFILE src/tray"))).toEqual(["src/tray"]);
    expect(scan("grep -ePATTERN src/tray").matched).toBe(true);
    expect(scan("grep -rnePATTERN src/tray").matched).toBe(true);
  });

  test("the long forms supply the pattern in both spellings", () => {
    expect(pathArgs("grep", tokenize("grep --regexp=foo src/tray"))).toEqual(["src/tray"]);
    expect(pathArgs("grep", tokenize("grep --file patterns.txt src/tray"))).toEqual(["src/tray"]);
  });

  test("suppliesPattern stops at the first non-flag letter, so a stray word is not read as -f", () => {
    // The false-positive direction: reading this as pattern-supplying would promote the real
    // PATTERN to a path candidate and could manufacture a fire on a correct command.
    expect(suppliesPattern("-notaflag")).toBe(false);
    expect(suppliesPattern("-rniE")).toBe(false);
    expect(suppliesPattern("-e")).toBe(true);
    expect(suppliesPattern("-rne")).toBe(true);
    expect(suppliesPattern("--regexp")).toBe(true);
    expect(suppliesPattern("--exclude-dir")).toBe(false);
  });

  test("a non-search binary is ignored entirely", () => {
    expect(scan("cat src/tray/file.ts").matched).toBe(false);
    expect(scan("ls src/tray").matched).toBe(false);
  });

  test("fires from a later pipeline stage and a later top-level segment", () => {
    expect(scan("echo start; grep -rn foo src/tray").matched).toBe(true);
    expect(scan("echo start | grep -rn foo src/tray").matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parsing units — the load-bearing decisions, tested directly
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("splits on unquoted whitespace and strips one layer of quoting", () => {
    expect(tokenize("grep -rn 'a b' src")).toEqual(["grep", "-rn", "a b", "src"]);
  });

  test("a quoted separator does not manufacture a token boundary", () => {
    expect(tokenize('grep "foo bar baz" src')).toEqual(["grep", "foo bar baz", "src"]);
  });
});

describe("positionalArgs", () => {
  test("a bundled flag run whose last character takes a value consumes the next token", () => {
    expect(positionalArgs(["grep", "-rnA", "3", "pat", "src"])).toEqual(["pat", "src"]);
  });

  test("a bundled run with an ATTACHED value does not consume the next token", () => {
    expect(positionalArgs(["grep", "-A3", "pat", "src"])).toEqual(["pat", "src"]);
  });

  test("`--` terminates flag parsing", () => {
    expect(positionalArgs(["grep", "--", "-pat", "src"])).toEqual(["-pat", "src"]);
  });

  test("redirections are never positionals", () => {
    expect(positionalArgs(["grep", "pat", "src", "2>/dev/null"])).toEqual(["pat", "src"]);
    expect(positionalArgs(["grep", "pat", "src", ">", "out.txt"])).toEqual(["pat", "src"]);
  });
});

describe("pathArgs", () => {
  test("drops the first positional as the pattern for grep", () => {
    expect(pathArgs("grep", ["grep", "-rn", "pat", "src"])).toEqual(["src"]);
  });

  test("keeps every positional when -e supplied the pattern", () => {
    expect(pathArgs("grep", ["grep", "-e", "pat", "src", "packages"])).toEqual(["src", "packages"]);
  });

  test("keeps every leading positional for find", () => {
    expect(pathArgs("find", ["find", "src", "packages", "-name", "x"])).toEqual([
      "src",
      "packages",
    ]);
  });
});

describe("isUnresolvable", () => {
  test.each([
    ["$DIR", true],
    ["${DIR}", true],
    ["$(pwd)/x", true],
    ["`pwd`", true],
    ["src/*.ts", true],
    ["src/**/x", true],
    ["src/[abc]", true],
    ["src/tray", false],
    ["/abs/path", false],
  ])("%s -> %s", (token, expected) => {
    expect(isUnresolvable(token as string)).toBe(expected);
  });
});

describe("editDistance", () => {
  test("counts single-character edits", () => {
    expect(editDistance("tray", "tray")).toBe(0);
    expect(editDistance("tray", "trays")).toBe(1);
    expect(editDistance("tray", "gray")).toBe(1);
  });

  test("short-circuits when the length gap alone exceeds the threshold", () => {
    expect(editDistance("a", "abcdefgh")).toBeGreaterThan(2);
  });
});

describe("suggestions", () => {
  test("names a sibling that contains the failed segment", () => {
    // `cockpit-tray` holds `src` and `src-tauri`; a search for `src-taur` should surface both.
    const result = scan("grep -rn foo cockpit-tray/src-taur");
    expect(result.matched).toBe(true);
    expect(result.missing[0]?.suggestions).toContain("src-tauri");
  });
});

// ---------------------------------------------------------------------------
// Message shape
// ---------------------------------------------------------------------------

describe("buildWarning", () => {
  test("blocks the inference, not just reports the typo", () => {
    const text = buildWarning(scan("grep -rn foo src/tray"));
    expect(text).toContain("[nonexistent-search-path]");
    expect(text).toContain("src/tray");
    expect(text).toContain("NOT evidence of absence");
  });

  test("caps the rendered list so one bad command cannot grow the injection", () => {
    const text = buildWarning(scan("grep -rn foo src/a src/b src/c src/d src/e src/f"));
    expect(text).toContain("…and 3 more");
  });

  test("renderWorstCase is saturated on every axis at once", () => {
    const text = renderWorstCase();
    expect(text).toContain("…and 2 more");
    expect(text).toContain("did you mean");
    // Pins the registry's declared ceiling against the real render. The path strings are the one
    // unbounded axis, which is why `guard-feedback-shape.test.ts` calls this a saturated SAMPLE
    // rather than a proved ceiling — but a regression that doubled the body would fail here.
    // MEASURED 992 chars on 2026-08-17; the registry declares 1050. Asserted against the
    // declared ceiling, not a round number, so the two cannot drift apart silently.
    expect(text.length).toBeLessThan(1050);
  });
});

/**
 * mt#4328 — the grammar now comes from `command-shape.ts`; these pin what that
 * migration changed and what it must NOT change.
 */
describe("shared search-argument grammar (mt#4328)", () => {
  describe("SC7 — a ripgrep short flag no longer costs the whole path list", () => {
    // The private copy bounded its scan by a GREP-only letter set, so a flag the
    // set never knew about returned false from `suppliesPattern`. `pathArgs` then
    // treated the real pattern as the path and returned NOTHING to stat: the
    // command passed through this guard checking zero paths. Measured against the
    // pre-migration code — `suppliesPattern("-Se") === false` and
    // `pathArgs("rg", ["rg","-Se","foo","src"]) === []`.
    //
    // BOTH spellings are asserted deliberately: `-S` and `-u` fail for the same
    // reason but are different letters, so a "fix" that merely added letters to
    // the old set would satisfy one and not the other.
    test("-S (ripgrep --smart-case) in a bundled run still yields the path", () => {
      expect(suppliesPattern("-Se")).toBe(true);
      expect(pathArgs("rg", tokenize("rg -Se foo src"))).toEqual(["src"]);
    });

    test("-u (ripgrep --unrestricted), repeated, still yields the path", () => {
      expect(suppliesPattern("-uue")).toBe(true);
      expect(pathArgs("rg", tokenize("rg -uue foo src"))).toEqual(["src"]);
    });

    test("a non-flag word is still NOT read as supplying the pattern", () => {
      // The bound the letter set used to provide has to still be doing its job in
      // the direction that matters: a false "pattern supplied" promotes the real
      // pattern to a path candidate, which is how this helper could manufacture a
      // fire from a correct command.
      expect(suppliesPattern("-notaflag")).toBe(false);
    });
  });

  describe("AT5 — redirections stay out of the path list", () => {
    // `nonFlagOperands` does not skip redirection tokens; `positionalArgs` wraps
    // it with a pre-filter that does. Without the wrapper this returns
    // ["foo","src/",">","/tmp/out"] and the guard stats the redirect TARGET.
    test("a redirect target is not a positional", () => {
      expect(positionalArgs(tokenize("grep -rn foo src/ > /tmp/out"))).toEqual(["foo", "src/"]);
    });

    test("and not a path argument either", () => {
      expect(pathArgs("grep", tokenize("grep -rn foo src/ > /tmp/out"))).toEqual(["src/"]);
    });

    test("a dangling redirection consumes its target and nothing more", () => {
      expect(positionalArgs(tokenize("grep -rn foo src/ 2> /dev/null other/"))).toEqual([
        "foo",
        "src/",
        "other/",
      ]);
    });
  });

  describe("AT4′ — find keeps its own walker, and must not be migrated", () => {
    // These are REGRESSION guards, not a new capability. `find` path operands are
    // extracted by `findPathOperands`, which stops dead at the first expression
    // token; `nonFlagOperands({findStyle:true})` keeps walking and only skips
    // tokens beginning with `-`. The two agree on every predicate measured, and
    // diverge on expression OPERATORS — so a later attempt to fold this half into
    // the shared walker should fail here rather than silently start stat'ing `(`.
    test("a predicate value is not a path", () => {
      expect(pathArgs("find", tokenize("find src -path docs"))).toEqual(["src"]);
      expect(pathArgs("find", tokenize("find src -name docs"))).toEqual(["src"]);
    });

    test("an expression operator is not a path", () => {
      expect(pathArgs("find", tokenize("find src ( -name a -o -name b )"))).toEqual(["src"]);
    });

    test("multiple real path operands before the expression are all kept", () => {
      expect(pathArgs("find", tokenize("find src tests -name docs"))).toEqual(["src", "tests"]);
    });
  });
});
