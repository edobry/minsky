#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type RailwayConfig,
  type CurrentVar,
  type RailwaySource,
  type RailwayBuild,
  computeDiff,
  buildVariablePatches,
  buildAllSecretPatches,
  buildJsonPatch,
  buildDeletePatch,
  formatDiffOutput,
  summarizeDiff,
  graphql,
  applyServiceInstanceUpdate,
  fetchServiceInstanceState,
  computeServiceInstanceDiff,
  flattenToServiceInstanceInput,
  formatServiceInstanceDiff,
} from "./lib";

const RAILWAY_SYSTEM_PREFIXES = ["RAILWAY_", "NIXPACKS_", "RAILPACK_"] as const;
// Exact keys auto-injected by Railway that do not carry a recognizable prefix.
const RAILWAY_SYSTEM_KEYS = new Set(["PORT"] as const);

function isPlatformInjectedVar(key: string): boolean {
  if (RAILWAY_SYSTEM_KEYS.has(key)) return true;
  return RAILWAY_SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
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
    if (isPlatformInjectedVar(key)) continue;
    if (value === null) {
      result[key] = { value: "", isSealed: true };
    } else {
      result[key] = { value };
    }
  }

  return result;
}

const APPLY_COMMAND = "railway environment edit --json";

function applyJsonPatch(patchObj: object): void {
  const patchJson = JSON.stringify(patchObj);
  const proc = Bun.spawnSync(["railway", "environment", "edit", "--json"], {
    stdin: new TextEncoder().encode(patchJson),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    const stderrText = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "(no stderr)";
    // stdout is intentionally excluded: it echoes the JSON patch input which may contain secret values.
    throw new Error(`${APPLY_COMMAND} failed (exit ${proc.exitCode}): ${stderrText}`);
  }
}

async function loadConfig(serviceDir: string): Promise<RailwayConfig> {
  const configPath = resolve(serviceDir, "railway.config.ts");
  if (!existsSync(configPath)) {
    throw new Error(`No railway.config.ts found at: ${configPath}`);
  }
  const mod = (await import(pathToFileURL(configPath).href)) as
    | { default?: RailwayConfig }
    | RailwayConfig;
  // Handle ESM default export (mod.default) and CJS-shaped exports (mod itself).
  const config =
    mod && typeof mod === "object" && "default" in mod && mod.default != null
      ? mod.default
      : (mod as RailwayConfig);
  if (!config || typeof config !== "object" || !("serviceId" in config)) {
    throw new Error(
      `railway.config.ts at ${configPath} must export a valid RailwayConfig as the default export`
    );
  }
  return config;
}

/**
 * Deploy-trigger declarative config loaded from deploy.config.ts (mt#2000).
 * Only the railway-platform variant is supported today (per mt#1730 v1).
 * Returns null when:
 *   - deploy.config.ts does not exist at the service-dir, OR
 *   - deploy.config.ts exists but does NOT declare `source` or `build`
 *     blocks (services that haven't been migrated yet skip the deploy-
 *     trigger pass without error).
 */
interface DeployTriggerSpec {
  source?: RailwaySource;
  build?: RailwayBuild;
}

async function loadDeployConfig(serviceDir: string): Promise<DeployTriggerSpec | null> {
  const configPath = resolve(serviceDir, "deploy.config.ts");
  if (!existsSync(configPath)) return null;

  type DeployModuleShape = {
    platform: "railway" | string;
    railway?: {
      source?: RailwaySource;
      build?: RailwayBuild;
    };
  };
  type DeployModule = { default?: DeployModuleShape } | DeployModuleShape;

  const mod = (await import(pathToFileURL(configPath).href)) as DeployModule;
  // PR #1214 R1 BLOCKING #3: mirror loadConfig's ESM/CJS fallback so
  // configs that export the object directly (not as default) also load.
  const cfg =
    mod && typeof mod === "object" && "default" in mod && mod.default != null
      ? (mod.default as DeployModuleShape)
      : (mod as DeployModuleShape);

  if (!cfg || typeof cfg !== "object") return null;

  if (cfg.platform !== "railway") {
    // Surface non-railway platforms so the operator knows the deploy-trigger
    // pass was deliberately skipped (vs. a silent miss).
    console.warn(
      `[apply] deploy.config.ts platform=${cfg.platform} is not "railway"; ` +
        `deploy-trigger reconciliation skipped (only railway is supported in v1).`
    );
    return null;
  }

  if (!cfg.railway || typeof cfg.railway !== "object") {
    console.warn(
      `[apply] deploy.config.ts has platform=railway but no railway block; ` +
        `deploy-trigger reconciliation skipped.`
    );
    return null;
  }

  const { source, build } = cfg.railway;
  if (source === undefined && build === undefined) return null;
  return { source, build };
}

/**
 * Reconcile the deploy-trigger config (source + build blocks) against the
 * live Railway service. Mirrors the env-var reconciliation flow:
 *   - Fetch live state via fetchServiceInstanceState
 *   - Compute diff via computeServiceInstanceDiff
 *   - Print human-readable diff
 *   - On --execute, apply via applyServiceInstanceUpdate (after flatten)
 *   - Verify by re-reading
 *
 * No-op when `deployConfig` is null (no deploy.config.ts or no source/build
 * blocks declared).
 */
async function reconcileDeployTrigger(
  config: RailwayConfig,
  deployConfig: DeployTriggerSpec | null,
  execute: boolean
): Promise<void> {
  if (!deployConfig) {
    console.log("");
    console.log(
      "Deploy-trigger reconciliation: skipped (no deploy.config.ts source/build blocks)."
    );
    return;
  }

  console.log("");
  console.log("Fetching current Railway deploy-trigger state...");
  const current = await fetchServiceInstanceState(config.environmentId, config.serviceId);
  if (!current) {
    throw new Error(
      `Service ${config.serviceId} not found in environment ${config.environmentId} ` +
        `(deploy-trigger read). Check the service/environment IDs in railway.config.ts.`
    );
  }

  const diff = computeServiceInstanceDiff(deployConfig, current);
  const actionableChanges = diff.filter((e) => e.kind === "ADD" || e.kind === "CHANGE");

  console.log("Deploy-trigger diff:");
  const output = formatServiceInstanceDiff(diff);
  for (const line of output.split("\n")) {
    console.log(`  ${line}`);
  }

  if (actionableChanges.length === 0) {
    console.log("");
    console.log("Deploy-trigger: no changes.");
    return;
  }

  if (!execute) {
    console.log("");
    console.log("Deploy-trigger dry-run complete. Pass --execute to apply changes.");
    return;
  }

  console.log("");
  console.log("Applying deploy-trigger changes...");
  const input = flattenToServiceInstanceInput(deployConfig);
  await applyServiceInstanceUpdate(config.serviceId, config.environmentId, input);
  console.log(`  Applied: ${actionableChanges.length} deploy-trigger field change(s).`);

  console.log("");
  console.log("Verifying deploy-trigger (read-back)...");
  const afterApply = await fetchServiceInstanceState(config.environmentId, config.serviceId);
  if (!afterApply) {
    console.log("WARNING: deploy-trigger read-back returned null (service vanished?).");
    return;
  }
  const diffAfter = computeServiceInstanceDiff(deployConfig, afterApply);
  const actionableAfter = diffAfter.filter((e) => e.kind === "ADD" || e.kind === "CHANGE");
  if (actionableAfter.length === 0) {
    console.log("Deploy-trigger read-back confirmed: no remaining changes.");
  } else {
    console.log("WARNING: deploy-trigger read-back shows remaining differences:");
    const afterOutput = formatServiceInstanceDiff(diffAfter);
    for (const line of afterOutput.split("\n")) {
      console.log(`  ${line}`);
    }
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const prune = args.includes("--prune");
  const resealSecrets = args.includes("--reseal-secrets");
  const serviceDir = args.find((a) => !a.startsWith("--"));

  if (!serviceDir) {
    console.error(
      "Usage: bun scripts/railway/apply.ts <service-dir> [--execute] [--prune] [--reseal-secrets]"
    );
    console.error("");
    console.error("  <service-dir>      Path to a directory containing railway.config.ts");
    console.error("  --execute          Apply changes (default: dry-run only)");
    console.error(
      "  --prune            Also delete variables present in Railway but absent from config."
    );
    console.error("                     Without this flag, REMOVE entries are skipped even with");
    console.error("                     --execute, and shown as WOULD-PRUNE in dry-run output.");
    console.error(
      "                     Use with caution: deletes any out-of-band or auto-injected"
    );
    console.error("                     variables not declared in railway.config.ts.");
    console.error(
      "  --reseal-secrets   Re-push sealed secret values for NO-CHANGE SecretRef vars."
    );
    console.error("                     Without this flag, sealed secrets that are NO-CHANGE are");
    console.error(
      "                     never touched, even with --execute. Use only when you need"
    );
    console.error("                     to explicitly re-seal secrets with your local values.");
    process.exit(1);
  }

  const config = await loadConfig(serviceDir);
  // mt#2000: load deploy.config.ts (optional) for the deploy-trigger pass.
  // Resolved once up-front so every early-return path can still fire the
  // deploy-trigger reconciliation.
  const deployConfig = await loadDeployConfig(serviceDir);

  const modeLabel = execute ? (prune ? "APPLY+PRUNE" : "APPLY") : "DRY-RUN";
  console.log(`Service:     ${config.serviceId}`);
  console.log(`Environment: ${config.environmentId}`);
  console.log(`Project:     ${config.projectId}`);
  console.log(`Mode:        ${modeLabel}`);
  console.log("");

  console.log("Fetching current Railway variables...");
  const current = await fetchCurrentVariables(
    config.projectId,
    config.environmentId,
    config.serviceId
  );

  const diff = computeDiff(config.variables, current);
  const summary = summarizeDiff(diff);

  // Non-removal changes always counted; removals only count when --prune is active.
  const nonRemovalChanges = [
    ...summary.toAdd,
    ...summary.toChangeValue,
    ...summary.toChangeSealedFlag,
  ];
  const changes = prune ? [...nonRemovalChanges, ...summary.toRemove] : nonRemovalChanges;

  console.log("Diff:");
  const output = formatDiffOutput(diff, config.variables, prune);
  for (const line of output.split("\n")) {
    console.log(`  ${line}`);
  }

  if (changes.length === 0) {
    console.log("");
    if (execute && resealSecrets) {
      const allPatches = buildAllSecretPatches(config, diff);
      const resealCount = Object.keys(allPatches).length;
      if (resealCount > 0) {
        console.log(
          `Re-sealing ${resealCount} secret variable(s) (sealed NO-CHANGE entries only).`
        );
        const patch = buildJsonPatch(config.serviceId, allPatches);
        applyJsonPatch(patch);
        console.log(`Applied ${resealCount} secret re-seal(s).`);
      }
    }
    if (!prune && summary.toRemove.length > 0) {
      // WOULD-PRUNE entries exist but deletions are not enabled.
      console.log(
        `No actionable changes (${summary.toRemove.length} WOULD-PRUNE entry/entries skipped). Pass --prune to delete.`
      );
    } else {
      console.log("No changes.");
    }
    await reconcileDeployTrigger(config, deployConfig, execute);
    return;
  }

  if (!execute) {
    console.log("");
    console.log("Dry-run complete. Pass --execute to apply changes.");
    await reconcileDeployTrigger(config, deployConfig, execute);
    return;
  }

  console.log("");
  console.log("Applying changes...");

  const nonSecretPatches = buildVariablePatches(diff);
  const secretReseals = resealSecrets ? buildAllSecretPatches(config, diff) : {};
  const allPatches = { ...nonSecretPatches, ...secretReseals };

  if (Object.keys(allPatches).length > 0) {
    const patch = buildJsonPatch(config.serviceId, allPatches);
    applyJsonPatch(patch);
    const nonSecretCount = Object.keys(nonSecretPatches).length;
    const sealCount = Object.keys(secretReseals).length;
    console.log(`  Applied: ${nonSecretCount} variable change(s), ${sealCount} secret re-seal(s).`);
  }

  if (prune && summary.toRemove.length > 0) {
    const removals = summary.toRemove.map((e) => e.key);
    const removalPatch = buildDeletePatch(config.serviceId, removals);
    applyJsonPatch(removalPatch);
    console.log(`  Removed: ${removals.length} variable(s): ${removals.join(", ")}`);
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
  const changesAfter = prune
    ? [
        ...summaryAfter.toAdd,
        ...summaryAfter.toRemove,
        ...summaryAfter.toChangeValue,
        ...summaryAfter.toChangeSealedFlag,
      ]
    : [...summaryAfter.toAdd, ...summaryAfter.toChangeValue, ...summaryAfter.toChangeSealedFlag];

  if (changesAfter.length === 0) {
    console.log("Read-back confirmed: no remaining changes.");
  } else {
    console.log("WARNING: read-back shows remaining differences:");
    const afterOutput = formatDiffOutput(diffAfter, config.variables, prune);
    for (const line of afterOutput.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  await reconcileDeployTrigger(config, deployConfig, execute);
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
