// mt#4536 AT1's negative control, as a test.
//
// The acceptance test reads: *"the table's own method is checked by confirming it
// independently rediscovers the four already-known instances; a sweep that misses a
// known instance has a broken method, not a clean result."*
//
// That is a property of the METHOD, and a method degrades silently — so it is
// asserted here rather than reported once by whoever ran the script. It already
// earned its keep during authoring: the first draft read `GUARD_REGISTRY` alone and
// missed `check-task-spec-read`, which is registered directly in settings.json and
// is mt#4380's guard. The control caught it before the table shipped.

import { describe, test, expect } from "bun:test";
import {
  runSweep,
  matcherAlternatives,
  observesCommandStrings,
  readRepoJson,
} from "./sweep-guard-cli-blindness";

describe("guard CLI-blindness sweep (mt#4536)", () => {
  const rows = runSweep();
  const byGuard = (name: string) => rows.filter((r) => r.guard === name);

  test("rediscovers mt#4380 / mt#4341's guard, which lives in the DIRECT population", () => {
    // `check-task-spec-read` is registered in .claude/settings.json, not in
    // GUARD_REGISTRY. A sweep that reads only the registry returns nothing here —
    // which is precisely the broken method AT1 is guarding against.
    const found = byGuard("check-task-spec-read");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.route).toBe("direct");
    expect(found[0]?.verdict).toBe("BLIND");
  });

  test("rediscovers mt#4295's guard, which lives in the DISPATCHER population", () => {
    const found = byGuard("claim-provenance-scan");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.route).toBe("dispatcher");
    expect(found[0]?.verdict).toBe("BLIND");
  });

  test("both populations are actually read — neither is silently empty", () => {
    // Without this, a regression that dropped one population entirely would still
    // pass the two tests above as long as the other population happened to contain
    // the named guard.
    expect(rows.some((r) => r.route === "direct")).toBe(true);
    expect(rows.some((r) => r.route === "dispatcher")).toBe(true);
  });

  test("a guard whose matcher already covers Bash is NOT reported blind", () => {
    // The discriminating half: without it, a method that marked EVERYTHING blind
    // would pass every assertion above while carrying no information.
    const found = byGuard("cli-mcp-substitution");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.verdict).toBe("SEES CLI");
  });

  test("the capability overlay resolves a differently-named CLI route", () => {
    // `tasks_spec_patch` has NO CLI command of its own; `minsky tasks edit
    // --spec-file` reaches the same capability. A name-matched sweep clears this
    // guard, which is exactly how mt#4525's incident went unseen.
    const found = byGuard("claim-provenance-scan");
    expect(found[0]?.note).toContain("tasks edit --spec-file");
  });

  test("a harness-only tool is classified N/A rather than blind", () => {
    const found = byGuard("record-agent-dispatch");
    expect(found[0]?.verdict).toBe("N/A");
  });
});

// PR #3343 R1. Three findings, all about the sweep degrading QUIETLY: a matcher it
// cannot parse, a matcher tested by string equality rather than by the dispatcher's
// own regex, and an input it cannot read. Each would have produced a table that
// looks clean and under-reports blind guards — this task's own failure mode.
describe("the sweep fails loudly rather than under-reporting (PR #3343 R1)", () => {
  test("a non-literal matcher throws instead of splitting into non-tool fragments", () => {
    // `split("|")` on this yields "mcp__minsky__(tasks_create" and "tasks_edit)",
    // neither of which is a tool name. Both would fail to resolve and read as
    // "no CLI route" — a false clean result for that guard.
    expect(() => matcherAlternatives("mcp__minsky__(tasks_create|tasks_edit)")).toThrow(
      /not a literal alternation/
    );
  });

  test("every matcher shipping TODAY is literal, so the check fires on nothing", () => {
    // The assertion above is only worth having if it does not fire on the live
    // population — otherwise the sweep would be throwing on every run. This pins
    // the measurement the docblock cites rather than leaving it as a claim.
    expect(() => runSweep()).not.toThrow();
  });

  test("command-string reach is decided by RegExp, matching the dispatcher", () => {
    // `getGuardsForEvent` does `new RegExp(matcher).test(toolName)`. String equality
    // against split fragments is a PARALLEL notion of matching that can diverge from
    // what actually dispatches.
    expect(observesCommandStrings("Bash|mcp__minsky__session_exec", ["Bash"])).toBe(true);
    expect(observesCommandStrings("mcp__minsky__tasks_create", ["mcp__minsky__tasks_create"])).toBe(
      false
    );
    // An absent matcher means "every tool", which includes the command-string ones.
    expect(observesCommandStrings(undefined, ["*"])).toBe(true);
  });

  test("an unreadable input throws naming the file, rather than returning a partial table", () => {
    expect(() => readRepoJson("src/generated/does-not-exist.json")).toThrow(
      /cannot read src\/generated\/does-not-exist\.json/
    );
  });

  test("a malformed input is distinguished from a missing one", () => {
    // Different remedies: regenerate vs repair. A single opaque failure would
    // conflate them.
    expect(() => readRepoJson("README.md")).toThrow(/is not valid JSON/);
  });
});
