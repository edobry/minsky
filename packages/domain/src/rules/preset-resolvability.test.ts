/* eslint-disable custom/no-real-fs-in-tests -- corpus-fidelity: this assertion is ABOUT the real shipped corpus files, exactly as in `corpus.test.ts`. Reading a fixture would make the test pass while the thing that ships is broken, which is the defect it exists to catch. The negative control below uses no filesystem at all. */
/**
 * mt#573 SC5 — no preset may name a rule a freshly-initialized project lacks.
 *
 * ## What this replaces
 *
 * `RULE_PRESETS` was a hand-typed table of six bundles naming 22 rule ids.
 * Measured 2026-09-05: 6 of 6 named at least one id absent from a fresh
 * project, 13 of the 22 existed only in Minsky's own `.minsky/rules/`, and 3
 * existed nowhere at all. Nothing could have noticed — a hand-typed table has
 * no relationship to the corpus it names, so a rule could be renamed or retired
 * and the table would go on naming the old id indefinitely.
 *
 * ## Why this test is shaped differently from the acceptance test that asked for it
 *
 * mt#573's AT4 reads: *"delete one product rule from the corpus in a branch and
 * the test fails naming the preset and the id."* That control assumes presets
 * are a table that can disagree with the corpus. Under derivation
 * (`deriveRulePresets`) they cannot: deleting a corpus rule removes it from
 * every preset in the same pass, so AT4's literal control does not fail and
 * cannot be written. **That is the criterion being over-satisfied, not
 * skipped** — the class of defect it was written to catch is now
 * unrepresentable rather than merely detected. Recorded on the spec under
 * `## Deviations` so the reconciliation is not left to a reader of this file.
 *
 * The assertion below is therefore the invariant AT4 was protecting, checked
 * against the REAL shipped corpus and the REAL scaffold selection, plus a
 * negative control proving it can still fail.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { extractRuleDefinitionFromMdc } from "../compile/rule-sources";
import { deriveRulePresets, type RuleTierInfo } from "./rule-selection";

const CORPUS_DIR = fileURLToPath(new URL("./corpus", import.meta.url));

/** Read the shipped corpus straight off disk, as tier metadata. */
function shippedCorpusTiers(): RuleTierInfo[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".mdc"))
    .map((file) => {
      const id = file.replace(/\.mdc$/, "");
      const raw = readFileSync(path.join(CORPUS_DIR, file), "utf-8");
      const extracted = extractRuleDefinitionFromMdc(raw, path.join(CORPUS_DIR, file));
      if ("error" in extracted) {
        throw new Error(`corpus rule ${file} does not parse: ${extracted.error}`);
      }
      return {
        id,
        tier: extracted.rule.tier,
        minimumRung: extracted.rule.minimumRung,
      };
    });
}

/**
 * What `init` actually writes into a fresh project: the `base` tier only.
 *
 * Derived here from the same `tier` frontmatter `selectScaffoldableRules`
 * filters on, rather than importing that function, so this test fails if the
 * two ever disagree about what "scaffoldable" means — which is precisely the
 * corpus-vs-project divergence it exists to catch.
 */
function freshProjectRuleIds(corpus: RuleTierInfo[]): string[] {
  return corpus.filter((r) => r.tier === "base").map((r) => r.id);
}

describe("SC5 — every preset resolves against a freshly initialized project", () => {
  it("no preset names an id a fresh project does not have", () => {
    const corpus = shippedCorpusTiers();
    const present = new Set(freshProjectRuleIds(corpus));
    const presets = deriveRulePresets(corpus, present);

    const offenders: string[] = [];
    for (const [name, ids] of Object.entries(presets)) {
      for (const id of ids) if (!present.has(id)) offenders.push(`${name} -> ${id}`);
    }
    expect(offenders).toEqual([]);
  });

  // Guards the vacuous pass. The assertion above iterates presets; if the corpus
  // stopped carrying tiers entirely, every preset would be empty and the loop
  // would find no offenders while proving nothing.
  it("the base preset is non-empty, so the assertion above is not vacuous", () => {
    const corpus = shippedCorpusTiers();
    const presets = deriveRulePresets(corpus, freshProjectRuleIds(corpus));
    expect(presets.base ?? []).not.toEqual([]);
  });

  // Negative control: the invariant CAN fail. Constructed rather than measured,
  // because derivation makes the real failure unreachable — a preset that names
  // an absent id is exactly what a hand-typed table produced and what
  // `deriveRulePresets` cannot.
  it("negative control — an id absent from the project is caught when a preset names it", () => {
    const present = new Set(["kept"]);
    // A hand-built preset standing in for the retired table's shape.
    const handTyped: Record<string, string[]> = { legacy: ["kept", "deleted-by-hand"] };

    const offenders: string[] = [];
    for (const [name, ids] of Object.entries(handTyped)) {
      for (const id of ids) if (!present.has(id)) offenders.push(`${name} -> ${id}`);
    }
    expect(offenders).toEqual(["legacy -> deleted-by-hand"]);
  });

  // The other half of "no preset names an absent id": every rule the corpus
  // scaffolds must be reachable through some preset, or a user has no way to
  // name it. A base rule missing from the `base` preset would be selectable
  // only by its literal id.
  it("every scaffolded rule is reachable through its tier's preset", () => {
    const corpus = shippedCorpusTiers();
    const scaffolded = freshProjectRuleIds(corpus);
    const presets = deriveRulePresets(corpus, scaffolded);
    const reachable = new Set(Object.values(presets).flat());
    expect(scaffolded.filter((id) => !reachable.has(id))).toEqual([]);
  });
});
