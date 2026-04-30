#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type RailwayConfig,
  type CurrentVar,
  assertHttpOk,
  computeDiff,
  buildVariablePatches,
  buildAllSecretPatches,
  buildJsonPatch,
  formatDiffOutput,
  summarizeDiff,
} from "./lib";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const GRAPHQL_TIMEOUT_MS = 30_000;

const RAILWAY_SYSTEM_PREFIXES = ["RAILWAY_", "NIXPACKS_", "RAILPACK_"] as const;
// Exact keys auto-injected by Railway that do not carry a recognizable prefix.
const RAILWAY_SYSTEM_KEYS = new Set(["PORT"] as const);

function isPlatformInjectedVar(key: string): boolean {
  if (RAILWAY_SYSTEM_KEYS.has(key)) return true;
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Railway API request timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
    }
    throw new Error(
      `Railway API network error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const bodyText = await res.text();

  if (!res.ok) {
    assertHttpOk(res.status, res.statusText, bodyText);
  }

  let body: { data?: T; errors?: { message?: string; path?: (string | number)[] }[] };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch (parseErr) {
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    throw new Error(`Railway API returned non-JSON response (HTTP ${res.status}): ${truncated}`, {
      cause: parseErr,
    });
  }

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
    const nullPatches: Record<string, null> = {};
    for (const key of removals) {
      nullPatches[key] = null;
    }
    const removalPatch = {
      services: {
        [config.serviceId]: {
          variables: nullPatches,
        },
      },
    };
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
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
