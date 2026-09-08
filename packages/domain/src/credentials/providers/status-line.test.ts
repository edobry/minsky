/**
 * The class invariant behind mt#5031: no credential provider writes a value
 * into the cockpit's Detail column that the column cannot show.
 *
 * That column is ~276px wide and rendered with `truncate`, so an over-budget
 * value is cut off silently — there is no error, no warning, and the row still
 * looks populated. Two providers were doing it (`claude-code-token` at 84
 * chars, `telegram` at 95) and neither was noticed until the principal read one
 * of them in the live cockpit.
 *
 * ## Why a class check rather than two string edits
 *
 * The reported instance was `claude-code-token`. `telegram` was worse and
 * nobody had reported it, which is the tell that this is a class: the column
 * accepts any string a provider hands it, so the next provider can reintroduce
 * the defect without touching either of the two that were fixed. Same reasoning
 * as `user-facing-copy.test.ts`, whose sweep this file mirrors.
 *
 * ## What actually PREVENTS the defect, versus what this test adds
 *
 * The structural guarantee is `credentialStatusLine` in
 * `src/cockpit/web/lib/credentials-api.ts`: a provider that supplies no
 * `status`, or a stored detail that is over budget, falls through to a derived
 * state and CANNOT truncate the column. So a new provider is safe by default,
 * and this test is not what stands between the corpus and a regression.
 *
 * What this test adds is the case that default cannot cover: a provider that
 * DOES supply a `status`, and supplies one that is too long. The render site
 * takes a provider's own status at its word — deliberately, because silently
 * dropping a slightly-over status would hide information rather than surface it
 * — so the budget is enforced here instead.
 *
 * ## Why it parses instead of calling the providers
 *
 * Most providers reach a network to produce a result (`github` calls
 * `GET /user`, `supabase` calls the Management API), so exercising every
 * success path would mean real HTTP in a unit test. Parsing reaches every
 * literal, including the ones behind a network branch, with no I/O beyond
 * reading the files.
 *
 * ## Residuals, stated rather than implied
 *
 * - A `status` whose initializer is a PROPERTY ACCESS (`userCheck.status`)
 *   resolves to another provider's already-swept value, so it is skipped here.
 *   `github`'s scope-present branch is the only such case today.
 * - A status COMPOSED at runtime from an unbounded value — a very long account
 *   name in `railway:${me.name}` — can exceed the budget with every static span
 *   inside it. The static spans are what this measures; the widget keeps
 *   `truncate` as a backstop for exactly that case.
 * - "Is this a noun phrase rather than an event or an instruction" is the half
 *   that actually made the copy read wrong, and it is NOT decidable by a
 *   matcher. It is enforced by review, and the two crisp proxies below (budget,
 *   no terminal period) are what a test can honestly assert.
 */

/* eslint-disable custom/no-real-fs-in-tests -- this file's whole purpose is
 * sweeping the REAL provider directory, exactly as user-facing-copy.test.ts
 * does. A fixture directory cannot grow a provider nobody told it about, which
 * is the failure this exists to catch. */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Project, SyntaxKind, type Node, type SourceFile } from "ts-morph";
import { listCredentialProviders } from "./index";
import { MAX_STATUS_LENGTH } from "../types";
import { claudeCodeTokenProvider } from "./claude-code-token";

const PROVIDERS_DIR = import.meta.dir;

function providerSourceFiles(): string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .sort();
}

/**
 * The static text of a string or template literal — template interpolations
 * contribute nothing, since their length is a runtime property.
 */
function staticTextOf(node: Node): string | null {
  if (node.isKind(SyntaxKind.StringLiteral)) return node.getLiteralValue();
  if (node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) return node.getLiteralValue();
  if (node.isKind(SyntaxKind.TemplateExpression)) {
    const head = node.getHead().getLiteralText();
    const spans = node.getTemplateSpans().map((span) => span.getLiteral().getLiteralText());
    return head + spans.join("");
  }
  return null;
}

interface StatusLiteral {
  file: string;
  text: string;
  /** How the initializer was reached, so a failure says where to look. */
  via: string;
}

/**
 * Resolve an identifier to the `const` it names, searching the ENCLOSING
 * FUNCTION before the file.
 *
 * The file scope alone is not enough, and that is not a hypothetical: the
 * dominant shape in this corpus is
 * `function f() { const line = ...; return { detail: line, status: line }; }`,
 * where `line` is function-scoped. A file-scope-only lookup resolves NONE of
 * those — measured, when this test first ran: 5 of 12 status values resolved,
 * and the seven that did not were exactly the `const line` ones. The sweep
 * still reported "clean", because a value it cannot see is a value it cannot
 * fail on. The corpus-size assertion above is what surfaced it.
 */
function resolveConst(from: Node, name: string, sourceFile: Node): Node | undefined {
  const enclosingFunction = from.getFirstAncestor(
    (a) =>
      a.isKind(SyntaxKind.FunctionDeclaration) ||
      a.isKind(SyntaxKind.ArrowFunction) ||
      a.isKind(SyntaxKind.FunctionExpression) ||
      a.isKind(SyntaxKind.MethodDeclaration)
  );
  for (const scope of [enclosingFunction, sourceFile]) {
    if (!scope) continue;
    const declaration = scope
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((d) => d.getName() === name);
    const initializer = declaration?.getInitializer();
    if (initializer) return initializer;
  }
  return undefined;
}

/**
 * Every `status:` value in one provider file whose text is statically known.
 */
function extractStatusLiterals(sourceFile: SourceFile, file: string): StatusLiteral[] {
  const found: StatusLiteral[] = [];

  for (const prop of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() !== "status") continue;
    const initializer = prop.getInitializer();
    if (!initializer) continue;

    const direct = staticTextOf(initializer);
    if (direct !== null) {
      found.push({ file, text: direct, via: "literal" });
      continue;
    }

    if (initializer.isKind(SyntaxKind.Identifier)) {
      const name = initializer.getText();
      const declInit = resolveConst(prop, name, sourceFile);
      const resolved = declInit ? staticTextOf(declInit) : null;
      if (resolved !== null) {
        found.push({ file, text: resolved, via: `const ${name}` });
      }
    }
    // Anything else (a property access) is a documented residual — see the
    // docblock. Deliberately not counted, and deliberately not failed.
  }

  return found;
}

function statusLiteralsIn(file: string): StatusLiteral[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  return extractStatusLiterals(project.addSourceFileAtPath(join(PROVIDERS_DIR, file)), file);
}

describe("provider status lines fit the column they render in (mt#5031)", () => {
  test("the extractor resolves all three shapes it needs to", () => {
    // The discriminator every assertion below depends on, exercised through the
    // SAME function the corpus sweep uses rather than a re-implementation of it.
    //
    // The FUNCTION-SCOPED case is the one that actually broke: a file-scope-only
    // lookup returned nothing for it, and the sweep reported clean over a corpus
    // it could barely see.
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      "sample.ts",
      [
        "const topLevel = `top ${n} level`;",
        "function f() {",
        "  const line = `a ${n} b`;",
        '  return { detail: "long text here", status: line };',
        "}",
        "const two = { status: `direct literal` };",
        "const three = { status: topLevel };",
      ].join("\n")
    );

    const texts = extractStatusLiterals(sourceFile, "sample.ts").map((s) => s.text);

    expect(texts).toContain("direct literal");
    // Function-scoped const — static spans only, interpolation contributes none.
    expect(texts).toContain("a  b");
    // File-scoped const still resolves, via the fallback scope.
    expect(texts).toContain("top  level");
    // And it does NOT pick up a sibling `detail` by mistake.
    expect(texts).not.toContain("long text here");
  });

  test("the sweep reaches a real corpus", () => {
    // Liveness before the assertions below (mem#1020): a sweep over an empty
    // file list, or one that resolves no status values, returns "clean" forever
    // and would survive its own negative control.
    const files = providerSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(listCredentialProviders().length);

    const all = files.flatMap(statusLiteralsIn);
    expect(all.length).toBeGreaterThan(0);
    // Bound to the registry rather than a hard count, so it holds as the corpus
    // grows: most providers report a status, and a regression that stopped
    // resolving them would drop this well below the provider count.
    expect(all.length).toBeGreaterThanOrEqual(listCredentialProviders().length);
  });

  for (const file of providerSourceFiles()) {
    test(`${file}: every status line is within the column budget`, () => {
      const literals = statusLiteralsIn(file);

      // Report the offending text and how it was reached, so a failure names
      // what to shorten instead of sending the reader back to grep.
      const overBudget = literals
        .filter(({ text }) => text.length > MAX_STATUS_LENGTH)
        .map(({ text, via }) => `${via}: ${text.length} chars — ${JSON.stringify(text)}`);
      expect(overBudget).toEqual([]);

      // A terminal period is the one crisp signal that a sentence was pasted
      // in. The broader "is this a noun phrase" question is a review matter.
      const sentences = literals
        .filter(({ text }) => text.endsWith("."))
        .map(({ text, via }) => `${via}: ${JSON.stringify(text)}`);
      expect(sentences).toEqual([]);
    });
  }

  test("claude-code-token reports a status distinct from its detail", () => {
    // The one provider whose success path is pure (a regex shape check, no
    // network), so it can be exercised rather than parsed — which checks the
    // wiring the parse cannot see: that `status` actually reaches the result.
    const token = `sk-ant-oat01-${"x".repeat(95)}`;
    return claudeCodeTokenProvider.validate(token).then((result) => {
      expect(result.ok).toBe(true);
      const status = result.status ?? "";
      expect(status).not.toBe("");
      expect(status.length).toBeLessThanOrEqual(MAX_STATUS_LENGTH);
      // The whole point of the split: the column value is NOT the inline one.
      expect(result.status).not.toBe(result.detail);
      // And the detail is still the full sentence — mt#5027's accepted copy is
      // protected, not replaced (this task's SC3).
      expect(result.detail.length).toBeGreaterThan(MAX_STATUS_LENGTH);
    });
  });
});
