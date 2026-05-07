#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
