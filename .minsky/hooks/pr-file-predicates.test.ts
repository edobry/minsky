import { describe, expect, it } from "bun:test";

import { isTestFile } from "./pr-file-predicates";
import {
  checkExecutionEvidence,
  findNewTestFiles,
  type PrFile,
} from "./require-execution-evidence-before-merge";

// ---------------------------------------------------------------------------
// Shared fixtures — hoisted per convention and to satisfy
// custom/no-magic-string-duplication.
//
// These are PR #2711's REAL paths (mt#3810), not invented ones: that PR is the
// incident mt#3868 was found through, so replaying its exact file list is what
// makes the gate assertions below evidence rather than illustration.
// ---------------------------------------------------------------------------

const RENDERER_TSX = "src/cockpit/web/components/ConversationElementRenderers.tsx";
const RENDERER_TEST_TSX = "src/cockpit/web/components/ConversationElementRenderers.image.test.tsx";
const ELEMENTS_TS = "packages/domain/src/transcripts/conversation-elements.ts";
const ELEMENTS_TEST_TS = "packages/domain/src/transcripts/conversation-elements.test.ts";

const PR_TITLE = "feat(mt#3810): Draw the image the operator pasted";
const BODY_NO_EVIDENCE = "## Summary\n\nRenders image content blocks.\n";
const BODY_WITH_EVIDENCE = `${BODY_NO_EVIDENCE}\nExecution evidence:\n\n9 pass, 0 fail\n`;

/** PR #2711's real file list — the mt#3810 shape, whose only test file is a `.tsx`. */
const PR_2711_FILES: PrFile[] = [
  { filename: RENDERER_TSX, status: "modified" },
  { filename: RENDERER_TEST_TSX, status: "added" },
  { filename: ELEMENTS_TS, status: "modified" },
  { filename: ELEMENTS_TEST_TS, status: "modified" },
];

/** The pre-mt#3868 predicate, kept so the widening's effect can be shown as a contrast. */
const OLD_TS_ONLY_PREDICATE = (f: string) => /\.(test|integration\.test|spec)\.ts$/.test(f);

describe("isTestFile — the `.tsx` widening (mt#3868)", () => {
  // This REVERSES a case that shipped in the gate's original commit (`a7b6e2130c`, 2026-04-30),
  // which asserted `isTestFile(".test.tsx") === false`. Blame puts it in the same commit as the
  // neighbouring `.test.js` / plain-`.ts` / `testUtils.ts` cases — a characterization suite
  // describing what the regex did, with no rationale for excluding `.tsx` recorded in the file,
  // the module, or any task.
  //
  // Reading it as a decision would have been wrong, and expensive: the consequence was that all
  // 92 `.test.tsx` files under `src/cockpit/web` were invisible to a BLOCKING gate, so an entire
  // frontend tree could add test files carrying no execution evidence and never trip the check
  // that exists to demand exactly that. `.test.js` stays excluded on grounds that do not
  // transfer — this repo has no JavaScript test files for a gate to act on.
  it("matches .test.tsx and .spec.tsx", () => {
    expect(isTestFile("src/components/Foo.test.tsx")).toBe(true);
    expect(isTestFile("src/cockpit/web/widgets/Bar.spec.tsx")).toBe(true);
    expect(isTestFile(RENDERER_TEST_TSX)).toBe(true);
  });

  it("matches the `.integration.` variants in both extensions", () => {
    expect(isTestFile("tests/integration/session.integration.test.ts")).toBe(true);
    expect(isTestFile("src/cockpit/web/widgets/Bar.integration.test.tsx")).toBe(true);
  });

  it("still does not match a plain .tsx component", () => {
    expect(isTestFile(RENDERER_TSX)).toBe(false);
    expect(isTestFile("src/cockpit/web/widgets/Bar.tsx")).toBe(false);
  });

  it("still does not match .test.js — this repo has no JS tests to gate", () => {
    expect(isTestFile("src/foo.test.js")).toBe(false);
    expect(isTestFile("src/foo.test.jsx")).toBe(false);
  });
});

describe("mt#3868: a cockpit-web PR now reaches the blocking floor", () => {
  it("sees the .tsx test file as newly added", () => {
    expect(findNewTestFiles(PR_2711_FILES)).toEqual([RENDERER_TEST_TSX]);
  });

  // The load-bearing assertion. Before mt#3868 this returned `blocked: false` — the gate could
  // not see the file at all, which is why PR #2711 merged without the gate ever firing. A
  // predicate-only unit test would not have caught that: the defect was only observable where
  // the predicate is USED.
  it("BLOCKS that PR when its body carries no execution evidence", () => {
    const result = checkExecutionEvidence(PR_2711_FILES, PR_TITLE, BODY_NO_EVIDENCE);
    expect(result.blocked).toBe(true);
  });

  it("allows it once the body carries the evidence block", () => {
    const result = checkExecutionEvidence(PR_2711_FILES, PR_TITLE, BODY_WITH_EVIDENCE);
    expect(result.blocked).toBe(false);
  });

  // The contrast that makes the two assertions above mean something: with the OLD predicate
  // injected, the same file list yields no new test files, so the gate had nothing to block on.
  it("finds nothing under the pre-widening predicate — the defect, as a contrast", () => {
    expect(findNewTestFiles(PR_2711_FILES, OLD_TS_ONLY_PREDICATE)).toEqual([]);
  });
});
