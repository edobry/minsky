/**
 * Supabase service-role key provider (mt#4028).
 *
 * DISTINCT from `supabaseProvider` (./supabase.ts), which owns the Management
 * API PAT (`sbp_*`) at `supabase.accessToken`. This one owns the PROJECT-scoped
 * service-role secret at `supabase.serviceRoleKey` — the credential the
 * transcript archive uses for private-bucket Storage access (ADR-025, mt#2680).
 * They are different secrets with different issuers, different config paths, and
 * different validation endpoints; pasting one into the other's row fails.
 *
 * Registering it here is what gives the key a MASKED entry surface: the cockpit
 * credentials widget auto-discovers providers (mt#2164), so the service-role key
 * can be entered through the web form instead of being requested in chat — the
 * transport `memory 82fac2c8` forbids, because the transcript is persisted to
 * disk AND ingested into the transcripts DB. Before this provider existed, the
 * masked surfaces had nowhere to put it.
 *
 * Validation reuses Supabase's documented private-bucket access pattern
 * (`apikey` + `Authorization: Bearer` against `<url>/storage/v1`), the same shape
 * `supabase-transcript-archive-store.ts` and `scripts/transcript-archive/provision.ts`
 * already use — listing buckets is the cheapest call on the surface Minsky
 * actually uses this key for.
 */
import { getConfiguration } from "../../configuration";
import type { CredentialProvider, CredentialCheckResult } from "../types";

/** Dashboard page holding the project's API keys. `_` resolves to the current project. */
const ACQUIRE_URL = "https://supabase.com/dashboard/project/_/settings/api-keys";

/** Minimal shape of the fetch used here — injectable so tests need no network. */
export type FetchLike = (
  url: string,
  init?: { headers: Record<string, string> }
) => Promise<{
  status: number;
  statusText: string;
  ok: boolean;
  json(): Promise<unknown>;
}>;

/**
 * Check a service-role key against the project's Storage API.
 *
 * Pure with respect to Minsky state: the project URL and the fetch are both
 * parameters, so this is directly testable without touching configuration or
 * the network. `null` url is a first-class case — the key is meaningless
 * without a project to point it at, and saying so is more useful than a
 * connection error.
 */
export async function checkServiceRoleKey(
  token: string,
  url: string | null,
  fetchImpl: FetchLike = (target, init) => fetch(target, init)
): Promise<CredentialCheckResult> {
  if (!url) {
    return {
      ok: false,
      detail:
        "supabase.url is not set — a service-role key is scoped to one project, so set the " +
        "project URL first (`minsky config set supabase.url https://<project-ref>.supabase.co`)",
    };
  }

  const base = url.replace(/\/+$/, "");
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${base}/storage/v1/bucket`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      detail:
        "401 Unauthorized — key invalid or revoked. Note this row wants the `service_role` " +
        "secret, not the `anon`/publishable key and not a `sbp_` Management API token",
      unauthorized: true,
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      detail:
        "403 Forbidden — the key authenticated but cannot administer Storage; a `service_role` " +
        "key can, an `anon` key cannot",
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: "response was not valid JSON" };
  }
  if (!Array.isArray(body)) {
    return { ok: false, detail: "unexpected response shape — expected a bucket list" };
  }
  return { ok: true, detail: `${body.length} bucket${body.length === 1 ? "" : "s"} visible` };
}

/**
 * Resolve `supabase.url` from configuration.
 *
 * Returns the URL, or an `error` when configuration itself could not be read.
 * The two are deliberately distinguishable: collapsing "config not initialized"
 * into "url not set" reports a broken accessor as a missing value, which is the
 * failure `memory 5b9d2c66` records (a clean-looking negative that was wrong).
 */
export function resolveProjectUrl(): { url: string | null } | { error: string } {
  try {
    return { url: getConfiguration().supabase?.url ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkAgainstConfiguredProject(token: string): Promise<CredentialCheckResult> {
  const resolved = resolveProjectUrl();
  if ("error" in resolved) {
    return {
      ok: false,
      detail: `could not read configuration to resolve supabase.url: ${resolved.error}`,
    };
  }
  return checkServiceRoleKey(token, resolved.url);
}

export const supabaseServiceRoleProvider: CredentialProvider = {
  id: "supabase-service-role",
  displayName: "Supabase (service-role key)",
  configPath: "supabase.serviceRoleKey",
  acquireUrl: ACQUIRE_URL,
  scopeGuidance:
    "Copy the `service_role` key from Project Settings -> API Keys — the SECRET one, not " +
    "`anon`/publishable, and not the `sbp_` Management API token the separate Supabase row " +
    "takes. It bypasses row-level security project-wide, so it is server-side only. Requires " +
    "`supabase.url` to be set for the project it belongs to.",
  validate: checkAgainstConfiguredProject,
  test: checkAgainstConfiguredProject,
  // No `isAvailable` gate, deliberately (mt#4028 planning audit, gate (m)):
  // hiding the row when `supabase.url` is unset would make the credential look
  // nonexistent to anyone looking for somewhere to put it — the exact inference
  // mt#3569 was filed to stop. The row is always listed; `validate` explains
  // what is missing.
};
