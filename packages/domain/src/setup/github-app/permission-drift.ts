/**
 * GitHub App permission drift detection (mt#3218).
 *
 * There is no API to mutate an existing App's permissions (see `update.ts`'s
 * doc comment) — the only real fix is the settings UI, and even then a
 * permission change is a *request* each installation must separately accept.
 * That makes a missing permission expensive to diagnose: it surfaces as an
 * opaque 403 from whatever call needed it, with nothing pointing at WHICH
 * permission is missing or WHERE to fix it.
 *
 * `GET /app` works (it is a read, not a mutation) and returns the App's live
 * permission set. This module compares that live set against what the
 * shipped code actually needs and, on a mismatch, formats an actionable
 * message: the exact settings URL for this App, the specific permission(s)
 * to change, and the installation-acceptance step — turning a 403 or a
 * config-doctor run into a ~60-second operator action instead of a
 * debugging session.
 */

/** A single permission requirement: a scope name and the minimum access level. */
export interface RequiredPermission {
  scope: string;
  level: "read" | "write";
}

/**
 * What the shipped code actually needs from the primary (implementer) App's
 * installation. Kept in lockstep with `DEFAULT_PERMISSIONS` in
 * `src/adapters/shared/commands/setup-github-app.ts` — that constant governs
 * what a FRESH App is created with; this one governs what an EXISTING App is
 * checked against. That lockstep is asserted by a test as of mt#3264
 * (`permission-drift.test.ts`); until then it was a claim in this comment only,
 * and it had been false for as long as both constants existed.
 *
 * `contents: write` is required by `session_commit`'s App-token push (mt#1477)
 * — the permission whose absence caused the mt#3210 incident. `workflows: write`
 * is required for a push that touches `.github/workflows/**` at all, which is
 * the mt#3264 incident.
 */
export const REQUIRED_APP_PERMISSIONS: RequiredPermission[] = [
  { scope: "pull_requests", level: "write" },
  { scope: "contents", level: "write" },
  { scope: "metadata", level: "read" },
  // mt#3264: `workflows` and `actions` were missing from this list for the whole
  // of mt#3218's life, which made the check silent about the exact permission
  // whose absence caused mt#3264's originating incident — a push carrying any
  // change under `.github/workflows/**` was rejected server-side, and
  // `config.doctor` reported "permissions match" throughout. GitHub requires the
  // `workflows` permission for an App to create or update a workflow file (see
  // "Choosing permissions for a GitHub App" in GitHub's docs), and `session_commit`
  // pushes those files routinely. `actions` backs the CI-status reads the shipped
  // code makes. Both are granted on the live App as of 2026-08-19; listing them
  // here is what makes a future revocation visible instead of silent.
  { scope: "workflows", level: "write" },
  { scope: "actions", level: "write" },
];

const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export interface MissingPermission {
  scope: string;
  required: string;
  actual: string | undefined;
}

export interface PermissionDriftResult {
  hasDrift: boolean;
  missing: MissingPermission[];
}

/**
 * Compares an App's LIVE permission set (as returned by `GET /app`) against
 * the permissions the shipped code requires. A permission is "missing" when
 * it is entirely absent OR granted at a lower access level than required
 * (e.g. `contents: read` when `write` is required) — GitHub's own level
 * ordering (`read` < `write` < `admin`) is used for the comparison so a
 * higher-than-required grant is never flagged as drift.
 */
export function detectPermissionDrift(
  actual: Record<string, string>,
  required: RequiredPermission[] = REQUIRED_APP_PERMISSIONS
): PermissionDriftResult {
  const missing: MissingPermission[] = [];
  for (const req of required) {
    const actualLevel = actual[req.scope];
    const actualRank = actualLevel ? (LEVEL_RANK[actualLevel] ?? 0) : 0;
    const requiredRank = LEVEL_RANK[req.level] ?? 0;
    if (actualRank < requiredRank) {
      missing.push({ scope: req.scope, required: req.level, actual: actualLevel });
    }
  }
  return { hasDrift: missing.length > 0, missing };
}

/** Builds the App's permissions-settings URL from its slug. */
export function githubAppSettingsUrl(slug: string): string {
  return `https://github.com/settings/apps/${slug}/permissions`;
}

/**
 * Formats an actionable message for a detected drift: the exact settings
 * URL, the specific permission(s) to change, and the installation-acceptance
 * step. Returns a short "matches" message when there is no drift.
 */
export function formatPermissionDriftMessage(slug: string, drift: PermissionDriftResult): string {
  if (!drift.hasDrift) {
    return `GitHub App '${slug}' permissions match what Minsky's code requires.`;
  }

  const settingsUrl = githubAppSettingsUrl(slug);
  const lines: string[] = [`GitHub App '${slug}' is missing required permissions:`];
  for (const m of drift.missing) {
    lines.push(`  - ${m.scope}: needs "${m.required}", currently "${m.actual ?? "(not granted)"}"`);
  }
  lines.push("");
  lines.push(`Fix at: ${settingsUrl}`);
  lines.push(
    "After saving, the installing account/org must separately accept the new permission " +
      "set before it takes effect — the change does not apply immediately."
  );
  return lines.join("\n");
}
