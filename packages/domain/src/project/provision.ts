/**
 * Project-row provisioning orchestration (mt#2934).
 *
 * Wires together the identity resolver + {@link ensureProjectRow} against a
 * CONFIRMED, live Postgres connection string. Shared by the two production
 * call sites decided in the mt#2934 spec's "Mechanism" section:
 *
 *   1. `performSetup`'s existing-connection branch (`../setup.ts`) — when
 *      `minsky setup` inherits an already-configured, verified connection.
 *   2. `runSetupDbConfigure`'s wizard success path (`../setup-db.ts`) — when
 *      `minsky setup db` finishes writing + migrating + verifying a fresh
 *      connection.
 *
 * Both call sites hold a live, verified connection at the point they call
 * this — `resolveProjectScope` (read-hot, fail-open, 8+ call sites) is
 * deliberately NOT a provisioning point (rejected in planning; see the spec's
 * "Rejected: first-use-on-read" note).
 *
 * Deliberately decoupled from mt#2502's connection-inheritance types
 * (`ResolveExistingConnectionResult` etc.) — this module only needs a raw
 * connection string, not the inheritance-specific source/label metadata.
 */

import { resolveProjectIdentity, type ProjectIdentity } from "./identity";
import { deriveRemoteUrl } from "./slug";
import { ensureProjectRow, type ProjectsRepositoryDb } from "./projects-repository";
import { log } from "@minsky/shared/logger";

/** Options for {@link provisionProjectRow}. Both fields are optional. */
export interface ProvisionProjectRowOptions {
  /** Repo path used to resolve identity + git-remote URL. Defaults to `process.cwd()`. */
  repoPath?: string;
  /** Explicit repo URL override. Defaults to the git-remote `origin` URL at `repoPath`. */
  repoUrl?: string;
}

/** Result of a {@link provisionProjectRow} call. */
export interface ProvisionProjectRowResult {
  /** True iff a row was ensured to exist (created or already present). False when the project identity was unresolved OR provisioning failed. */
  provisioned: boolean;
  /** The resolved slug, present whenever identity resolution succeeded (even if the subsequent DB write failed). */
  slug?: string;
}

/** Injectable dependencies for {@link provisionProjectRow}. Test seam only — production defaults are the real identity resolver, git-remote read, and Postgres connection. */
export interface ProvisionProjectRowDeps {
  /** Override identity resolution (default: real `resolveProjectIdentity`). */
  resolveIdentity?: (repoPath?: string) => ProjectIdentity;
  /** Override git-remote URL derivation (default: real `deriveRemoteUrl`). */
  deriveRemoteUrl?: (repoPath?: string) => string | null;
  /** Override DB-connection construction (default: real postgres-js + drizzle). */
  connect?: (
    connectionString: string
  ) => Promise<{ db: ProjectsRepositoryDb; close: () => Promise<void> }>;
}

async function defaultConnect(
  connectionString: string
): Promise<{ db: ProjectsRepositoryDb; close: () => Promise<void> }> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const sql = postgres(connectionString, { prepare: false, max: 1 });
  return {
    db: drizzle(sql),
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Resolve the current project's identity and idempotently ensure its
 * `projects` row exists against `connectionString` — a connection already
 * confirmed live by the caller (this function does NOT itself verify
 * connectivity).
 *
 * Never throws:
 * - An unresolved identity (no slug derivable — e.g. no git remote, no
 *   `.minsky/config.yaml` slug, no env/flag override) is a documented
 *   no-op: there is nothing to provision for a project with no name, and
 *   `resolveProjectScope` already fails open to `ALL_PROJECTS` for that
 *   case, so skipping provisioning here changes no observable behavior.
 * - A genuine provisioning error (bad connection, insert failure) is
 *   logged and swallowed rather than propagated — a failed opportunistic
 *   provisioning attempt must not fail the surrounding `setup` / `setup db`
 *   run, which has already succeeded at everything it promised by this
 *   point.
 */
export async function provisionProjectRow(
  connectionString: string,
  options: ProvisionProjectRowOptions = {},
  deps: ProvisionProjectRowDeps = {}
): Promise<ProvisionProjectRowResult> {
  const resolveIdentity =
    deps.resolveIdentity ?? ((repoPath?: string) => resolveProjectIdentity({ repoPath }));
  const deriveRemoteUrlFn =
    deps.deriveRemoteUrl ?? ((repoPath?: string) => deriveRemoteUrl(repoPath ?? process.cwd()));
  const connect = deps.connect ?? defaultConnect;

  const identity = resolveIdentity(options.repoPath);
  if (identity.kind !== "resolved") {
    log.debug(
      `[project-provision] No resolvable project identity (${identity.reason}); skipping row provisioning`
    );
    return { provisioned: false };
  }

  const repoUrl = options.repoUrl ?? deriveRemoteUrlFn(options.repoPath) ?? undefined;

  const { db, close } = await connect(connectionString);
  try {
    await ensureProjectRow(identity.slug, { repoUrl }, db);
    return { provisioned: true, slug: identity.slug };
  } catch (err) {
    log.warn(`[project-provision] Failed to ensure projects row for slug "${identity.slug}"`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { provisioned: false, slug: identity.slug };
  } finally {
    await close();
  }
}
