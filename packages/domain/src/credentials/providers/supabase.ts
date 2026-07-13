/**
 * Supabase Management API PAT provider (mt#1426).
 *
 * Validates and tests Supabase Personal Access Tokens (`sbp_*`) against
 * https://api.supabase.com/v1/projects. Same endpoint serves both validate
 * and test stages — the Management API has no public per-scope read endpoint,
 * so the project list IS the smoke surface Minsky uses (mt#1421 alert-rule
 * automation reads it).
 */
import type { CredentialProvider, CredentialCheckResult } from "../types";

const SUPABASE_PROJECTS_URL = "https://api.supabase.com/v1/projects";

async function callProjects(token: string): Promise<CredentialCheckResult> {
  let response: Response;
  try {
    response = await fetch(SUPABASE_PROJECTS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401) {
    return { ok: false, detail: "401 Unauthorized — token invalid or revoked", unauthorized: true };
  }
  if (response.status === 403) {
    return {
      ok: false,
      detail: "403 Forbidden — token lacks Management API permissions",
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  let projects: unknown;
  try {
    projects = await response.json();
  } catch {
    return { ok: false, detail: "response was not valid JSON" };
  }
  const count = Array.isArray(projects) ? projects.length : 0;
  return { ok: true, detail: `${count} project${count === 1 ? "" : "s"} visible` };
}

export const supabaseProvider: CredentialProvider = {
  id: "supabase",
  displayName: "Supabase",
  configPath: "supabase.accessToken",
  acquireUrl: "https://supabase.com/dashboard/account/tokens",
  scopeGuidance:
    "Generate a new Personal Access Token. Supabase PATs are scoped to your user's organizations; no per-scope checkboxes are required. Tokens are prefixed `sbp_`.",
  validate: callProjects,
  test: callProjects,
};
