/**
 * Credential lifecycle orchestrator (mt#1426).
 *
 * Composes validate -> store -> test for a single provider invocation.
 *
 * The stored secret lands in `~/.config/minsky/config.yaml` via ConfigWriter.
 * Operational metadata (`lastValidatedAt`) lives in a sibling
 * `~/.config/minsky/credentials-meta.json` rather than in config.yaml — the
 * config schemas are `strictObject` and adding per-provider metadata fields
 * would propagate contract changes through every config consumer (Gate h).
 * A sibling file keeps that boundary clean.
 *
 * The metadata file is JSON-line-per-provider, plain text, mode 600.
 */
import { existsSync, readFileSync, statSync, chmodSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createConfigWriter } from "../configuration/config-writer";
import { getUserConfigDir } from "../configuration/sources/user";
import { getCredentialProvider, listCredentialProviders } from "./providers";
import type { CredentialCheckResult } from "./types";
import { clearInvalidation, notifyCredentialInvalidated } from "./invalidations";

/**
 * Where operational metadata for credentials lives. Co-located with
 * `config.yaml` under the same `getUserConfigDir()` resolution so HOME /
 * XDG_CONFIG_HOME overrides apply consistently across the credential
 * subsystem and the rest of Minsky's config layer.
 */
function credentialsMetaPath(): string {
  return join(getUserConfigDir(), "credentials-meta.json");
}

interface CredentialMeta {
  /** Provider id (e.g., "supabase"). */
  provider: string;
  /** ISO-8601 timestamp of the most recent successful validate or test. */
  lastValidatedAt: string;
  /** Detail line from the most recent successful check (display only — no secrets). */
  lastValidationDetail?: string;
}

type MetaFile = { credentials: CredentialMeta[] };

async function readMetaFile(): Promise<MetaFile> {
  const path = credentialsMetaPath();
  if (!existsSync(path)) return { credentials: [] };
  try {
    const content = readFileSync(path, "utf8") as string;
    const parsed: unknown = JSON.parse(content);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { credentials?: unknown }).credentials)
    ) {
      return parsed as MetaFile;
    }
  } catch {
    // Corrupt or unreadable — treat as empty; the next write replaces it.
  }
  return { credentials: [] };
}

async function writeMetaFile(meta: MetaFile): Promise<void> {
  const path = credentialsMetaPath();
  const dir = getUserConfigDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, JSON.stringify(meta, null, 2));
  // Mode 600 — the file doesn't contain secrets, but it pairs with config.yaml
  // (which DOES contain secrets) and they should share the same posture.
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is best-effort; Windows lacks POSIX modes.
  }
}

async function upsertMeta(entry: CredentialMeta): Promise<void> {
  const file = await readMetaFile();
  const idx = file.credentials.findIndex((c) => c.provider === entry.provider);
  if (idx >= 0) {
    file.credentials[idx] = entry;
  } else {
    file.credentials.push(entry);
  }
  await writeMetaFile(file);
}

async function removeMeta(provider: string): Promise<void> {
  const file = await readMetaFile();
  file.credentials = file.credentials.filter((c) => c.provider !== provider);
  await writeMetaFile(file);
}

/** Result of `addCredential` — never includes the token value. */
export interface AddCredentialResult {
  provider: string;
  validate: CredentialCheckResult;
  /** Present when validate succeeded and the token was persisted. */
  stored?: { configFilePath: string };
  /** Present when stored. */
  test?: CredentialCheckResult;
}

/**
 * Run the full add lifecycle for one provider.
 *
 * 1. validate(token) — abort if !ok.
 * 2. ConfigWriter.setConfigValue(configPath, token) — persist atomically with backup.
 * 3. test(token) — record outcome in metadata. scopeGap is NOT a failure: the token
 *    is stored, the caller surfaces the gap to the operator.
 */
export async function addCredential(
  providerId: string,
  token: string
): Promise<AddCredentialResult> {
  const provider = getCredentialProvider(providerId);
  if (!provider) {
    throw new Error(
      `Unknown credential provider: ${providerId}. Known providers: ${listCredentialProviders()
        .map((p) => p.id)
        .join(", ")}`
    );
  }

  const validate = await provider.validate(token);
  if (!validate.ok) {
    return { provider: provider.id, validate };
  }

  const writer = createConfigWriter({ createBackup: true, format: "yaml", validate: true });
  const writeResult = await writer.setConfigValue(provider.configPath, token);
  if (!writeResult.success) {
    throw new Error(`Failed to persist credential: ${writeResult.error}`);
  }
  await ensureConfigMode600(writeResult.filePath);

  const test = await provider.test(token);
  if (test.ok || test.scopeGap) {
    await upsertMeta({
      provider: provider.id,
      lastValidatedAt: new Date().toISOString(),
      lastValidationDetail: test.detail,
    });
    // Successful re-add clears any prior invalidation for this provider.
    await clearInvalidation(provider.id);
  }

  return {
    provider: provider.id,
    validate,
    stored: { configFilePath: writeResult.filePath },
    test,
  };
}

/** Listing entry for `listCredentials` — never includes the token value. */
export interface CredentialListing {
  provider: string;
  displayName: string;
  configPath: string;
  /** True when a value is present at configPath in config.yaml. */
  configured: boolean;
  /** ISO-8601 timestamp of the most recent successful validate; undefined if never. */
  lastValidatedAt?: string;
  /** Last successful-check detail line. */
  lastValidationDetail?: string;
}

/**
 * Return one listing per known provider. `configured` reflects ONLY the
 * user-level config.yaml (the file this subsystem writes to) — env-var-only
 * credentials are out of scope for the "managed via this flow" surface.
 */
export async function listCredentials(): Promise<CredentialListing[]> {
  const meta = await readMetaFile();
  const userConfig = await readUserConfigFile();
  return listCredentialProviders().map((provider) => {
    const metaEntry = meta.credentials.find((c) => c.provider === provider.id);
    return {
      provider: provider.id,
      displayName: provider.displayName,
      configPath: provider.configPath,
      configured: hasNestedValue(userConfig, provider.configPath),
      lastValidatedAt: metaEntry?.lastValidatedAt,
      lastValidationDetail: metaEntry?.lastValidationDetail,
    };
  });
}

async function readUserConfigFile(): Promise<Record<string, unknown>> {
  const { getUserConfigDir, userConfigFiles } = await import("../configuration/sources/user");
  const { parse } = await import("yaml");
  const dir = getUserConfigDir();
  for (const file of userConfigFiles) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8") as string;
      const ext = path.split(".").pop()?.toLowerCase();
      if (ext === "json") {
        return JSON.parse(content) as Record<string, unknown>;
      }
      return (parse(content) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

function hasNestedValue(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return false;
    const record = current as Record<string, unknown>;
    if (!(part in record)) return false;
    current = record[part];
  }
  return current !== undefined && current !== null && current !== "";
}

/** Remove a credential — unset the config value AND its metadata entry. */
export async function removeCredential(providerId: string): Promise<{ removed: boolean }> {
  const provider = getCredentialProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown credential provider: ${providerId}`);
  }
  const writer = createConfigWriter({ createBackup: true, format: "yaml", validate: true });
  const result = await writer.unsetConfigValue(provider.configPath);
  await removeMeta(provider.id);
  // Clear any pending invalidation — the credential no longer exists.
  await clearInvalidation(provider.id);
  return { removed: result.success };
}

/** Outcome of `recheckCredential` — never includes the token. */
export interface RecheckResult {
  provider: string;
  /** True if a credential was found in config.yaml. */
  configured: boolean;
  /** Test outcome — present when configured. */
  test?: CredentialCheckResult;
  /** True when the recheck observed a 401 and emitted an invalidation. */
  invalidated?: boolean;
}

/**
 * Re-run the smoke test on a stored credential to detect 401-since-store.
 * On 401 → calls notifyCredentialInvalidated and the next CLI consumer
 * sees a stderr notice (via consumeInvalidationNotice).
 * On success → updates lastValidatedAt and clears any prior invalidation.
 */
export async function recheckCredential(providerId: string): Promise<RecheckResult> {
  const provider = getCredentialProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown credential provider: ${providerId}`);
  }
  const token = await readStoredToken(provider.configPath);
  if (!token) {
    return { provider: provider.id, configured: false };
  }
  const test = await provider.test(token);
  if (test.unauthorized) {
    await notifyCredentialInvalidated(provider.id, test.detail);
    return { provider: provider.id, configured: true, test, invalidated: true };
  }
  if (test.ok || test.scopeGap) {
    await upsertMeta({
      provider: provider.id,
      lastValidatedAt: new Date().toISOString(),
      lastValidationDetail: test.detail,
    });
    await clearInvalidation(provider.id);
  }
  return { provider: provider.id, configured: true, test };
}

/** Recheck every configured credential. */
export async function recheckAllCredentials(): Promise<RecheckResult[]> {
  const providers = listCredentialProviders();
  const results: RecheckResult[] = [];
  for (const provider of providers) {
    results.push(await recheckCredential(provider.id));
  }
  return results;
}

async function readStoredToken(configPath: string): Promise<string | null> {
  const userConfig = await readUserConfigFile();
  const parts = configPath.split(".");
  let current: unknown = userConfig;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return null;
    const record = current as Record<string, unknown>;
    if (!(part in record)) return null;
    current = record[part];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

async function ensureConfigMode600(filePath: string): Promise<void> {
  try {
    const stat = statSync(filePath);

    const currentMode = stat.mode & 0o777;
    if (currentMode !== 0o600) {
      chmodSync(filePath, 0o600);
    }
  } catch {
    // best-effort
  }
}
