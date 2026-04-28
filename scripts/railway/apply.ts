#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type RailwayConfig,
  type CurrentVar,
  type DiffEntry,
  type VariablePatch,
  isSecretRef,
  resolveVariableValue,
  computeDiff,
  buildVariablePatches,
  buildJsonPatch,
  formatDiffOutput,
  summarizeDiff,
} from "./lib";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

const RAILWAY_SYSTEM_PREFIXES = ["RAILWAY_"];

function isSystemVar(key: string): boolean {
  return RAILWAY_SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function readRailwayToken(): string {
  const cfgPath = join(homedir(), ".railway", "config.json");
  if (!existsSync(cfgPath)) {
    throw new Error(
      "Railway CLI is not authenticated (missing ~/.railway/config.json). Run: railway login"
    );
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
    user?: { accessToken?: string };
  };
  const token = cfg.user?.accessToken;
  if (!token) {
    throw new Error(
      "Railway CLI is not authenticated (no user.accessToken in ~/.railway/config.json). Run: railway login"
    );
  }
  return token;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = readRailwayToken();
  const res = await fetch(RAILWAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as {
    data?: T;
    errors?: { message?: string; path?: (string | number)[] }[];
  };
  if (body.errors) {
    const summary = body.errors
      .map((e) => {
        const path = e.path ? ` at ${e.path.join(".")}` : "";
        return `${e.message ?? "unknown GraphQL error"}${path}`;
      })
      .join("; ");
    throw new Error(`GraphQL error: ${summary}`);
  }
  if (!body.data) throw new Error(`GraphQL returned no data for query: ${query.slice(0, 80)}`);
  return body.data;
}

async function fetchCurrentVariables(
  projectId: string,
  environmentId: string,
  serviceId: string
): Promise<Record<string, CurrentVar>> {
  const data = await graphql<unknown>(
    `
      query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        variables(
          projectId: $projectId
          environmentId: $environmentId
          serviceId: $serviceId
          unrendered: true
        )
      }
    `,
    { projectId, environmentId, serviceId }
  );

  const rawVars = (data as { variables: Record<string, string | null> }).variables;
  const result: Record<string, CurrentVar> = {};

  for (const [key, value] of Object.entries(rawVars)) {
    if (isSystemVar(key)) continue;
    if (value === null) {
      result[key] = { value: "", isSealed: true };
    } else {
      result[key] = { value };
    }
  }

  return result;
}

function applyJsonPatch(patchObj: object): void {
  const patchJson = JSON.stringify(patchObj);
  const proc = Bun.spawnSync(["railway", "environment", "edit", "--json"], {
    stdin: new TextEncoder().encode(patchJson),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    const stderrText = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "(no stderr)";
    throw new Error(`railway environment edit failed (exit ${proc.exitCode}): ${stderrText}`);
  }
}

function loadConfig(serviceDir: string): RailwayConfig {
  const configPath = resolve(serviceDir, "railway.config.ts");
  if (!existsSync(configPath)) {
    throw new Error(`No railway.config.ts found at: ${configPath}`);
  }
  const mod = require(configPath) as { default?: RailwayConfig };
  if (!mod.default) {
    throw new Error(`railway.config.ts at ${configPath} must export a default RailwayConfig`);
  }
  return mod.default;
}

function buildAllSecretPatches(
  config: RailwayConfig,
  diff: DiffEntry[]
): Record<string, VariablePatch> {
  const patches: Record<string, VariablePatch> = {};
  for (const entry of diff) {
    if (entry.kind === "NO-CHANGE") {
      const val = config.variables[entry.key];
      if (val !== undefined && isSecretRef(val)) {
        const { resolvedValue } = resolveVariableValue(val);
        patches[entry.key] = { value: resolvedValue, isSealed: true };
      }
    }
  }
  return patches;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const serviceDir = args.find((a) => !a.startsWith("--"));

  if (!serviceDir) {
    console.error("Usage: bun scripts/railway/apply.ts <service-dir> [--execute]");
    console.error("");
    console.error("  <service-dir>   Path to a directory containing railway.config.ts");
    console.error("  --execute       Apply changes (default: dry-run only)");
    process.exit(1);
  }

  const config = loadConfig(serviceDir);

  console.log(`Service:     ${config.serviceId}`);
  console.log(`Environment: ${config.environmentId}`);
  console.log(`Project:     ${config.projectId}`);
  console.log(`Mode:        ${execute ? "APPLY" : "DRY-RUN"}`);
  console.log("");

  console.log("Fetching current Railway variables...");
  const current = await fetchCurrentVariables(
    config.projectId,
    config.environmentId,
    config.serviceId
  );

  const diff = computeDiff(config.variables, current);
  const summary = summarizeDiff(diff);

  const changes = [
    ...summary.toAdd,
    ...summary.toRemove,
    ...summary.toChangeValue,
    ...summary.toChangeSealedFlag,
  ];

  console.log("Diff:");
  const output = formatDiffOutput(diff, config.variables);
  for (const line of output.split("\n")) {
    console.log(`  ${line}`);
  }

  if (changes.length === 0) {
    console.log("");
    if (execute) {
      const secretKeys = Object.keys(config.variables).filter((k) => {
        const v = config.variables[k];
        return v !== undefined && isSecretRef(v);
      });
      if (secretKeys.length > 0) {
        console.log(
          `Re-sealing ${secretKeys.length} secret variable(s) with isSealed=true (values unchanged).`
        );
        const allPatches = buildAllSecretPatches(config, diff);
        if (Object.keys(allPatches).length > 0) {
          const patch = buildJsonPatch(config.serviceId, allPatches);
          applyJsonPatch(patch);
          console.log(`Applied ${Object.keys(allPatches).length} secret re-seal(s).`);
        }
      }
    }
    console.log("No changes.");
    return;
  }

  if (!execute) {
    console.log("");
    console.log("Dry-run complete. Pass --execute to apply changes.");
    return;
  }

  console.log("");
  console.log("Applying changes...");

  const nonSecretPatches = buildVariablePatches(diff);
  const secretReseals = buildAllSecretPatches(config, diff);
  const allPatches = { ...nonSecretPatches, ...secretReseals };
  const removals = summary.toRemove.map((e) => e.key);

  if (Object.keys(allPatches).length > 0) {
    const patch = buildJsonPatch(config.serviceId, allPatches);
    applyJsonPatch(patch);
    const nonSecretCount = Object.keys(nonSecretPatches).length;
    const sealCount = Object.keys(secretReseals).length;
    console.log(`  Applied: ${nonSecretCount} variable change(s), ${sealCount} secret re-seal(s).`);
  }

  if (removals.length > 0) {
    console.log(
      `  WARNING: ${removals.length} variable(s) exist on Railway but not in the config file:`
    );
    for (const key of removals) {
      console.log(`    - ${key}`);
    }
    console.log("  Removals are not applied automatically. Remove them manually if intended.");
  }

  console.log("");
  console.log("Verifying (read-back)...");
  const afterApply = await fetchCurrentVariables(
    config.projectId,
    config.environmentId,
    config.serviceId
  );

  const diffAfter = computeDiff(config.variables, afterApply);
  const summaryAfter = summarizeDiff(diffAfter);
  const changesAfter = [
    ...summaryAfter.toAdd,
    ...summaryAfter.toRemove,
    ...summaryAfter.toChangeValue,
    ...summaryAfter.toChangeSealedFlag,
  ];

  if (changesAfter.length === 0) {
    console.log("Read-back confirmed: no remaining changes.");
  } else {
    console.log("WARNING: read-back shows remaining differences:");
    const afterOutput = formatDiffOutput(diffAfter, config.variables);
    for (const line of afterOutput.split("\n")) {
      console.log(`  ${line}`);
    }
  }
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
