/**
 * Tests for the closed ADR-012 association vocabulary (mt#4448).
 *
 * The fixtures are not invented: the `## Live corpus replay` block below uses the exact keys
 * and value shapes measured on prod on 2026-08-24, so a regression here reproduces the real
 * divergence rather than a stylized version of it.
 */

import { describe, expect, test } from "bun:test";
import type { AssociationIssue } from "./associations";
import {
  ASSOCIATION_TYPE_NAMES,
  TRACKS_TASK_ASSOCIATION,
  isKnownAssociationType,
  summarizeAssociationIssues,
  validateAssociations,
} from "./associations";

/**
 * Return the first issue, failing the test if there is none.
 *
 * A narrowing helper rather than `issues[0]!`: the non-null assertion would silently turn an
 * empty-array regression into a `TypeError` on the next property access, several lines from
 * the assertion that actually failed.
 */
function first(issues: AssociationIssue[]): AssociationIssue {
  const [head] = issues;
  if (!head) throw new Error(`expected at least one issue, got ${issues.length}`);
  return head;
}

describe("validateAssociations — the closed vocabulary", () => {
  test("every ADR-012 type is accepted with a well-formed id", () => {
    const issues = validateAssociations({
      tracksTask: ["mt#2053"],
      relatedTask: ["mt#1034", "md#77", "gh#12"],
      originatesRule: ["hook-files.mdc"],
      originatesSkill: ["retrospective"],
      informsAsk: ["ask#9323"],
      extractedFromSession: ["962bb743-bbed-46d3-b27c-9ad600257635"],
      extractedFromTranscript: ["962bb743-bbed-46d3-b27c-9ad600257635:turn-5"],
      citedInReview: ["PR#1243"],
    });
    expect(issues).toEqual([]);
  });

  test("an absent or empty map is valid — most memories carry no associations", () => {
    expect(validateAssociations(undefined)).toEqual([]);
    expect(validateAssociations(null)).toEqual([]);
    expect(validateAssociations({})).toEqual([]);
  });

  test("an unknown key is rejected and the message names the nearest valid type", () => {
    const issues = validateAssociations({ tasks: ["mt#4317"] });
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("unknown-key");
    expect(first(issues).key).toBe("tasks");
    expect(first(issues).message).toContain('Did you mean "relatedTask"');
  });

  test("`tasks` suggests relatedTask, NOT tracksTask", () => {
    // Upgrading an entity-keyed mention to tracksTask would assert a retirement
    // relationship the author never expressed — the launder this task exists to prevent.
    const message = first(validateAssociations({ tasks: ["mt#4317"] })).message;
    expect(message).toContain("relatedTask");
    expect(message).not.toContain('mean "tracksTask"');
  });

  test("`docs` is rejected with NO suggestion — memory->doc has no key at all", () => {
    const issues = validateAssociations({ docs: ["docs/architecture/adr-032.md"] });
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("unknown-key");
    expect(first(issues).message).not.toContain("Did you mean");
  });

  test("the rejection states the vocabulary is not force-bypassable", () => {
    const message = first(validateAssociations({ tasks: ["mt#4317"] })).message;
    expect(message).toContain("not bypassable with force");
  });

  test("EVERY issue is returned, not just the first", () => {
    const issues = validateAssociations({
      tasks: ["mt#1"],
      prs: ["3200"],
      docs: ["x.md"],
    });
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.key).sort()).toEqual(["docs", "prs", "tasks"]);
  });
});

describe("validateAssociations — ADR-012 id shapes", () => {
  test("a bare task number is rejected — the prefix is required", () => {
    const issues = validateAssociations({ tracksTask: ["2053"] });
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("malformed-id");
    expect(first(issues).value).toBe("2053");
  });

  test("a bare PR number under the CORRECT key is still rejected", () => {
    // The live corpus has `prs: ["3200"]` — both halves wrong. Fixing only the key would
    // leave an id that can never match a `PR#3200` containment query.
    const issues = validateAssociations({ citedInReview: ["3200"] });
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("malformed-id");
    expect(first(issues).message).toContain("fails silently as an empty result");
  });

  test("a memory uuid prefix is rejected where a full session uuid is required", () => {
    const issues = validateAssociations({ extractedFromSession: ["7b286e2e"] });
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("malformed-id");
  });

  test("values under an UNKNOWN key are not shape-checked", () => {
    // The shape is a property of what the key points at; an unknown key points at nothing.
    // One issue (the key), not two (key + value).
    const issues = validateAssociations({ tasks: ["not-an-id-at-all"] });
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("unknown-key");
  });
});

describe("validateAssociations — create vs update mode", () => {
  test("update: an empty array under an UNKNOWN key is a removal and is allowed", () => {
    // This is what mt#4448's own migration does to strip the divergent keys. Without this
    // carve-out the 26 records could not be cleaned up through the supported write path.
    expect(validateAssociations({ tasks: [] }, "update")).toEqual([]);
    expect(validateAssociations({ docs: [], prs: [] }, "update")).toEqual([]);
  });

  test("update: a NON-empty array under an unknown key is still rejected", () => {
    const issues = validateAssociations({ tasks: ["mt#4317"] }, "update");
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("unknown-key");
  });

  test("create: an empty array under an unknown key is NOT exempt", () => {
    // Removal semantics belong to update. On create there is nothing to remove, so an
    // invented key is an invented key whatever its value.
    const issues = validateAssociations({ tasks: [] }, "create");
    expect(issues).toHaveLength(1);
    expect(first(issues).kind).toBe("unknown-key");
  });

  test("create is the default mode", () => {
    expect(validateAssociations({ tasks: [] })).toEqual(
      validateAssociations({ tasks: [] }, "create")
    );
  });
});

describe("Live corpus replay (2026-08-24 census)", () => {
  // The eight keys actually present on prod, with their real record counts. Two are
  // vocabulary; six are not. A regression that re-opens the vocabulary shows up here.
  const OBSERVED_KEYS = [
    "tasks",
    "memories",
    "prs",
    "tracksTask",
    "changesets",
    "relatedTask",
    "docs",
    "task",
  ] as const;

  test("exactly 2 of the 8 observed keys are vocabulary", () => {
    const known = OBSERVED_KEYS.filter((k) => isKnownAssociationType(k));
    expect(known.sort()).toEqual(["relatedTask", "tracksTask"]);
  });

  test("the full observed key set yields one issue per divergent key", () => {
    const map = Object.fromEntries(OBSERVED_KEYS.map((k) => [k, ["mt#1"]]));
    const issues = validateAssociations(map);
    // 6 unknown keys; the 2 valid ones carry well-formed task ids and add nothing.
    expect(issues.filter((i) => i.kind === "unknown-key")).toHaveLength(6);
  });

  test("the real record `88f953fe` shape is rejected on both its keys", () => {
    const issues = validateAssociations({ prs: ["3200"], tasks: ["mt#4317", "mt#4365"] });
    expect(issues.map((i) => i.key).sort()).toEqual(["prs", "tasks"]);
  });
});

describe("module invariants", () => {
  test("TRACKS_TASK_ASSOCIATION is in the vocabulary", () => {
    expect(isKnownAssociationType(TRACKS_TASK_ASSOCIATION)).toBe(true);
    expect(TRACKS_TASK_ASSOCIATION).toBe("tracksTask");
  });

  test("the vocabulary is exactly ADR-012 §Convention's eight types", () => {
    // Copy before sorting: `.sort()` mutates in place, and ASSOCIATION_TYPE_NAMES is a
    // module-level export — sorting it here would reorder it for every other importer.
    expect([...ASSOCIATION_TYPE_NAMES].sort().join(",")).toBe(
      [
        "citedInReview",
        "extractedFromSession",
        "extractedFromTranscript",
        "informsAsk",
        "originatesRule",
        "originatesSkill",
        "relatedTask",
        "tracksTask",
      ].join(",")
    );
  });

  test("summarize returns null for a clean map and joins every message otherwise", () => {
    expect(summarizeAssociationIssues([])).toBeNull();
    const summary = summarizeAssociationIssues(
      validateAssociations({ tasks: ["mt#1"], docs: ["a"] })
    );
    expect(summary).toContain("tasks");
    expect(summary).toContain("docs");
  });
});
