/* eslint-disable custom/no-real-fs-in-tests -- corpus-fidelity: these assertions are ABOUT the real shipped .mdc files. Reading a fixture instead would assert nothing about what actually ships, which is the whole point. The scaffold tests below use an injected in-memory fs. */
/**
 * Tests for the shipped product rule corpus (mt#4974).
 *
 * Two halves, deliberately different in technique:
 *
 *   - **Corpus fidelity** reads the REAL `corpus/*.mdc` files. A fixture would
 *     let the shipped corpus rot while the tests stayed green, and "what
 *     actually ships" is the only question worth asking here.
 *   - **Scaffold behavior** injects an in-memory fs, because it is about the
 *     decision logic (write / refresh / leave alone), not about the files.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  isReachableOrDeliberate,
  loadRuleCorpus,
  partitionByTier,
  resolveRuleCorpusDir,
  selectScaffoldableRules,
} from "./corpus";
import {
  describeScaffoldResult,
  hashRuleContent,
  scaffoldRulesFromCorpus,
  type ScaffoldFsDeps,
} from "../init/rule-corpus-scaffold";
import { HISTORICAL_SCAFFOLD_HASHES } from "../init/scaffold-history";

const CORPUS_DIR = fileURLToPath(new URL("./corpus", import.meta.url));

/**
 * The base set, spelled out.
 *
 * Pinned rather than derived: promoting a rule to `base` makes it
 * NON-DECLINABLE for every Minsky user, so it should require a deliberate edit
 * with a failing test — not drift in because someone changed a frontmatter line.
 * The membership was scoped by the principal (mt#4964 §Plan step C1), not
 * derived from mt#4744's audit, whose tier column self-describes as a candidate
 * sketch.
 */
const EXPECTED_BASE = [
  "key-workflows",
  "minsky-session-workflow",
  "operational-safety-dry-run-first",
  "task-status-workflow-protocol",
];

describe("shipped rule corpus — fidelity", () => {
  it("resolves to the package-resident directory in a dev checkout", () => {
    expect(resolveRuleCorpusDir()).toBe(CORPUS_DIR);
  });

  it("every shipped rule carries plane, tier and rung (SC4)", async () => {
    const corpus = await loadRuleCorpus(CORPUS_DIR);
    expect(corpus.length).toBeGreaterThan(0);

    const missing = corpus
      .filter((r) => !r.rule.plane || !r.rule.tier || !r.rule.minimumRung)
      .map((r) => r.id);
    expect(missing).toEqual([]);
  });

  it("every shipped rule is reachable by construction, or says it is on-demand (SC4)", async () => {
    const corpus = await loadRuleCorpus(CORPUS_DIR);

    // This is the criterion the whole task exists for: the retired templates
    // were 7-of-7 unreachable and nothing said so. A rule that reaches neither
    // Claude Code channel is allowed here ONLY if it declares that on purpose.
    const stranded = corpus.filter((r) => !isReachableOrDeliberate(r.rule)).map((r) => r.id);
    expect(stranded).toEqual([]);
  });

  it("the base set is exactly the four the principal scoped (SC5)", async () => {
    const corpus = await loadRuleCorpus(CORPUS_DIR);
    const base = selectScaffoldableRules(corpus)
      .map((r) => r.id)
      .sort();
    expect(base).toEqual(EXPECTED_BASE);
  });

  it("every base rule is emitted always-apply — base cannot be on-demand (SC5)", async () => {
    const corpus = await loadRuleCorpus(CORPUS_DIR);
    for (const rule of selectScaffoldableRules(corpus)) {
      expect(rule.rule.alwaysApply).toBe(true);
      expect(rule.rule.onDemand).toBeUndefined();
    }
  });

  it("AT6 — opinionated rules are PRESENT in the corpus and absent from what init writes", async () => {
    const corpus = await loadRuleCorpus(CORPUS_DIR);
    const byTier = partitionByTier(corpus);

    expect(byTier.opinionated.length).toBeGreaterThan(0);
    expect(byTier.untiered).toEqual([]);

    // The invariant every intermediate state must respect: until Phase 2 wires
    // selection, a declinable rule must not be written into a project that was
    // never asked about it.
    const scaffolded = new Set(selectScaffoldableRules(corpus).map((r) => r.id));
    for (const rule of byTier.opinionated) {
      expect(scaffolded.has(rule.id)).toBe(false);
    }
  });

  it("AT4 — mt#3107's operational-reference rules stay on-demand, not always-apply or glob-scoped", async () => {
    const corpus = await loadRuleCorpus(CORPUS_DIR);
    // The PRODUCT-plane members of the documented on-demand reference tier.
    // mt#3107's §Premise correction explicitly forbids forcing these into an
    // automatic channel; `rules_get` stays their only path.
    const referenceRules = [
      "architectural-bypass-prevention",
      "git-safety",
      "json-parsing",
      "subagent-dispatch-cadence",
    ];

    for (const id of referenceRules) {
      const entry = corpus.find((r) => r.id === id);
      if (!entry) throw new Error(`${id} should ship in the corpus`);
      expect(entry.rule.onDemand).toBe(true);
      expect(entry.rule.alwaysApply).not.toBe(true);
      const globs = entry.rule.globs;
      const hasGlobs = typeof globs === "string" ? globs.length > 0 : (globs ?? []).length > 0;
      expect(hasGlobs).toBe(false);
    }
  });

  it("AT8 — no shipped rule cites a rule file that does not exist (mt#1230's transferred half)", () => {
    // mt#1230 asked for this against the templates. SC6 deletes those, but a
    // product corpus can cite a nonexistent rule exactly as a template could, so
    // the check transfers rather than dying with them. (The original defect was
    // `pr-preparation-workflow` citing `pr-description-guidelines`, which never
    // existed.)
    const corpusFiles = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".mdc"));
    const shipped = new Set(corpusFiles.map((f) => f.replace(/\.mdc$/, "")));

    // A rule may also legitimately cite one of this repository's own rules.
    const repoRulesDir = path.join(CORPUS_DIR, "..", "..", "..", "..", "..", ".minsky", "rules");
    let repoRules = new Set<string>();
    try {
      repoRules = new Set(
        readdirSync(repoRulesDir)
          .filter((f) => f.endsWith(".mdc"))
          .map((f) => f.replace(/\.mdc$/, ""))
      );
    } catch {
      // Running outside the repo checkout — the corpus-internal check below
      // still runs, and is the half that guards what SHIPS.
    }

    const dangling: string[] = [];
    for (const file of corpusFiles) {
      const body = readFileSync(path.join(CORPUS_DIR, file), "utf-8");
      // Backticked `<name>.mdc` is how these rules cite each other.
      for (const match of body.matchAll(/`([a-z0-9][a-z0-9-]*)\.mdc`/g)) {
        const cited = match[1];
        if (cited === undefined) continue;
        if (!shipped.has(cited) && !repoRules.has(cited)) {
          dangling.push(`${file} cites \`${cited}.mdc\`, which does not exist`);
        }
      }
    }

    expect(dangling).toEqual([]);
  });
});

describe("SC8 — the corpus and this repository's own rules must not drift apart", () => {
  /**
   * Why this test exists instead of the twin retirement SC8 describes.
   *
   * SC8 asks that each promoted rule's plant twin in `.minsky/rules/` be retired
   * or reduced to a non-always-apply supplement. That is not reachable in this
   * slice, and the reason is structural rather than effort: de-always-applying a
   * twin drops the rule out of THIS repository's `CLAUDE.md`, and the only way to
   * put it back is to have the compile pipeline read the package corpus as a
   * source. Doing that unconditionally would emit all 17 shipped rules into every
   * managed project regardless of what its user selected — the one invariant
   * mt#4964 §Sequencing says every intermediate state must hold. Gating that read
   * on selection IS Phase 2 (mt#573).
   *
   * So the corpus is a second copy until Phase 2, and a second copy that nothing
   * checks is how the retired templates drifted from reality in the first place.
   * This asserts the two cannot diverge silently: same BODY, byte for byte.
   * Frontmatter deliberately differs — the corpus copies carry plane/tier/rung.
   */
  const REPO_RULES_DIR = path.join(CORPUS_DIR, "..", "..", "..", "..", "..", ".minsky", "rules");

  /** Everything after the closing `---` of the frontmatter block. */
  function body(raw: string): string {
    const lines = raw.split("\n");
    if (lines[0] !== "---") return raw;
    const close = lines.indexOf("---", 1);
    return close === -1 ? raw : lines.slice(close + 1).join("\n");
  }

  it("every promoted rule's body matches its twin in .minsky/rules", () => {
    let repoRules: string[];
    try {
      repoRules = readdirSync(REPO_RULES_DIR);
    } catch {
      // Not running inside the Minsky checkout — nothing to compare against.
      return;
    }
    const repoSet = new Set(repoRules);

    const drifted: string[] = [];
    for (const file of readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".mdc"))) {
      // `minsky-session-workflow` was authored for the corpus and has no twin.
      if (!repoSet.has(file)) continue;
      const shipped = body(readFileSync(path.join(CORPUS_DIR, file), "utf-8"));
      const twin = body(readFileSync(path.join(REPO_RULES_DIR, file), "utf-8"));
      if (shipped !== twin) drifted.push(file);
    }

    expect(drifted).toEqual([]);
  });
});

describe("scaffolding a project from the corpus", () => {
  /** In-memory fs double: `files` is the initial disk contents. */
  function fakeFs(
    files: Record<string, string>
  ): ScaffoldFsDeps & { files: Record<string, string> } {
    const state = { ...files };
    return {
      files: state,
      async exists(p: string) {
        return p in state;
      },
      async readFile(p: string) {
        const found = state[p];
        if (found === undefined) throw new Error(`ENOENT: ${p}`);
        return found;
      },
      async writeFile(p: string, data: string | Buffer) {
        state[p] = String(data);
      },
      async unlink(p: string) {
        delete state[p];
      },
    };
  }

  const RULES_DIR = "/proj/.minsky/rules";

  it("writes the base rules into an empty project and withholds the rest (SC5)", async () => {
    const fs = fakeFs({});
    const result = await scaffoldRulesFromCorpus(RULES_DIR, false, fs, CORPUS_DIR);

    const written = result.outcomes.filter((o) => o.action === "written").map((o) => o.id);
    expect(written.sort()).toEqual(EXPECTED_BASE);
    expect(result.withheld.length).toBeGreaterThan(0);
    expect(result.withheld).not.toContain("key-workflows");

    for (const id of EXPECTED_BASE) {
      expect(fs.files[`${RULES_DIR}/${id}.mdc`]).toBeDefined();
    }
    // The withheld ones must not be on disk at all.
    for (const id of result.withheld) {
      expect(fs.files[`${RULES_DIR}/${id}.mdc`]).toBeUndefined();
    }
  });

  it("never touches an existing file without --overwrite", async () => {
    const target = `${RULES_DIR}/key-workflows.mdc`;
    const fs = fakeFs({ [target]: "MY OWN CONTENT" });

    const result = await scaffoldRulesFromCorpus(RULES_DIR, false, fs, CORPUS_DIR);

    expect(fs.files[target]).toBe("MY OWN CONTENT");
    expect(result.outcomes.find((o) => o.id === "key-workflows")?.action).toBe("kept-existing");
  });

  it("AT3 — --overwrite REFRESHES content Minsky shipped and LEAVES an edited file alone", async () => {
    // A file whose content is a version we shipped: ours to replace.
    const knownContent = "the exact bytes of some prior shipped scaffold";
    const knownHash = hashRuleContent(knownContent);

    const shippedTarget = `${RULES_DIR}/key-workflows.mdc`;
    const editedTarget = `${RULES_DIR}/task-status-workflow-protocol.mdc`;
    const fs = fakeFs({
      [shippedTarget]: knownContent,
      [editedTarget]: "# my notes\n\nI rewrote this rule for my team.",
    });

    // The hash table is INJECTED, so this asserts the decision rather than
    // re-encoding today's real table (which would make it a change-detector) and
    // without mutating a module const (which leaks into the next test).
    const result = await scaffoldRulesFromCorpus(RULES_DIR, true, fs, CORPUS_DIR, {
      "key-workflows": [knownHash],
    });

    // Recognized → replaced with the current shipped version.
    expect(result.outcomes.find((o) => o.id === "key-workflows")?.action).toBe("refreshed");
    expect(fs.files[shippedTarget]).not.toBe(knownContent);
    expect(fs.files[shippedTarget]).toContain("Key Workflows");

    // Unrecognized → left exactly as the user wrote it, and reported.
    expect(fs.files[editedTarget]).toBe("# my notes\n\nI rewrote this rule for my team.");
    expect(result.diverged).toContain("task-status-workflow-protocol");
    const diverged = result.outcomes.find((o) => o.id === "task-status-workflow-protocol");
    expect(diverged?.action).toBe("diverged");
  });

  it("the retired ids are disjoint from the corpus ids — why the sweep is a separate pass", () => {
    // This disjointness is the whole reason `isKnownShippedContent` cannot handle
    // migration on its own: the scaffold loop only ever looks at `<corpusId>.mdc`,
    // and a pre-migration project has none of those paths. Its old files live
    // under retired ids, which is where `sweepRetiredScaffolds` looks.
    const allHashes = Object.values(HISTORICAL_SCAFFOLD_HASHES).flat();
    expect(allHashes.length).toBeGreaterThan(0);
    for (const hash of allHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const retiredIds = Object.keys(HISTORICAL_SCAFFOLD_HASHES);
    expect(retiredIds).toContain("minsky-workflow");
    for (const id of retiredIds) expect(EXPECTED_BASE).not.toContain(id);
  });

  describe("migrating a project the retired template system scaffolded (PR #3629 R1)", () => {
    /** A pre-mt#4974 project: old scaffolds on disk, none of today's rules. */
    function preMigrationProject(overrides: Record<string, string> = {}) {
      const files: Record<string, string> = {};
      for (const id of Object.keys(HISTORICAL_SCAFFOLD_HASHES)) {
        files[`${RULES_DIR}/${id}.mdc`] = `shipped content for ${id}`;
      }
      return { ...files, ...overrides };
    }

    /** Hash table matching `preMigrationProject`'s synthetic content. */
    const SYNTHETIC_HASHES = Object.fromEntries(
      Object.keys(HISTORICAL_SCAFFOLD_HASHES).map((id) => [
        id,
        [hashRuleContent(`shipped content for ${id}`)],
      ])
    );

    it("--overwrite REMOVES the old scaffolds it wrote, and says so", async () => {
      const fs = fakeFs(preMigrationProject());
      const result = await scaffoldRulesFromCorpus(
        RULES_DIR,
        true,
        fs,
        CORPUS_DIR,
        SYNTHETIC_HASHES
      );

      // Before this pass the old files were simply left beside the new ones —
      // inert, but still telling anyone who opened them to run `git approve`.
      expect(result.retired.removed).toEqual(Object.keys(SYNTHETIC_HASHES).sort());
      expect(result.retired.keptEdited).toEqual([]);
      for (const id of Object.keys(SYNTHETIC_HASHES)) {
        expect(fs.files[`${RULES_DIR}/${id}.mdc`]).toBeUndefined();
      }
      // ...and the new base rules are there.
      for (const id of EXPECTED_BASE) {
        expect(fs.files[`${RULES_DIR}/${id}.mdc`]).toBeDefined();
      }
      expect(describeScaffoldResult(result).info.join(" ")).toContain("removed");
    });

    it("--overwrite LEAVES an old scaffold the user edited, and warns", async () => {
      const edited = `${RULES_DIR}/minsky-workflow.mdc`;
      const fs = fakeFs(preMigrationProject({ [edited]: "# my notes on the workflow" }));

      const result = await scaffoldRulesFromCorpus(
        RULES_DIR,
        true,
        fs,
        CORPUS_DIR,
        SYNTHETIC_HASHES
      );

      expect(fs.files[edited]).toBe("# my notes on the workflow");
      expect(result.retired.keptEdited).toEqual(["minsky-workflow"]);
      expect(result.retired.removed).not.toContain("minsky-workflow");
      expect(describeScaffoldResult(result).warnings.join(" ")).toContain("minsky-workflow");
    });

    it("without --overwrite it removes nothing and reports what is still there", async () => {
      const fs = fakeFs(preMigrationProject());
      const result = await scaffoldRulesFromCorpus(
        RULES_DIR,
        false,
        fs,
        CORPUS_DIR,
        SYNTHETIC_HASHES
      );

      expect(result.retired.removed).toEqual([]);
      expect(result.retired.present).toEqual(Object.keys(SYNTHETIC_HASHES).sort());
      for (const id of Object.keys(SYNTHETIC_HASHES)) {
        expect(fs.files[`${RULES_DIR}/${id}.mdc`]).toBeDefined();
      }
      expect(describeScaffoldResult(result).warnings.join(" ")).toContain("--overwrite");
    });

    it("does NOT refresh a corpus-id file whose content matches a DIFFERENT id's history", async () => {
      // The union match this replaced would have overwritten this file. Content
      // equality across ids is not evidence that THIS rule is ours to replace.
      const target = `${RULES_DIR}/key-workflows.mdc`;
      const otherIdsContent = "shipped content for minsky-workflow";
      const fs = fakeFs({ [target]: otherIdsContent });

      const result = await scaffoldRulesFromCorpus(
        RULES_DIR,
        true,
        fs,
        CORPUS_DIR,
        SYNTHETIC_HASHES
      );

      expect(fs.files[target]).toBe(otherIdsContent);
      expect(result.diverged).toContain("key-workflows");
    });
  });
});
