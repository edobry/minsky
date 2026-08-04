// mt#3596: the halt-on-a-principal-decision test must be POSITIVE (name the reserved
// category), not a negative enumeration of known-bad rationales.
//
// R5 of the confabulated-strategic-frame family (mem#367) defeated the negative
// enumeration by construction: the halt rationale simply was not on the list, so
// walking the list honestly returned "not a confabulated halt". A list of bad reasons
// cannot close over reasons nobody has thought of yet; a citation into a CLOSED list
// can.
//
// The guidance lives on TWO always-in-context surfaces — the /plan-task skill and the
// key-workflows rule — each with its own compiled outputs. A fix that lands on one
// leaves the other still stating the old test, and a fix that lands on a source but is
// not recompiled leaves every agent reading the old text. So this asserts the
// requirement on every surface an agent actually reads: sources AND generated
// artifacts, following the tests/domain/plan-task-gate-letters.test.ts precedent.

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   generated artifacts on disk carry the same requirement as their sources, so it must
   read the real files. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import planTaskSkill from "../../.minsky/skills/plan-task/skill.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

// The positive test itself: a halt must NAME the category.
const CITATION_MARKER = "NAME which reserved category";
// The closed list it must cite, by name — an uncited "name the category" is not a test.
const SOURCE_MARKER = "principal-context.mdc §Decisions Eugene reserves";
// The old negative enumeration is KEPT as illustration, but must not read as the test.
const DEMOTION_MARKER = "illustrative, NOT the test";

// Every surface an agent reads the halt conditions from. The two sources are asserted
// separately below; these are the generated artifacts plus the rule source they and
// the skill compile from — a source-only assertion passes on a stale compile.
const SURFACES = [
  ".minsky/rules/key-workflows.mdc",
  ".claude/skills/plan-task/SKILL.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursor/rules/key-workflows.mdc",
];

describe("halt-on-principal-decision requires naming the reserved category (mt#3596)", () => {
  test("the plan-task skill SOURCE states the positive citation test", () => {
    const content = planTaskSkill.content as string;
    expect(content).toContain(CITATION_MARKER);
    expect(content).toContain(SOURCE_MARKER);
    expect(content).toContain(DEMOTION_MARKER);
  });

  for (const surface of SURFACES) {
    test(`${surface} states the positive citation test`, () => {
      const content = readFileSync(join(REPO_ROOT, surface), "utf8") as string;
      expect(content).toContain(CITATION_MARKER);
      expect(content).toContain(SOURCE_MARKER);
      expect(content).toContain(DEMOTION_MARKER);
    });
  }
});
