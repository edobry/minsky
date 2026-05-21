#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Canonical Railway auth + GraphQL primitives. mt#2013 completed the mt#1730
// consolidation: scripts/ no longer maintains its own duplicates of
// readRailwayToken / RAILWAY_GRAPHQL_URL / graphql(). All Railway HTTP traffic
// from scripts now flows through src/domain/deployment/railway/graphql-client.ts
// and inherits refresh-aware auth via railwayGraphQLAuthed.
import {
  RAILWAY_GRAPHQL_URL as CANONICAL_RAILWAY_GRAPHQL_URL,
  railwayGraphQLAuthed,
  type RailwayConfigStore,
} from "../../src/domain/deployment/railway/graphql-client";

// Re-export the canonical readRailwayToken for back-compat with any consumer
// that imports it from this module. New callers should prefer
// getValidRailwayToken from the canonical module for refresh-aware reads.
export { readRailwayToken } from "../../src/domain/deployment/railway/graphql-client";

/** Abstraction over reading the secrets file — injectable for tests. */
export type SecretsFileReader = {
  exists: (path: string) => boolean;
  read: (path: string) => string;
};

export const SECRET_REF_BRAND = Symbol("SecretRef");

export type SecretRef = {
  readonly brand: typeof SECRET_REF_BRAND;
  readonly envVarName: string;
};

export function secret(envVarName: string): SecretRef {
  return { brand: SECRET_REF_BRAND, envVarName };
}

export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === "object" && v !== null && (v as SecretRef).brand === SECRET_REF_BRAND;
}

export type VariableValue = string | SecretRef;

export type RailwayConfig = {
  projectId: string;
  environmentId: string;
  serviceId: string;
  variables: Record<string, VariableValue>;
};

export function defineRailwayConfig(config: RailwayConfig): RailwayConfig {
  return config;
}

export type VariablePatch = {
  value: string;
  isSealed: boolean;
};

export type DiffEntry =
  | { kind: "ADD"; key: string; patch: VariablePatch }
  | { kind: "REMOVE"; key: string }
  | { kind: "CHANGE-VALUE"; key: string; patch: VariablePatch }
  | { kind: "CHANGE-SEALED-FLAG"; key: string; patch: VariablePatch }
  | { kind: "NO-CHANGE"; key: string };

export type CurrentVar = {
  value: string;
  isSealed?: boolean;
};

export function defaultSecretsFilePath(): string {
  const override = process.env["MINSKY_RAILWAY_SECRETS_FILE"];
  if (override) return override;
  return join(homedir(), ".config", "minsky", "railway-secrets.json");
}

/** Default production reader — uses real fs. */
export const defaultSecretsFileReader: SecretsFileReader = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf-8"),
};

export function resolveSecret(
  envVarName: string,
  reader: SecretsFileReader = defaultSecretsFileReader
): string {
  const fromEnv = process.env[envVarName];
  if (fromEnv !== undefined) return fromEnv;

  const secretsFilePath = defaultSecretsFilePath();
  if (reader.exists(secretsFilePath)) {
    const raw = reader.read(secretsFilePath);
    const parsed = JSON.parse(raw) as Record<string, string>;
    const fromFile = parsed[envVarName];
    if (fromFile !== undefined) return fromFile;
  }

  throw new Error(
    `Secret resolution failed: '${envVarName}' is not set in process.env and not found in ${secretsFilePath}`
  );
}

export function resolveVariableValue(
  v: VariableValue,
  reader: SecretsFileReader = defaultSecretsFileReader
): {
  resolvedValue: string;
  isSealed: boolean;
} {
  if (isSecretRef(v)) {
    return { resolvedValue: resolveSecret(v.envVarName, reader), isSealed: true };
  }
  return { resolvedValue: v, isSealed: false };
}

export function computeDiff(
  desired: Record<string, VariableValue>,
  current: Record<string, CurrentVar>,
  reader: SecretsFileReader = defaultSecretsFileReader
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const desiredKeys = new Set(Object.keys(desired));
  const currentKeys = new Set(Object.keys(current));

  for (const key of desiredKeys) {
    const desiredVal = desired[key];
    if (desiredVal === undefined) continue;

    // Short-circuit: if current is sealed and desired is a SecretRef, no change possible
    // without resolving the secret locally (which may not be available on all machines).
    if (currentKeys.has(key)) {
      const cur = current[key];
      if (cur !== undefined && cur.isSealed === true && isSecretRef(desiredVal)) {
        entries.push({ kind: "NO-CHANGE", key });
        continue;
      }
    }

    const { resolvedValue, isSealed } = resolveVariableValue(desiredVal, reader);
    const patch: VariablePatch = { value: resolvedValue, isSealed };

    if (!currentKeys.has(key)) {
      entries.push({ kind: "ADD", key, patch });
      continue;
    }

    const cur = current[key];
    if (cur === undefined) continue;
    const currentSealed = cur.isSealed === true;

    if (currentSealed && isSealed) {
      entries.push({ kind: "NO-CHANGE", key });
      continue;
    }

    const valueChanged = cur.value !== resolvedValue;
    const sealedKnown = cur.isSealed !== undefined;
    const sealedChanged = sealedKnown && cur.isSealed !== isSealed;

    if (valueChanged) {
      entries.push({ kind: "CHANGE-VALUE", key, patch });
    } else if (sealedChanged) {
      entries.push({ kind: "CHANGE-SEALED-FLAG", key, patch });
    } else {
      entries.push({ kind: "NO-CHANGE", key });
    }
  }

  for (const key of currentKeys) {
    if (!desiredKeys.has(key)) {
      entries.push({ kind: "REMOVE", key });
    }
  }

  return entries;
}

export function buildVariablePatches(diff: DiffEntry[]): Record<string, VariablePatch> {
  const patch: Record<string, VariablePatch> = {};
  for (const entry of diff) {
    if (
      entry.kind === "ADD" ||
      entry.kind === "CHANGE-VALUE" ||
      entry.kind === "CHANGE-SEALED-FLAG"
    ) {
      patch[entry.key] = entry.patch;
    }
  }
  return patch;
}

export function buildJsonPatch(
  serviceId: string,
  variablePatches: Record<string, VariablePatch>
): object {
  const variables: Record<string, { value: string; isSealed: boolean }> = {};
  for (const [key, patch] of Object.entries(variablePatches)) {
    variables[key] = { value: patch.value, isSealed: patch.isSealed };
  }
  return {
    services: {
      [serviceId]: {
        variables,
      },
    },
  };
}

/**
 * Builds the deletion patch for a set of variable keys.
 * Railway's deletion semantic: set a variable to null to delete it.
 * Produces the same outer envelope as buildJsonPatch for consistency.
 */
export function buildDeletePatch(serviceId: string, keys: string[]): object {
  const variables: Record<string, null> = {};
  for (const key of keys) {
    variables[key] = null;
  }
  return {
    services: {
      [serviceId]: {
        variables,
      },
    },
  };
}

export type DiffSummary = {
  toAdd: DiffEntry[];
  toRemove: DiffEntry[];
  toChangeValue: DiffEntry[];
  toChangeSealedFlag: DiffEntry[];
  noChange: DiffEntry[];
};

export function summarizeDiff(diff: DiffEntry[]): DiffSummary {
  return {
    toAdd: diff.filter((e) => e.kind === "ADD"),
    toRemove: diff.filter((e) => e.kind === "REMOVE"),
    toChangeValue: diff.filter((e) => e.kind === "CHANGE-VALUE"),
    toChangeSealedFlag: diff.filter((e) => e.kind === "CHANGE-SEALED-FLAG"),
    noChange: diff.filter((e) => e.kind === "NO-CHANGE"),
  };
}

/**
 * Validates an HTTP response and throws an informative error for non-2xx responses.
 * Exported for unit testing; consumed by graphql() in apply.ts.
 */
export function assertHttpOk(status: number, statusText: string, bodyText: string): void {
  if (status >= 200 && status < 300) return;
  throw new Error(
    `Railway API request failed: HTTP ${status} ${statusText}. ` +
      // eslint-disable-next-line custom/no-unsafe-string-truncation -- Railway API HTTP error body is ASCII JSON/HTML
      `Body: ${bodyText.slice(0, 500)}. ` +
      `Check your Railway token and network connectivity.`
  );
}

/**
 * Collects re-seal patches for all NO-CHANGE SecretRef variables.
 * Only call this when the --reseal-secrets flag is set; never by default,
 * to avoid silently overwriting prod secrets with local values.
 */
export function buildAllSecretPatches(
  config: { variables: Record<string, VariableValue> },
  diff: DiffEntry[],
  reader: SecretsFileReader = defaultSecretsFileReader
): Record<string, VariablePatch> {
  const patches: Record<string, VariablePatch> = {};
  for (const entry of diff) {
    if (entry.kind === "NO-CHANGE") {
      const val = config.variables[entry.key];
      if (val !== undefined && isSecretRef(val)) {
        const { resolvedValue } = resolveVariableValue(val, reader);
        patches[entry.key] = { value: resolvedValue, isSealed: true };
      }
    }
  }
  return patches;
}

// ---------------------------------------------------------------------------
// Railway GraphQL primitives — re-export the canonical implementations.
// ---------------------------------------------------------------------------
//
// Pre-mt#2013, this file maintained its own copies of readRailwayToken,
// RAILWAY_GRAPHQL_URL, and graphql<T>() — a duplication that mt#1964 chunk 1
// hoisted from apply.ts but did NOT actually unify with the canonical
// src/domain/deployment/railway/graphql-client.ts (mt#1730's intended home).
// mt#2013 finished the consolidation: this module now re-exports the
// canonical names, and graphql<T>() is a thin refresh-aware wrapper around
// railwayGraphQLAuthed so scripts inherit OAuth token-refresh transparently.

export const RAILWAY_GRAPHQL_URL = CANONICAL_RAILWAY_GRAPHQL_URL;

/**
 * Issue a Railway GraphQL request with refresh-aware auth. Preserves the
 * pre-mt#2013 signature (`(query, variables, fetchImpl?)`) so apply.ts and
 * any script-side caller continue to work unchanged, while transparently
 * gaining the OAuth token-refresh behavior from
 * {@link railwayGraphQLAuthed}.
 *
 * The `fetchImpl` parameter is preserved for tests that inject a mocked
 * fetch; production callers can omit it.
 *
 * The optional 4th-arg `opts` lets tests fully isolate from the real
 * `~/.railway/config.json` by injecting a custom `store` (and a
 * clock/`clientId` override). Without it, refresh reads/writes the real
 * file — the pre-mt#2013 behavior at the read-only level, plus the new
 * refresh-write behavior. PR #1228 R1 BLOCKING.
 */
export async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  opts?: { store?: RailwayConfigStore; nowSeconds?: () => number; clientId?: string }
): Promise<T> {
  return railwayGraphQLAuthed<T>(query, variables, {
    fetchImpl,
    store: opts?.store,
    nowSeconds: opts?.nowSeconds,
    clientId: opts?.clientId,
  });
}

// ---------------------------------------------------------------------------
// Deploy-trigger types (mt#1964 chunk 1)
// ---------------------------------------------------------------------------
//
// Minsky-side ergonomic shape: `source.*` / `build.*` nested. Railway's
// `ServiceInstanceUpdateInput` is flat (per the comment in
// scripts/deploy-minsky-mcp.ts:581 originally). The synthesizer flattens at
// the apply boundary (see ServiceInstanceUpdateInput below).

export type RailwayBuilder = "NIXPACKS" | "DOCKERFILE" | "RAILPACK";

export interface RailwaySource {
  repo?: string;
  branch?: string;
  rootDirectory?: string;
  /** Optional check-suite branch filter — per Railway's source.checkSuites. */
  checkSuites?: string[];
}

export interface RailwayBuild {
  builder: RailwayBuilder;
  /** Required when builder === "DOCKERFILE". */
  dockerfilePath?: string;
  buildCommand?: string;
  watchPatterns?: string[];
  nixpacksConfigPath?: string;
}

/**
 * Flat input shape matching Railway's GraphQL `ServiceInstanceUpdateInput`.
 * Callers pass only the fields they want to change; unset fields are not
 * touched by the mutation.
 *
 * The Minsky-side nested shape (`RailwaySource` + `RailwayBuild`) is
 * flattened into this at the apply boundary.
 */
export interface ServiceInstanceUpdateInput {
  // Source fields
  repo?: string;
  branch?: string;
  rootDirectory?: string;
  /** Source check-suite branches filter. */
  checkSuites?: string[];
  // Build fields
  builder?: RailwayBuilder;
  dockerfilePath?: string;
  buildCommand?: string;
  watchPatterns?: string[];
  nixpacksConfigPath?: string;
}

/**
 * Issue the `serviceInstanceUpdate` GraphQL mutation against Railway.
 *
 * Hoisted from scripts/deploy-minsky-mcp.ts:patchServiceRootDirectory
 * (mt#1964 R3). Both `scripts/railway/apply.ts` (new in mt#2000) and
 * `scripts/deploy-minsky-mcp.ts` (existing caller, refactored in this PR
 * to delegate) consume this single source of truth.
 *
 * @param serviceId - Railway service ID (UUID).
 * @param environmentId - Railway environment ID (UUID).
 * @param input - Flat ServiceInstanceUpdateInput shape; unset fields are
 *   not touched by the mutation.
 * @param graphqlImpl - Injectable for testing; defaults to the live
 *   Railway GraphQL transport.
 */
export async function applyServiceInstanceUpdate(
  serviceId: string,
  environmentId: string,
  input: ServiceInstanceUpdateInput,
  graphqlImpl: typeof graphql = graphql
): Promise<void> {
  type R = { serviceInstanceUpdate: boolean };
  await graphqlImpl<R>(
    `
      mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
    `,
    {
      serviceId,
      environmentId,
      input,
    }
  );
}

// ---------------------------------------------------------------------------
// Deploy-trigger reconciliation (mt#2000 chunk 2)
// ---------------------------------------------------------------------------
//
// The synthesizer reconciles the declared `source` + `build` blocks (from
// services/<svc>/deploy.config.ts) against the live Railway service state.
//
// Railway schema note (per scripts/deploy-minsky-mcp.ts:readServiceSource
// 2026-04-23 introspection): `rootDirectory` is a top-level field on
// ServiceInstance; `source` only carries `image` and `repo`; `branch` lives
// on deployment triggers, NOT on the service instance itself. So
// `source.branch` is not in the read shape — it's still writable via
// `ServiceInstanceUpdateInput.branch`, but we cannot diff it without a
// separate deployment-trigger read. Treated as write-through (declared
// values applied unconditionally; live read does not surface them).

export interface ServiceInstanceState {
  /** Top-level on Railway's ServiceInstance. */
  rootDirectory?: string;
  /** Top-level on Railway's ServiceInstance, nested under `source`. */
  source?: { repo?: string };
  /** Build configuration — top-level on ServiceInstance per Railway schema. */
  builder?: RailwayBuilder;
  buildCommand?: string;
  dockerfilePath?: string;
  watchPatterns?: string[];
  // Note: nixpacksConfigPath is NOT exposed on Railway's ServiceInstance
  // read type (only on the write-side ServiceInstanceUpdateInput). It's
  // treated as write-through like source.branch — synthesizer writes it
  // when declared but cannot diff it. Empirically verified 2026-05-21
  // (mt#2001 chunk 3 live-state read) via GraphQL field-validation
  // error: "Cannot query field 'nixpacksConfigPath' on type
  // 'ServiceInstance'."
}

/**
 * Read the live source + build state of a Railway service via GraphQL.
 *
 * Returns null when the service is not found in the environment (e.g.,
 * stale config IDs). On any other GraphQL or transport error, throws.
 *
 * @param environmentId - Railway environment UUID (parent of serviceInstance).
 * @param serviceId - Railway service UUID (lookup key into the environment's
 *   serviceInstances).
 * @param graphqlImpl - Injectable for testing.
 */
export async function fetchServiceInstanceState(
  environmentId: string,
  serviceId: string,
  graphqlImpl: typeof graphql = graphql
): Promise<ServiceInstanceState | null> {
  type R = {
    environment: {
      serviceInstances: {
        edges: Array<{
          node: {
            serviceId: string;
            rootDirectory?: string;
            source?: { repo?: string };
            builder?: RailwayBuilder;
            buildCommand?: string;
            dockerfilePath?: string;
            watchPatterns?: string[];
          };
        }>;
      };
    } | null;
  };
  const data = await graphqlImpl<R>(
    `
      query ($envId: String!) {
        environment(id: $envId) {
          serviceInstances {
            edges {
              node {
                serviceId
                rootDirectory
                source {
                  repo
                }
                builder
                buildCommand
                dockerfilePath
                watchPatterns
              }
            }
          }
        }
      }
    `,
    { envId: environmentId }
  );
  // PR #1214 R1 BLOCKING #4: Railway can return `environment: null` (without
  // a top-level GraphQL error) for invalid env IDs or access-denied. Guard
  // before nested-property access to honor the function's null-on-not-found
  // contract instead of throwing TypeError.
  if (!data.environment) return null;
  const instance = data.environment.serviceInstances.edges.find(
    (e) => e.node.serviceId === serviceId
  );
  if (!instance) return null;
  const node = instance.node;
  // Strip the lookup-only serviceId field; return only the reconcilable state.
  return {
    rootDirectory: node.rootDirectory,
    source: node.source,
    builder: node.builder,
    buildCommand: node.buildCommand,
    dockerfilePath: node.dockerfilePath,
    watchPatterns: node.watchPatterns,
  };
}

/** A single field-level diff entry in the deploy-trigger reconciliation. */
export type ServiceInstanceDiffEntry =
  | { kind: "ADD"; field: string; value: unknown }
  | { kind: "CHANGE"; field: string; from: unknown; to: unknown }
  | { kind: "NO-CHANGE"; field: string };

/**
 * Compute the diff between the desired (declared in deploy.config.ts) and
 * current (live Railway state) deploy-trigger configuration.
 *
 * Walks each field independently:
 *   - ADD: desired has a value, current is unset/null/undefined.
 *   - CHANGE: both set and values differ.
 *   - NO-CHANGE: values match (string equality for scalars; order-sensitive
 *     equality for arrays).
 *
 * **No REMOVE class — by design (PR #1214 R1 BLOCKING #1 clarification).**
 * Fields NOT declared in `desired` are skipped — the synthesizer doesn't
 * prune deploy-trigger fields, because the declared config is a partial
 * spec (you might declare only `source.rootDirectory` and let Railway's
 * defaults govern the rest). Railway's deploy-trigger fields are not
 * "deletable" in the env-var sense — they have platform defaults; emitting
 * a REMOVE entry would imply a delete-and-revert-to-default operation that
 * Railway's GraphQL API does not expose cleanly. The spec was clarified
 * post-review to reflect this partial-spec semantic.
 *
 * `source.branch` is in the desired shape but NOT in the readable state
 * (see ServiceInstanceState comment). It's treated as ADD when desired
 * has a value — applied as write-through; the diff cannot verify it.
 */
export function computeServiceInstanceDiff(
  desired: { source?: RailwaySource; build?: RailwayBuild },
  current: ServiceInstanceState
): ServiceInstanceDiffEntry[] {
  const entries: ServiceInstanceDiffEntry[] = [];

  const diffField = (fieldName: string, desiredVal: unknown, currentVal: unknown): void => {
    if (desiredVal === undefined) return;
    if (currentVal === undefined || currentVal === null) {
      entries.push({ kind: "ADD", field: fieldName, value: desiredVal });
      return;
    }
    if (arrayOrScalarEqual(desiredVal, currentVal)) {
      entries.push({ kind: "NO-CHANGE", field: fieldName });
      return;
    }
    entries.push({ kind: "CHANGE", field: fieldName, from: currentVal, to: desiredVal });
  };

  // Source fields
  diffField("source.repo", desired.source?.repo, current.source?.repo);
  // source.branch is write-through (not in readable state).
  if (desired.source?.branch !== undefined) {
    entries.push({ kind: "ADD", field: "source.branch", value: desired.source.branch });
  }
  diffField("source.rootDirectory", desired.source?.rootDirectory, current.rootDirectory);
  // source.checkSuites is write-through; Railway's schema for reading is
  // sparse here; treat as ADD when declared.
  if (desired.source?.checkSuites !== undefined) {
    entries.push({
      kind: "ADD",
      field: "source.checkSuites",
      value: desired.source.checkSuites,
    });
  }

  // Build fields
  diffField("build.builder", desired.build?.builder, current.builder);
  diffField("build.dockerfilePath", desired.build?.dockerfilePath, current.dockerfilePath);
  diffField("build.buildCommand", desired.build?.buildCommand, current.buildCommand);
  diffField("build.watchPatterns", desired.build?.watchPatterns, current.watchPatterns);
  // build.nixpacksConfigPath is write-through (not on serviceInstance read
  // type). Mirrors source.branch pattern: emit ADD when desired declares
  // a value; the live read cannot verify.
  if (desired.build?.nixpacksConfigPath !== undefined) {
    entries.push({
      kind: "ADD",
      field: "build.nixpacksConfigPath",
      value: desired.build.nixpacksConfigPath,
    });
  }

  return entries;
}

/**
 * Equality comparator used by {@link computeServiceInstanceDiff}.
 *
 * **Array semantics: order-sensitive (intentional).** Arrays are equal only
 * when they have the same length AND the same element at each index. This
 * is the conservative choice for Railway's `watchPatterns`: changing the
 * order may semantically signal different precedence to Railway's build
 * system (and even if Railway treats them as an unordered set, the false-
 * positive class — emitting a CHANGE entry on reorder-only diffs — only
 * over-reports; it does not under-report). If Railway is confirmed
 * order-insensitive for any field in the future, switch to a sorted
 * comparison and document the swap in this docstring.
 */
function arrayOrScalarEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * Flatten the Minsky-side nested `source.*` / `build.*` shape into Railway's
 * flat `ServiceInstanceUpdateInput`. Only fields actually declared in the
 * input are included; unset fields are omitted so the mutation doesn't
 * touch them.
 */
export function flattenToServiceInstanceInput(desired: {
  source?: RailwaySource;
  build?: RailwayBuild;
}): ServiceInstanceUpdateInput {
  const input: ServiceInstanceUpdateInput = {};
  if (desired.source?.repo !== undefined) input.repo = desired.source.repo;
  if (desired.source?.branch !== undefined) input.branch = desired.source.branch;
  if (desired.source?.rootDirectory !== undefined) {
    input.rootDirectory = desired.source.rootDirectory;
  }
  if (desired.source?.checkSuites !== undefined) input.checkSuites = desired.source.checkSuites;
  if (desired.build?.builder !== undefined) input.builder = desired.build.builder;
  if (desired.build?.dockerfilePath !== undefined) {
    input.dockerfilePath = desired.build.dockerfilePath;
  }
  if (desired.build?.buildCommand !== undefined) input.buildCommand = desired.build.buildCommand;
  if (desired.build?.watchPatterns !== undefined) {
    input.watchPatterns = desired.build.watchPatterns;
  }
  if (desired.build?.nixpacksConfigPath !== undefined) {
    input.nixpacksConfigPath = desired.build.nixpacksConfigPath;
  }
  return input;
}

/**
 * Render a deploy-trigger diff as human-readable lines (one per entry).
 * NO-CHANGE entries are summarized as a single trailing line.
 */
export function formatServiceInstanceDiff(diff: ServiceInstanceDiffEntry[]): string {
  if (diff.length === 0) return "No deploy-trigger changes.";
  const lines: string[] = [];
  const noChangeCount = diff.filter((e) => e.kind === "NO-CHANGE").length;
  for (const entry of diff) {
    if (entry.kind === "ADD") {
      lines.push(`+ ADD    ${entry.field} = ${formatValue(entry.value)}`);
    } else if (entry.kind === "CHANGE") {
      lines.push(`~ CHANGE ${entry.field}: ${formatValue(entry.from)} → ${formatValue(entry.to)}`);
    }
  }
  if (lines.length === 0 && noChangeCount > 0) {
    lines.push("No deploy-trigger changes.");
  }
  if (noChangeCount > 0 && lines.length > 0 && lines[0] !== "No deploy-trigger changes.") {
    lines.push(`  (${noChangeCount} field(s) unchanged)`);
  }
  return lines.join("\n");
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "(unset)";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

export function formatDiffOutput(
  diff: DiffEntry[],
  desired: Record<string, VariableValue>,
  prune = false
): string {
  const lines: string[] = [];
  const summary = summarizeDiff(diff);

  const actionableChanges = prune
    ? [
        ...summary.toAdd,
        ...summary.toRemove,
        ...summary.toChangeValue,
        ...summary.toChangeSealedFlag,
      ]
    : [...summary.toAdd, ...summary.toChangeValue, ...summary.toChangeSealedFlag];

  if (actionableChanges.length === 0 && summary.toRemove.length === 0) {
    lines.push("No changes.");
    return lines.join("\n");
  }

  for (const entry of summary.toAdd) {
    const desiredVal = desired[entry.key];
    const displayVal =
      desiredVal !== undefined && isSecretRef(desiredVal) ? "(sealed)" : entry.patch.value;
    lines.push(`+ ADD    ${entry.key} = ${displayVal}`);
  }

  for (const entry of summary.toRemove) {
    if (prune) {
      lines.push(`- REMOVE ${entry.key}`);
    } else {
      lines.push(`? WOULD-PRUNE ${entry.key} (skipped, use --prune to delete)`);
    }
  }

  for (const entry of summary.toChangeValue) {
    const desiredVal = desired[entry.key];
    const displayVal =
      desiredVal !== undefined && isSecretRef(desiredVal) ? "(sealed)" : entry.patch.value;
    lines.push(`~ CHANGE ${entry.key} = ${displayVal}`);
  }

  for (const entry of summary.toChangeSealedFlag) {
    lines.push(`~ SEAL   ${entry.key} (isSealed -> ${entry.patch.isSealed})`);
  }

  if (summary.noChange.length > 0) {
    lines.push(`  (${summary.noChange.length} variable(s) unchanged)`);
  }

  return lines.join("\n");
}
