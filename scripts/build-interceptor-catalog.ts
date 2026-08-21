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
 * SLICE 1B (mt#4056) adds the three axes and the computed families to every
 * entry, from `.minsky/hooks/interceptor-coordinates.ts` (mt#4038). Same
 * boundary, same pipeline: the coordinates travel through this artifact for
 * exactly the reason the descriptions do.
 *
 * @see mt#4010 — slice 1 (the readable corpus)
 * @see mt#4056 — slice 1b (the axes + family filters)
 * @see mt#4008 — the descriptions + failure-class taxonomy this renders
 * @see mt#4038 — the coordinate data this renders
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
import {
  DELIBERATELY_UNAUTHORED_NAMES,
  classifyFamilies,
  resolveCoordinates,
  type CoordinateGap,
  type CoordinateResolutionInput,
  type DecisionMechanism,
  type Family,
  type InterceptionPoint,
  type Intervention,
  type Role,
} from "../.minsky/hooks/interceptor-coordinates";
import {
  buildCoordinateResolutionInput,
  readSettingsHookNames,
} from "./interceptor-coordinate-input";
import { resolvePrecommitStepNames } from "./precommit-step-names";

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
  /** The three declaring sources axis 1 is derived from (mt#4056). */
  readonly coordinateInput: CoordinateResolutionInput;
}

/**
 * Which family bucket an entry lands in — ONE discriminated value, never two
 * booleans (mt#4056 SC3).
 *
 * `classifyFamilies` returns `outOfModel` and `unclassified` as separate flags,
 * and they mean genuinely different things: `out-of-model` is "coordinates ARE
 * authored and land in none of the three families" (a finding about the
 * ontology — the 8 `OUT_OF_MODEL_NAMES` regen steps and framework-state
 * writers), while `unclassified` is "nobody wrote the coordinates down". Two
 * booleans travel to the UI as two independently-ignorable fields, and a
 * renderer that checks neither shows an empty cell for both — the
 * absence-vs-declaration conflation this catalog exists to prevent. Collapsing
 * them into one three-valued discriminant makes rendering them identically a
 * deliberate act rather than an oversight.
 */
export type FamilyState = "classified" | "out-of-model" | "unclassified";

/** The axis coordinates a catalog entry carries, on top of its description. */
export interface CatalogEntryCoordinates {
  /** Axis 1. Null exactly when `coordinateGaps` contains `"point"`. */
  readonly point: InterceptionPoint | null;
  /** How axis 1 was established, so a reader can tell derived from authored. */
  readonly pointSource: "registry" | "settings" | "stratum" | "authored" | "none";
  /**
   * Authored dimension-1 stratum marker (ontology §5) — `"delivery"` for the
   * merge gates, whose subject nothing in a declared source separates from the
   * other PreToolUse denials; null everywhere the stratum derives. mt#4011's
   * lifecycle spine reads this for merge-station placement.
   */
  readonly trajectory: "delivery" | null;
  /** Axis 2 — the capability SET, never a single primary (ontology amendment (a)). */
  readonly interventions: readonly Intervention[];
  /** Axis 3. */
  readonly mechanism: DecisionMechanism | null;
  readonly role: Role | null;
  /** ALWAYS enumerated, never defaulted — the gap markers. */
  readonly coordinateGaps: readonly CoordinateGap[];
  /** Computed filters over axis 2, never stored kinds. Membership is not exclusive. */
  readonly families: readonly Family[];
  readonly familyState: FamilyState;
  /**
   * True for the 6 names with NO authored coordinates BY DECISION (SC4) — five
   * fire-log test fixtures plus `rationalization-review`, which has no source
   * module. Distinguishes "deliberately unauthored" from "nobody got to it yet",
   * both of which present as `unclassified`.
   */
  readonly deliberatelyUnauthored: boolean;
}

/** The build-time join key between the catalog and any file-keyed view of the corpus. */
export interface CatalogEntrySourceFile {
  /**
   * The hook FILE that implements this entry, as a bare basename — the join key
   * between the catalog (keyed by `guardName`) and any file-keyed view of the
   * same corpus, `/plant/interlock-history`'s git-derived install provenance
   * being the one that matters (mt#4229).
   *
   * Derived, not authored, and the derivation is already exact: the description
   * store's contract makes `provenance[0]` the module that IMPLEMENTS the
   * behavior, so it resolves the cases where the file name and the guard name
   * differ — `bare-prohibition` implements as `warn-bare-prohibition-dispatch.ts`
   * — without a second hand-maintained alias map to drift.
   *
   * `null` means NO HOOK FILE BY CONSTRUCTION, which is a different answer from
   * "we could not find one": a pre-commit step's provenance is
   * `src/hooks/pre-commit.ts`, and a retired or fixture name resolves to the
   * oracle that declares it. Neither has install provenance to join to, so a
   * null here is correct rather than a gap. Measured at introduction: 109 of 134
   * non-null.
   *
   * This field exists because NEITHER consumer may import the hook tree —
   * `tests/unit/hook-tree-import-boundary.test.ts` pins "`src/**` must not
   * import `.minsky/hooks/**`", which covers the cockpit widget and the web page
   * alike. The generator runs in `scripts/`, where the import is legal, so the
   * join is resolved once at build time instead of duplicated on both sides.
   */
  readonly sourceFile: string | null;
}

export type CatalogEntryWithCoordinates = CatalogEntry &
  CatalogEntryCoordinates &
  CatalogEntrySourceFile;

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
  // NO `population` field (mt#4208). The declared population is `entries.length`,
  // and storing a second copy of it is what broke main twice: git unions two
  // branches' entry additions while resolving the single count line without a
  // conflict, so the artifact lands self-inconsistent and the source-keyed regen
  // hook never re-fires on the merge commit that did it. `parseCatalog` derives
  // the number at read time; consumers see it unchanged.
  readonly divergence: CatalogDivergence;
  /** The 11-class taxonomy, so the cockpit renders definitions without a second copy. */
  readonly failureClasses: Readonly<Record<string, FailureClassDefinition>>;
  /** One entry per name, sorted by name. Nothing is filtered. */
  readonly entries: readonly CatalogEntryWithCoordinates[];
}

const DELIBERATELY_UNAUTHORED = new Set(DELIBERATELY_UNAUTHORED_NAMES);

/**
 * Provenance prefixes that denote a hook file.
 *
 * `.minsky/hooks/` is the only one any entry uses today — the description
 * store's `hook()` helper hard-codes it, and a check over the generated catalog
 * finds zero `.claude/hooks/` first-pointers. `.claude/hooks/` is accepted
 * anyway because it is the generated MIRROR of the same file: the two resolve to
 * the same basename, so accepting both costs nothing and removes a silent-null
 * failure mode if a description is ever written against the generated tree
 * (PR #3087 R1).
 */
const HOOK_SOURCE_PREFIXES = [".minsky/hooks/", ".claude/hooks/"] as const;

/**
 * The implementing hook file's basename, or `null` when the entry has none.
 *
 * Two independent conditions, and BOTH must hold:
 *
 * 1. `provenanceStatus === "implementation"`. This is the load-bearing one and
 *    it was missing in the first cut (PR #3087 R1). A `declaration-only` entry's
 *    `provenance[0]` is the ORACLE THAT DECLARES IT — `known-guard-names.ts` —
 *    which is a real path under `.minsky/hooks/`, so a prefix test alone
 *    happily derives `sourceFile: "known-guard-names"` for it. Nine entries
 *    resolved that way, and each would have rendered the oracle's install date
 *    and commit as its own provenance: nine wrong answers, presented as fact,
 *    on the exact surface built to keep absence and declaration apart.
 * 2. `provenance[0]` is under a hook directory. A later pointer is a rule or a
 *    registry, so this reads the FIRST only rather than scanning the list for
 *    something hook-shaped — scanning would invent a join the store never
 *    asserted.
 */
export function deriveSourceFile(
  provenance: readonly string[],
  provenanceStatus: CatalogEntry["provenanceStatus"]
): string | null {
  if (provenanceStatus !== "implementation") return null;
  const first = provenance[0];
  if (first === undefined) return null;
  const prefix = HOOK_SOURCE_PREFIXES.find((p) => first.startsWith(p));
  if (prefix === undefined) return null;
  const basename = first.slice(prefix.length);
  return basename.endsWith(".ts") ? basename.slice(0, -".ts".length) : basename;
}

/**
 * Resolve one name's axis coordinates and computed families.
 *
 * Everything here is DERIVED from `interceptor-coordinates.ts` — this function
 * decides nothing. mt#4038 owns the authored data; the catalog renders it, and
 * amending a coordinate to make rendering easier is out of scope by decision.
 */
function resolveEntryCoordinates(
  guardName: string,
  input: CoordinateResolutionInput
): CatalogEntryCoordinates {
  const resolved = resolveCoordinates(guardName, input);
  const { families, outOfModel, unclassified } = classifyFamilies(resolved);

  return {
    point: resolved.point,
    pointSource: resolved.pointSource,
    trajectory: resolved.trajectory,
    interventions: resolved.interventions,
    mechanism: resolved.mechanism,
    role: resolved.role,
    coordinateGaps: resolved.gaps,
    families,
    familyState: unclassified ? "unclassified" : outOfModel ? "out-of-model" : "classified",
    deliberatelyUnauthored: DELIBERATELY_UNAUTHORED.has(guardName),
  };
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
      ".minsky/hooks/interceptor-coordinates.ts",
      ".minsky/hooks/interceptor-descriptions.ts",
      ".minsky/hooks/known-guard-names.ts",
      ".minsky/hooks/registry.ts",
    ],
    divergence: { declaredButNotDescribed, describedButNotDeclared },
    failureClasses: FAILURE_CLASSES,
    entries: names.map((name) => {
      const described = resolveCatalogEntry(name, sources.input);
      return {
        ...described,
        ...resolveEntryCoordinates(name, sources.coordinateInput),
        sourceFile: deriveSourceFile(described.provenance, described.provenanceStatus),
      };
    }),
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
 *
 * `precommitNames` is passed EXPLICITLY (mt#4071). Omitting it makes
 * `resolveKnownGuardNames` fall back to the hand-maintained
 * `PRECOMMIT_STEP_NAMES` snapshot, and a pre-commit step added without an
 * accompanying snapshot edit is then absent from the population — not reported
 * as a divergence, simply not in the catalog, because the divergence lists
 * compare descriptions against the oracle and the name is in neither. That is
 * how `interceptor-catalog-regen` — a step this very generator's pre-commit
 * hook runs — stayed missing from the catalog it builds.
 */
export function collectOracleNames(): ReadonlySet<string> {
  // mt#4129: `.claude/settings.json` registration is the fact that decides
  // whether something runs at a lifecycle point. Before this, the oracle's only
  // route for a non-registry hook was `STANDALONE_GUARD_NAMES`, defined as
  // "guards that FIRE-LOG but are not in GUARD_REGISTRY" — so a hook whose
  // handler never writes a record was in neither source the divergence check
  // compares, and the check reported zero discrepancies while 30 registered
  // hooks were missing from the catalog entirely.
  //
  // A null here is NOT treated as "none registered": that would silently shrink
  // the population back to the pre-fix set. It throws, because a generator that
  // cannot read the registration file must not emit a catalog claiming to be
  // complete — the same reason `audit-settings-hook-coverage.ts` exits non-zero.
  const settingsNames = readSettingsHookNames();
  if (!settingsNames) {
    throw new Error(
      "Could not derive hook registrations from .claude/settings.json. The catalog " +
        "population would silently omit every settings-registered hook, so this is a " +
        "hard failure rather than a smaller catalog. Check that the file exists and " +
        "that every hook command still points at a `<name>.ts` script."
    );
  }

  return new Set([
    ...resolveKnownGuardNames({
      registryNames: GUARD_REGISTRY.map((r) => r.name),
      precommitNames: resolvePrecommitStepNames(),
    }),
    ...settingsNames,
    ...RETIRED_GUARD_NAMES.keys(),
    ...FIXTURE_GUARD_NAMES.keys(),
  ]);
}

async function main(): Promise<void> {
  const catalog = buildCatalog({
    oracleNames: collectOracleNames(),
    describedNames: new Set(INTERCEPTOR_DESCRIPTIONS.keys()),
    input: buildResolveInput(),
    coordinateInput: buildCoordinateResolutionInput(),
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

  // Coordinate coverage is REPORTED, not asserted (mt#4056 AT1): the figures
  // move as the corpus does, so the generator measures them at build time
  // rather than any consumer citing a number from a prior task's spec.
  const withPoint = catalog.entries.filter((e) => e.point !== null).length;
  const family = (f: Family): number =>
    catalog.entries.filter((e) => e.families.includes(f)).length;
  const state = (s: FamilyState): number =>
    catalog.entries.filter((e) => e.familyState === s).length;

  console.log(
    [
      `Wrote interceptor catalog: ${OUT_PATH_REL}`,
      `  Population: ${catalog.entries.length}`,
      `  Declared but not described: ${declaredButNotDescribed.length}${names(declaredButNotDescribed)}`,
      `  Described but not declared: ${describedButNotDeclared.length}${names(describedButNotDeclared)}`,
      `  Interception point resolved: ${withPoint}/${catalog.entries.length}`,
      `  Families: guard ${family("guard")} · detector ${family("detector")} · injector ${family("injector")}`,
      `  Family state: classified ${state("classified")} · out-of-model ${state("out-of-model")} · unclassified ${state("unclassified")}`,
    ].join("\n")
  );
}

// Guarded so the test can import `buildCatalog` without writing the artifact.
if (import.meta.main) {
  await main();
}
