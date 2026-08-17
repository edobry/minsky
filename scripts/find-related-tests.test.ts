// mt#4224: the selector's DATA-READ edge.
//
// Before this, `findRelatedTestFiles` could only see a test that IMPORTS its subject,
// and it discarded any changed file that was not `.ts`/`.tsx` before doing even that.
// Two gates in front of the same class, so a manifest test that reads a markdown skill
// or an `.mdc` rule was unreachable — and those are precisely the append-only manifests
// and drift guards where a silent omission is most likely.
//
// Originating incident: a commit editing `.minsky/skills/create-task/SKILL.md` without
// registering the new step in `tests/domain/create-task-claim-steps.test.ts` passed
// pre-commit and failed CI (13,989 pass / 2 fail).
//
// The filesystem here is a hand-built in-memory `FsLike`, not the real one — the module
// routes all fs access through that seam for exactly this reason, and
// eslint-rules/no-real-fs-in-tests.js forbids the alternative.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import {
  extractPathLiterals,
  buildDataReadGraph,
  toRepoRelative,
  findRelatedTestFiles,
  type FsLike,
} from "./find-related-tests";

const REPO = "/repo";

// Named because each appears in several fixtures and assertions; a typo in one copy
// would silently change what the assertion is about.
const SKILL = ".minsky/skills/thing/SKILL.md";
const RULE = ".minsky/rules/r.mdc";
// The real rule this selector must reach — asserted in two places (the normalizer unit
// test and the real-corpus pin), so it is named once here.
const REAL_RULE = ".minsky/rules/key-workflows.mdc";

/**
 * An `FsLike` over a flat path->content map.
 *
 * Directories are DERIVED from the file paths rather than declared, so a fixture only
 * lists real files. `collectAllProjectFiles` walks `ROOTS` and swallows a throw from a
 * missing directory, so a fixture that populates one root is a complete fixture.
 */
function fakeFs(files: Record<string, string>): FsLike {
  const abs = (p: string): string => (p.startsWith(REPO) ? p.slice(REPO.length + 1) : p);
  const isDir = (rel: string): boolean => Object.keys(files).some((f) => f.startsWith(`${rel}/`));

  return {
    existsSync: (p) => {
      const rel = abs(p);
      return rel in files || isDir(rel);
    },
    readFileSync: (p) => {
      const rel = abs(p);
      const content = files[rel];
      if (content === undefined) throw new Error(`ENOENT: ${rel}`);
      return content;
    },
    readdirSync: (p) => {
      const rel = abs(p);
      if (!isDir(rel)) throw new Error(`ENOTDIR: ${rel}`);
      const prefix = rel === "" ? "" : `${rel}/`;
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const remainder = f.slice(prefix.length);
        const head = remainder.split("/")[0];
        if (head !== undefined && head !== "") names.add(head);
      }
      return [...names];
    },
    statSync: (p) => {
      const rel = abs(p);
      const dir = isDir(rel);
      return { isFile: () => !dir && rel in files, isDirectory: () => dir };
    },
  };
}

describe("extractPathLiterals (mt#4224)", () => {
  test("finds repo-relative and test-dir-relative path literals", () => {
    const content = `
      const A = ".minsky/rules/key-workflows.mdc";
      const B = join(import.meta.dir, "../../.minsky/skills/create-task/SKILL.md");
      const C = './docs/thing.md';
    `;
    const found = extractPathLiterals(content);

    expect(found).toContain(".minsky/rules/key-workflows.mdc");
    expect(found).toContain("../../.minsky/skills/create-task/SKILL.md");
    // A leading "./" is normalized away so the literal matches a repo-relative key.
    expect(found).toContain("docs/thing.md");
  });

  test("ignores strings that are not path-shaped", () => {
    // No slash, or no dotted extension — a bare word, an identifier, a sentence.
    const found = extractPathLiterals(`const x = "hello"; const y = "SKILL"; const z = "a.b";`);
    expect(found).toEqual([]);
  });

  test("deduplicates repeated literals", () => {
    const found = extractPathLiterals(`"a/b.md" then "a/b.md" again`);
    expect(found).toEqual(["a/b.md"]);
  });
});

describe("toRepoRelative (PR #3079 R1 BLOCKING)", () => {
  test("rejects a traversal EMBEDDED mid-path, not just a leading one", () => {
    // The exact escape the reviewer found. The first guard tested
    // `candidate.startsWith("..")` on an UN-normalized candidate, so this passed it —
    // and `join(repoRoot, "a/../../b.md")` normalizes to `/b.md`, above the repo.
    expect(toRepoRelative("a/../../b.md")).toBeNull();
    expect(toRepoRelative("../x.md")).toBeNull();
    expect(toRepoRelative("tests/../../escape.md")).toBeNull();
  });

  test("rejects absolute paths and URLs", () => {
    // An absolute literal is not an escape — `join` confines it under repoRoot — but it
    // becomes a bogus in-repo probe, so it is dropped rather than silently reinterpreted.
    expect(toRepoRelative("/etc/passwd.md")).toBeNull();
    expect(toRepoRelative("https://example.com/x.png")).toBeNull();
  });

  test("normalizes a legitimate repo-relative path", () => {
    expect(toRepoRelative("./docs/a.md")).toBe("docs/a.md");
    expect(toRepoRelative("tests/domain/../domain/a.md")).toBe("tests/domain/a.md");
    expect(toRepoRelative(REAL_RULE)).toBe(REAL_RULE);
  });
});

describe("buildDataReadGraph (mt#4224)", () => {
  test("a mid-path traversal creates no edge (PR #3079 R1 BLOCKING)", () => {
    // End-to-end form of the unit test above: the escape must not reach the graph even
    // when the escaped target genuinely exists.
    const fs = fakeFs({
      "tests/domain/evil.test.ts": `readFileSync("tests/../../outside.md")`,
      "outside.md": "# above the repo, reachable only via traversal",
    });

    const graph = buildDataReadGraph(["tests/domain/evil.test.ts"], REPO, fs);

    expect(graph.size).toBe(0);
  });

  test("maps a subject to the test that names it, for BOTH path idioms", () => {
    const fs = fakeFs({
      "tests/domain/manifest.test.ts": `readFileSync(join(import.meta.dir, "../../.minsky/skills/thing/SKILL.md"))`,
      "tests/domain/rule.test.ts": `const RULE = ".minsky/rules/r.mdc"; read(RULE);`,
      [SKILL]: "# skill",
      [RULE]: "# rule",
    });

    const graph = buildDataReadGraph(
      ["tests/domain/manifest.test.ts", "tests/domain/rule.test.ts"],
      REPO,
      fs
    );

    // Test-dir-relative idiom: `join(import.meta.dir, "../../<path>")`.
    expect([...(graph.get(SKILL) ?? [])]).toEqual(["tests/domain/manifest.test.ts"]);
    // Repo-relative idiom: a named constant holding the path.
    expect([...(graph.get(RULE) ?? [])]).toEqual(["tests/domain/rule.test.ts"]);
  });

  test("a literal that resolves to nothing creates no edge — this is the bound", () => {
    const fs = fakeFs({
      "tests/domain/a.test.ts": `"does/not/exist.md" and "https://example.com/x.png" and "src/**/*.ts"`,
      [RULE]: "# rule",
    });

    const graph = buildDataReadGraph(["tests/domain/a.test.ts"], REPO, fs);

    expect(graph.size).toBe(0);
  });
});

describe("findRelatedTestFiles selects on a data-read edge (mt#4224)", () => {
  // The fixture mirrors the originating incident: a markdown skill whose only guard is
  // a manifest test that READS it. `sibling.test.ts` is present as a control — it must
  // NOT be selected, so a passing result cannot come from over-selection.
  const files = {
    "tests/domain/manifest.test.ts": `readFileSync(join(import.meta.dir, "../../.minsky/skills/thing/SKILL.md"))`,
    "tests/domain/sibling.test.ts": `describe("unrelated", () => {});`,
    [SKILL]: "# skill\n\n### 2d. a step\n",
  };

  test("a changed MARKDOWN file selects the test that reads it", () => {
    const related = findRelatedTestFiles([SKILL], REPO, {
      fs: fakeFs(files),
    });

    expect(related).toEqual(["tests/domain/manifest.test.ts"]);
  });

  test("a changed file no test names selects nothing", () => {
    const withOrphan = { ...files, "docs/orphan.md": "# nobody reads me" };

    const related = findRelatedTestFiles(["docs/orphan.md"], REPO, { fs: fakeFs(withOrphan) });

    expect(related).toEqual([]);
  });

  test("a non-existent changed path is still ignored", () => {
    const related = findRelatedTestFiles(["nope/gone.md"], REPO, { fs: fakeFs(files) });

    expect(related).toEqual([]);
  });

  test("a changed test file still selects itself (pre-existing behavior intact)", () => {
    const related = findRelatedTestFiles(["tests/domain/sibling.test.ts"], REPO, {
      fs: fakeFs(files),
    });

    expect(related).toContain("tests/domain/sibling.test.ts");
  });
});

// SC2/SC3 over the REAL repository, not a fixture.
//
// The fixtures above prove the mechanism; they cannot prove it fires for the two pairs
// this task exists for, because a fixture asserts against paths the fixture itself
// invented. SC2 asks for "a test over the selector, not manual observation" — a CLI run
// I read once is exactly the manual observation it rules out, and it would not fail if
// someone rewrote a path idiom later.
//
// This is also the pair that caught the second idiom: with only repo-relative literals
// resolved, `create-task/SKILL.md` selected the halt-citation test and NOT the manifest
// test, and a fixture-only suite stayed green through that.

describe("real-corpus selection (mt#4224 SC2/SC3)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");

  test("editing the create-task skill selects its append-only manifest test", () => {
    const related = findRelatedTestFiles([".minsky/skills/create-task/SKILL.md"], REPO_ROOT);

    expect(related).toContain("tests/domain/create-task-claim-steps.test.ts");
  });

  test("editing key-workflows.mdc selects the halt-citation drift test", () => {
    const related = findRelatedTestFiles([REAL_RULE], REPO_ROOT);

    expect(related).toContain("tests/domain/plan-task-halt-citation.test.ts");
  });
});
