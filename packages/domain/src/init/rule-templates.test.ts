/**
 * mt#4866 SC4 — pin the set of rule ids `minsky init` scaffolds.
 *
 * Before this test, `rule-templates.ts` hardcoded six ids while
 * `DEFAULT_TEMPLATES` registered seven, with no comment and nothing asserting the
 * difference. The measured symptom (mt#4964 §Step A, re-confirmed 2026-09-04 at
 * `d667c9634`) was `init` reporting exactly:
 *
 *     minsky init: 6 scaffolded rule(s) are not reachable by Claude Code — index,
 *     minsky-workflow, minsky-workflow-orchestrator, pr-preparation-workflow,
 *     task-implementation-workflow, task-status-protocol.
 *
 * Six, not seven — and nothing said whether that was a decision or a bug.
 *
 * These are pure array assertions over two module-level constants: no filesystem,
 * no service construction, no clock. The point is not that the numbers are right
 * in the abstract, but that changing either list without changing the other now
 * fails a test instead of drifting silently.
 */

import { describe, it, expect } from "bun:test";
import { INIT_SCAFFOLDED_RULE_IDS } from "./rule-templates";
import { DEFAULT_TEMPLATES } from "../rules/default-templates";

const OMITTED_BY_DESIGN = "minsky-session-management";

describe("init's scaffolded rule set (mt#4866 SC4)", () => {
  it("is exactly these six ids, in this order", () => {
    expect([...INIT_SCAFFOLDED_RULE_IDS]).toEqual([
      "minsky-workflow",
      "index",
      "minsky-workflow-orchestrator",
      "task-implementation-workflow",
      "task-status-protocol",
      "pr-preparation-workflow",
    ]);
  });

  it("contains no duplicates", () => {
    expect(new Set(INIT_SCAFFOLDED_RULE_IDS).size).toBe(INIT_SCAFFOLDED_RULE_IDS.length);
  });

  it("every scaffolded id is a registered template", () => {
    const registered = new Set(DEFAULT_TEMPLATES.map((t) => t.id));
    for (const id of INIT_SCAFFOLDED_RULE_IDS) {
      expect(registered.has(id)).toBe(true);
    }
  });

  // The load-bearing one: it pins WHICH template is left out, so adding a new
  // template to the registry without deciding whether init scaffolds it fails
  // here rather than silently widening the gap.
  it("omits exactly one registered template, and it is the documented one", () => {
    const scaffolded = new Set(INIT_SCAFFOLDED_RULE_IDS);
    const omitted = DEFAULT_TEMPLATES.map((t) => t.id).filter((id) => !scaffolded.has(id));

    expect(omitted).toEqual([OMITTED_BY_DESIGN]);
    expect(DEFAULT_TEMPLATES.length - INIT_SCAFFOLDED_RULE_IDS.length).toBe(1);
  });

  // SC1's validation reads DEFAULT_TEMPLATES, not this list, so the omitted
  // template stays selectable. If that ever diverges, `rules disable
  // --id minsky-session-management` starts rejecting a real rule id.
  it("the omitted template is still a registered id, so it stays selectable", () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.id)).toContain(OMITTED_BY_DESIGN);
  });
});
