/**
 * Credential invalidation tracking (mt#1426).
 *
 * Records when a stored credential has been observed returning 401 so that:
 *
 *   1. The next CLI command consuming that credential can print a one-line
 *      stderr notice to the operator.
 *   2. The cockpit can surface the invalidated state (via a future SSE
 *      `credential.invalidated` channel — wiring lands in a follow-up commit
 *      after the cockpit-dev subagent's server.ts changes settle).
 *
 * Storage: `~/.config/minsky/credentials-invalidated.json` — same directory
 * as config.yaml and credentials-meta.json. Mode 0600 to match.
 */
import { existsSync, readFileSync, chmodSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getUserConfigDir } from "../configuration/sources/user";

interface InvalidationEntry {
  /** Provider id (e.g., "github"). */
  provider: string;
  /** ISO-8601 timestamp the invalidation was observed. */
  observedAt: string;
  /** Short reason (e.g., "401 from GET /user"). No secrets. */
  reason: string;
  /**
   * Whether the next CLI consumer should print a stderr notice. Set to false
   * after the notice has been printed once so the same invalidation doesn't
   * nag on every subsequent command.
   */
  noticePending: boolean;
}

type InvalidationsFile = { invalidations: InvalidationEntry[] };

function invalidationsPath(): string {
  return join(getUserConfigDir(), "credentials-invalidated.json");
}

async function readFile(): Promise<InvalidationsFile> {
  const path = invalidationsPath();
  if (!existsSync(path)) return { invalidations: [] };
  try {
    const content = readFileSync(path, "utf8") as string;
    const parsed: unknown = JSON.parse(content);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { invalidations?: unknown }).invalidations)
    ) {
      return parsed as InvalidationsFile;
    }
  } catch {
    // Corrupt; treat as empty (next write replaces it).
  }
  return { invalidations: [] };
}

async function writeAtomic(file: InvalidationsFile): Promise<void> {
  const path = invalidationsPath();
  const dir = getUserConfigDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, JSON.stringify(file, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Record that a stored credential has been observed returning 401.
 * Idempotent: re-invalidating the same provider replaces the prior entry
 * and re-arms the `noticePending` flag.
 */
export async function notifyCredentialInvalidated(provider: string, reason: string): Promise<void> {
  const file = await readFile();
  const observedAt = new Date().toISOString();
  const entry: InvalidationEntry = {
    provider,
    observedAt,
    reason,
    noticePending: true,
  };
  const idx = file.invalidations.findIndex((e) => e.provider === provider);
  if (idx >= 0) {
    file.invalidations[idx] = entry;
  } else {
    file.invalidations.push(entry);
  }
  await writeAtomic(file);
}

/**
 * Read-and-clear the notice-pending flag for a provider. Returns the entry
 * (with noticePending: true) if a notice was pending; null otherwise.
 *
 * Called by credential consumers (e.g., CredentialResolver) to print the
 * stderr notice exactly once per invalidation cycle. The entry itself
 * remains in the file so future readers can see the credential was flagged.
 */
export async function consumeInvalidationNotice(
  provider: string
): Promise<{ reason: string; observedAt: string } | null> {
  const file = await readFile();
  const idx = file.invalidations.findIndex((e) => e.provider === provider);
  if (idx < 0) return null;
  const entry = file.invalidations[idx];
  if (!entry || !entry.noticePending) return null;
  const result = { reason: entry.reason, observedAt: entry.observedAt };
  entry.noticePending = false;
  await writeAtomic(file);
  return result;
}

/** Listing entry for the cockpit /api/credentials response and SSE payload. */
export interface InvalidationListing {
  provider: string;
  observedAt: string;
  reason: string;
}

/** List all currently-invalidated providers. Does NOT clear noticePending flags. */
export async function listInvalidations(): Promise<InvalidationListing[]> {
  const file = await readFile();
  return file.invalidations.map(({ provider, observedAt, reason }) => ({
    provider,
    observedAt,
    reason,
  }));
}

/**
 * Clear the invalidation for a provider entirely (called after a successful
 * re-add via `addCredential`, since the new token resets the slate).
 */
export async function clearInvalidation(provider: string): Promise<void> {
  const file = await readFile();
  file.invalidations = file.invalidations.filter((e) => e.provider !== provider);
  await writeAtomic(file);
}

/**
 * Consume the notice-pending flag for a provider and, if a notice was
 * pending, write a one-line message to stderr. This is the hook the spec
 * names as "on the next CLI command using that credential a one-line
 * 'credential invalidated' message is printed to stderr".
 *
 * Safe to call on every credential-read site — no-op if no notice pending.
 * Best-effort: any error reading/writing the sentinel is swallowed (we
 * never want a credential read to fail due to invalidation bookkeeping).
 */
export async function consumeAndReportInvalidationNotice(provider: string): Promise<void> {
  try {
    const notice = await consumeInvalidationNotice(provider);
    if (notice) {
      process.stderr.write(
        `credential invalidated (${provider}: ${notice.reason}) — run \`minsky config credentials add ${provider}\` to refresh\n`
      );
    }
  } catch {
    // best-effort
  }
}
