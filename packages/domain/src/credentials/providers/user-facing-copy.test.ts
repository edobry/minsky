/**
 * The class invariant behind mt#5027: no credential provider puts a Minsky task
 * id in front of a user.
 *
 * mt#5022 shipped `"… so no check is claimed (mt#5022 SC3)"` as a `detail`
 * string. The reviewer flagged it NON-BLOCKING on PR #3665; I overrode the flag
 * on the reasoning that this operator is a developer. The principal then hit it
 * in the live cockpit and said it read as weird. Two independent signals on one
 * string is what makes this worth a class check rather than another string edit
 * — the per-instance fix does not stop the next provider doing the same thing.
 *
 * ## Why this parses instead of matching text
 *
 * The question is "does a string a USER reads carry a task id", and a task id in
 * a COMMENT is not only fine but wanted — this directory is full of them, and
 * the fix for mt#5027 deliberately MOVED one into a comment. So the check has to
 * tell a string literal from a comment.
 *
 * The first version of this file did that by stripping comments with a regex and
 * searching the remainder. It stripped block comments and whole-line `//`, and
 * `minsky-reviewer[bot]` caught the hole on PR #3666 (BLOCKING): a TRAILING
 * inline comment — `const x = "…"; // see mt#1234` — survives, because the
 * line's first non-whitespace is `const`. The sweep would then flag a comment,
 * which is a false positive on the most ordinary construct in the repo.
 *
 * Widening the regex is the wrong repair: `//` also appears inside every
 * `https://` URL, and this directory has real `acquireUrl` values. Each patch
 * trades one class of mistake for another because the tool cannot see syntax.
 * So the sweep asks the parser instead. A comment is not a StringLiteral, which
 * makes the distinction exact rather than approximated, and drops the entire
 * question of where a `//` happens to sit.
 *
 * ## Why source rather than returned `detail` values
 *
 * Most providers reach a network to produce a detail (`github` calls
 * `GET /user/repos`, `anthropic` calls `GET /v1/models`), so sweeping every
 * provider's failure path at runtime would mean real HTTP in a unit test.
 * Parsing covers every literal — including the ones behind a network branch —
 * with no I/O beyond reading the files. The residual, recorded on mt#5027's SC5:
 * a task id COMPOSED at runtime from a variable is invisible here. Template
 * literals are covered for their static spans.
 */

/* eslint-disable custom/no-real-fs-in-tests -- this file's entire purpose is
 * sweeping the REAL provider directory. An in-memory fs fake would assert the
 * invariant against a fixture whose author chose its contents, which is exactly
 * the failure this exists to catch: the failure mode is "someone adds a
 * provider, or a string, carrying a task id", and a mocked directory cannot
 * grow a file nobody told it about. Same justification as
 * `.minsky/hooks/hook-module-inventory.test.ts`. */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { listCredentialProviders } from "./index";

const PROVIDERS_DIR = import.meta.dir;

/** A Minsky task id, in the form that appears in this corpus. */
const TASK_ID = /mt#\d+/;

/**
 * Every node kind that carries text a string can be built from. `TemplateHead`
 * / `TemplateMiddle` / `TemplateTail` are the static spans around a `${}`, so a
 * task id hard-coded beside an interpolation is still caught.
 */
const TEXT_KINDS = [
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
] as const;

function stringLiteralsIn(sourceText: string, fileName = "sample.ts"): string[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(fileName, sourceText);
  return TEXT_KINDS.flatMap((kind) =>
    sourceFile.getDescendantsOfKind(kind).map((node) => node.getText())
  );
}

function providerSourceFiles(): string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .sort();
}

describe("no provider puts a task id in front of a user (mt#5027)", () => {
  test("the extractor sees strings and does NOT see comments", () => {
    // The discriminator every assertion below depends on, and the specific
    // regression PR #3666 R1 caught: the trailing inline comment on the last
    // line is the case the old regex stripper missed.
    const literals = stringLiteralsIn(
      [
        "/* mt#1 in a block comment */",
        "// mt#2 in a whole-line comment",
        "const a = `mt#3 in a template`;",
        'const b = "mt#4 in a string";',
        'const c = "https://example.test/x"; // mt#5 trailing after a URL string',
      ].join("\n")
    ).join("\n");

    // Comments are invisible to the parser — all three, including the trailing one.
    expect(literals).not.toContain("mt#1");
    expect(literals).not.toContain("mt#2");
    expect(literals).not.toContain("mt#5");

    // String and template content is visible, which is what makes the sweep able to fail.
    expect(literals).toContain("mt#3");
    expect(literals).toContain("mt#4");
  });

  test("the sweep reaches a real corpus", () => {
    // Liveness before the negative assertions below (mem#1020): a sweep over an
    // empty file list returns "clean" forever, proves nothing, and would survive
    // its own negative control, because "nothing matched" is stable whether or
    // not the code under test is broken.
    //
    // Bound to the REGISTRY rather than to a literal count (PR #3666 R1,
    // non-blocking): a hard `>= 7` goes stale the moment a provider is added or
    // removed. Every registered provider needs a source file here, so this
    // holds at any corpus size and still fails if the directory read breaks.
    const files = providerSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(listCredentialProviders().length);
    expect(files).toContain("claude-code-token.ts");
  });

  for (const file of providerSourceFiles()) {
    test(`${file}: no string literal carries a task id`, () => {
      const project = new Project({ skipAddingFilesFromTsConfig: true });
      const sourceFile = project.addSourceFileAtPath(join(PROVIDERS_DIR, file));

      const literals = TEXT_KINDS.flatMap((kind) =>
        sourceFile.getDescendantsOfKind(kind).map((node) => node.getText())
      );

      // Second liveness guard, per file: a parse that silently produced nothing
      // would make the assertion below vacuous. Every provider has strings.
      expect(literals.length).toBeGreaterThan(0);

      // Report the offending text, so a failure names what to delete rather than
      // sending the reader back to grep.
      const offender = literals.find((text) => TASK_ID.test(text)) ?? null;
      expect(offender).toBeNull();
    });
  }

  test("no registered provider's static copy carries a task id", () => {
    // The parse covers literals; this covers the values actually exposed on the
    // provider objects, which is what the cockpit renders.
    const providers = listCredentialProviders();
    expect(providers.length).toBeGreaterThan(0);

    for (const provider of providers) {
      expect(provider.displayName).not.toMatch(TASK_ID);
      expect(provider.scopeGuidance).not.toMatch(TASK_ID);
    }
  });
});
