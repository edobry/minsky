/**
 * SHA-256 of every scaffold output the retired template system produced
 * (mt#4974 SC7) — the table `scaffoldRulesFromCorpus` consults before it
 * replaces a file in an existing project.
 *
 * ## What this is for
 *
 * A project scaffolded before mt#4974 has the OLD template output in
 * `.minsky/rules/`. Migrating it means replacing exactly that and nothing else:
 * a file matching a hash here is content Minsky wrote and nobody has touched, so
 * it is ours to replace; a file matching nothing here has local edits and is
 * left alone with a report. Without this table `--overwrite` is indistinguishable
 * from "discard the user's rules", which is what it did until mt#4974.
 *
 * ## How these were derived, and what they cover
 *
 * Generated 2026-09-04 by running the real `minsky init` across the full config
 * matrix it exposes — `--rule-format` ∈ {cursor, generic, minsky} × `--mcp` ∈
 * {true, false}, six runs — and hashing the `.mdc` files each produced. Going
 * through `init` rather than calling `RuleTemplateService` directly is
 * deliberate: the generator only renders when the shared command registry is
 * loaded (its `helpers.command()` resolves ids like `tasks.list`), and `init`
 * wraps that in a try/catch, so a direct call reproduces a DIFFERENT — and
 * empty — result than the one real projects received.
 *
 * Six ids, eight distinct hashes. Two ids vary across the matrix and the rest
 * are invariant, which is itself worth recording: `minsky-workflow` varies with
 * `--mcp` (the interface section it renders), and `minsky-workflow-orchestrator`
 * varies with `--rule-format` (cursor differs from generic/minsky).
 *
 * ## Coverage bound — read this before trusting a "diverged" verdict
 *
 * These are the outputs of the template sources at the commit mt#4974 landed on,
 * NOT of every historical revision. The template sources have real history (18
 * commits on the pre-extraction `src/domain/rules/templates` path, 3 after the
 * mt#2108 package extraction, 4 on `rule-template-service.ts`), and an output
 * produced by one of those older revisions would hash to something absent here
 * and be reported as diverged.
 *
 * **That is the safe direction of the error** — a false "diverged" keeps a file
 * the user might have wanted refreshed; a false "known" would silently destroy
 * an edit. It is also, today, an empty set: ADR-048 recorded (checked
 * 2026-09-04) that the one other repository in this operator's working set has
 * no `.minsky/rules` directory at all, so `minsky init` has never been run
 * anywhere but this repository. There is no project in the world holding an
 * older scaffold to migrate.
 *
 * If a project scaffolded by an older Minsky ever does turn up, add its hashes
 * here rather than widening the match — the whole value of this table is that
 * membership means "we wrote this exact content".
 */

/** Rule id → every content hash Minsky is known to have written for it. */
export const HISTORICAL_SCAFFOLD_HASHES: Readonly<Record<string, readonly string[]>> = {
  index: ["52b920fc422e8c0ba24222a26d73c4724d9bfd75fa41d0314bc884a44743671d"],
  "minsky-workflow": [
    // --mcp true
    "110fe1750b6c29903aefb57af611666216e237864847c70c41f0b9f261c25b12",
    // --mcp false
    "ff1c785cb541ec4834aa7dab97ee46240131281b0c1d34f8eace4dbaea4c183f",
  ],
  "minsky-workflow-orchestrator": [
    // --rule-format generic | minsky
    "16f5f5fa4942a5ea02199e631e89df613d3a04a9de803a67f79d0db350f7b462",
    // --rule-format cursor
    "4a2592f2c6b7d0f4b3babe7ab02d629db46f15636990165e775958534271ab7f",
  ],
  "pr-preparation-workflow": ["edc71fe4ee6bcaa5844c89bc8335a3f5b04b9ccc99ac341e4baa3bdb2549b426"],
  "task-implementation-workflow": [
    "3d0160fa2d321c6c3f7071d962a06ebd85562d9053a3cf0a863209fed410b589",
  ],
  "task-status-protocol": ["55ee7638687b7fe167141d08eabd18bdb9e6738af85040fa7505513ab5f04796"],
};

/**
 * The rule ids the retired template system scaffolded.
 *
 * Kept as a named export because these ids do NOT appear in the new corpus —
 * the product rules have different names — so anything reasoning about "what a
 * pre-mt#4974 project looks like" needs the old list, not the new one.
 */
export const RETIRED_SCAFFOLD_RULE_IDS: readonly string[] = Object.keys(
  HISTORICAL_SCAFFOLD_HASHES
).sort();
