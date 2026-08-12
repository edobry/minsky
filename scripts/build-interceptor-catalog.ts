#!/usr/bin/env bun
/**
 * Build the interceptor catalog — the static JSON the cockpit's `/interceptors`
 * route renders (mt#4010 slice 1).
 *
 * WHY A GENERATED ARTIFACT (mt#4010 §Data-access decision). The authored data
 * lives in `.minsky/hooks/interceptor-descriptions.ts` (mt#4008) and
 * `.minsky/hooks/known-guard-names.ts` (mt#3756). The cockpit's widget layer
 * lives in `src/cockpit/**`, and `src/` does NOT import the hook tree — the
 * root `tsconfig.json`'s `include` does not claim `.minsky/`, and
 * `src/mcp/guard-health-tracker.ts` documents the convention explicitly,
 * duplicating the hooks tree's read logic rather than importing it. A `src/` →
 * `.minsky/hooks/` import would be the first in the repo and would pull the
 * hook tree into `dist/minsky.js` via `src/cli.ts`, silently making
 * `.minsky/hooks/**` a deploy surface it currently is not.
 *
 * `scripts/` has no such constraint — `audit-interceptor-descriptions.ts`,
 * `audit-interceptor-coordinates.ts` and `audit-fire-log.ts` already import
 * these modules — so the generator lives here and the cockpit reads its output.
 *
 * DECLARED population, not fire-log population (mt#4010 SC1). The ontology page
 * instructs corpus enumerations to build from the fire log's distinct-name
 * population, but that is an ~87MB JSONL a cockpit route cannot stream per
 * request, and it has no DB ingest a widget can query until mt#4009 consumes
 * mt#4035. Slice 1 therefore renders what is DECLARED, and fire-log
 * completeness stays owned by `audit-interceptor-descriptions.ts` (its AT2).
 * The two populations are asserted to agree here: divergence in either
 * direction is EMITTED into the artifact rather than silently reconciled, so a
 * name known to one source and not the other is visible in the cockpit instead
 * of disappearing.
 *
 * Trigger: `bun run build:interceptor-catalog`. Wired into `bun run build`, and
 * regenerated + re-staged on every commit by `src/hooks/pre-commit.ts`'s
 * `runInterceptorCatalogRegen` step — mirroring the completion-manifest
 * pipeline (mt#2622), so the committed artifact cannot drift from the authored
 * data it describes.
 *
 * NO TIMESTAMP is emitted. A generated-at field would re-dirty the tracked file
 * on every regeneration, which is exactly what makes the pre-commit diff/stage
 * step meaningful (same reasoning as the completion manifest).
 *
 * @see mt#4010 — this task (slice 1)
 * @see mt#4008 — the descriptions + failure-class taxonomy this renders
 * @see scripts/build-completion-manifest.ts — the generated-artifact pattern this mirrors
 * @see src/cockpit/widgets/interceptors.ts — the consumer
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { format as prettierFormat, resolveConfig } from "prettier";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import {
  FAILURE_CLASSES,
  INTERCEPTOR_DESCRIPTIONS,
  resolveCatalogEntry,
  type CatalogEntry,
  type FailureClassDefinition,
  type RegistryFacts,
  type ResolveCatalogInput,
} from "../.minsky/hooks/interceptor-descriptions";
import {
  FIXTURE_GUARD_NAMES,
  RETIRED_GUARD_NAMES,
  resolveKnownGuardNames,
} from "../.minsky/hooks/known-guard-names";

const GENERATED_BANNER = "by scripts/build-interceptor-catalog.ts — do not edit directly";

const OUT_PATH_REL = "src/generated/interceptor-catalog.json";

/**
 * The two independent declarations of "what the corpus is". Passed IN rather
 * than read from module scope so {@link buildCatalog} is a pure function a test
 * can drive with fixtures.
 */
export interface CatalogSources {
  /** Every name the oracle knows: registry ∪ pre-commit ∪ standalone ∪ retired ∪ fixture. */
  readonly oracleNames: ReadonlySet<string>;
  /** Every name carrying an authored description. */
  readonly describedNames: ReadonlySet<string>;
  /** Registry metadata per name, for the coverage-gap enumeration. */
  readonly input: ResolveCatalogInput;
}

/**
 * Names known to one source and not the other.
 *
 * Emitted into the artifact rather than reconciled: the whole point of two
 * independent declarations is that disagreement is a finding. mt#4008 measured
 * zero divergence in either direction; a non-empty list here means the corpus
 * moved and something needs authoring.
 */
export interface CatalogDivergence {
  /** In the oracle, no authored description — renders with `undescribed: true`. */
  readonly declaredButNotDescribed: readonly string[];
  /** Described, but the oracle does not list it — a description outliving its guard. */
  readonly describedButNotDeclared: readonly string[];
}

export interface InterceptorCatalog {
  readonly _generated: string;
  /** Repo-relative sources this artifact distills, so drift is auditable. */
  readonly generatedFrom: readonly string[];
  /** Entry count — the DECLARED population. */
  readonly population: number;
  readonly divergence: CatalogDivergence;
  /** The 11-class taxonomy, so the cockpit renders definitions without a second copy. */
  readonly failureClasses: Readonly<Record<string, FailureClassDefinition>>;
  /** One entry per name, sorted by name. Nothing is filtered. */
  readonly entries: readonly CatalogEntry[];
}

/**
 * Build the catalog from its two declarations.
 *
 * The population is the UNION, never the intersection: a name in exactly one
 * source is the case worth seeing, and dropping it would reproduce the
 * absence-vs-declaration conflation this catalog exists to prevent.
 */
export function buildCatalog(sources: CatalogSources): InterceptorCatalog {
  const names = [...new Set([...sources.oracleNames, ...sources.describedNames])].sort();

  const declaredButNotDescribed = [...sources.oracleNames]
    .filter((n) => !sources.describedNames.has(n))
    .sort();
  const describedButNotDeclared = [...sources.describedNames]
    .filter((n) => !sources.oracleNames.has(n))
    .sort();

  return {
    _generated: GENERATED_BANNER,
    generatedFrom: [
      ".minsky/hooks/interceptor-descriptions.ts",
      ".minsky/hooks/known-guard-names.ts",
      ".minsky/hooks/registry.ts",
    ],
    population: names.length,
    divergence: { declaredButNotDescribed, describedButNotDeclared },
    failureClasses: FAILURE_CLASSES,
    entries: names.map((name) => resolveCatalogEntry(name, sources.input)),
  };
}

/** Registry metadata keyed by guard name, for the coverage-gap enumeration. */
function buildResolveInput(): ResolveCatalogInput {
  const registryFacts = new Map<string, RegistryFacts>();
  for (const r of GUARD_REGISTRY) {
    registryFacts.set(r.name, {
      tuningOwnership: r.tuningOwnership,
      hasAttentionCost: r.attentionCost !== undefined,
      hasCanary: r.canary !== undefined,
    });
  }
  return { registryFacts };
}

/**
 * Every name the oracle declares.
 *
 * `resolveKnownGuardNames` deliberately EXCLUDES retired and fixture names — it
 * answers "is this a CURRENT enforcement point?". The catalog's question is
 * different: it enumerates the corpus, and a retired step or a test fixture is
 * part of that corpus (each carries its own stratum). So both are unioned back
 * in here rather than the oracle's own resolver being changed.
 */
export function collectOracleNames(): ReadonlySet<string> {
  return new Set([
    ...resolveKnownGuardNames({ registryNames: GUARD_REGISTRY.map((r) => r.name) }),
    ...RETIRED_GUARD_NAMES.keys(),
    ...FIXTURE_GUARD_NAMES.keys(),
  ]);
}

async function main(): Promise<void> {
  const catalog = buildCatalog({
    oracleNames: collectOracleNames(),
    describedNames: new Set(INTERCEPTOR_DESCRIPTIONS.keys()),
    input: buildResolveInput(),
  });

  const outPath = join(import.meta.dir, "..", OUT_PATH_REL);
  mkdirSync(dirname(outPath), { recursive: true });

  // Format with the project's Prettier config so the generator's own output
  // byte-matches the committed copy. Without this, raw `JSON.stringify` output
  // diverges from the Prettier-formatted committed file and every regeneration
  // re-dirties the tracked file (mt#2732, on the completion manifest).
  const prettierConfig = (await resolveConfig(outPath)) ?? {};
  const formatted = await prettierFormat(JSON.stringify(catalog, null, 2), {
    ...prettierConfig,
    parser: "json",
  });
  writeFileSync(outPath, formatted);

  const { declaredButNotDescribed, describedButNotDeclared } = catalog.divergence;
  const names = (list: readonly string[]): string =>
    list.length > 0 ? ` (${list.join(", ")})` : "";
  console.log(
    [
      `Wrote interceptor catalog: ${OUT_PATH_REL}`,
      `  Population: ${catalog.population}`,
      `  Declared but not described: ${declaredButNotDescribed.length}${names(declaredButNotDescribed)}`,
      `  Described but not declared: ${describedButNotDeclared.length}${names(describedButNotDeclared)}`,
    ].join("\n")
  );
}

// Guarded so the test can import `buildCatalog` without writing the artifact.
if (import.meta.main) {
  await main();
}
