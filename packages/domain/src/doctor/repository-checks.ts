/**
 * The repository-facing project checks (mt#5154): recorded identity vs
 * origin, GitHub App installation coverage (setup's check, shared), and the
 * user token's access to the repo. Pure over their injected deps; see
 * `project-checks.ts` for the defaults.
 */

import { getErrorMessage } from "../errors/index";
import {
  compareRepositoryIdentity,
  type RecordedRepositoryIdentity,
} from "../project/repository-drift";
import {
  describeConfiguredAppRoles,
  formatAppCoverage,
  type AppRoleCoverage,
} from "../setup/app-coverage";
import {
  PROJECT_CHECKS,
  type Deps,
  type ProjectDoctorDiagnostic,
  type ProjectDoctorInput,
} from "./types";

export function identityCheck(
  input: ProjectDoctorInput,
  deps: Deps
): { diagnostic: ProjectDoctorDiagnostic; ownerRepo: string | null } {
  const check = PROJECT_CHECKS.identity;
  const recorded: RecordedRepositoryIdentity = {
    ...(input.config.repository ?? {}),
    slug: input.config.project?.slug,
  };
  let origin: string | null;
  try {
    origin = deps.readOriginUrl(input.workspacePath);
  } catch {
    origin = null;
  }
  const result = compareRepositoryIdentity(recorded, origin);
  switch (result.kind) {
    case "match":
      return {
        ownerRepo: result.slug,
        diagnostic: {
          check,
          status: "pass",
          scope: "project",
          message: `Recorded repository identity matches origin (${result.slug}).`,
        },
      };
    case "drift":
      return {
        ownerRepo: result.slug,
        diagnostic: {
          check,
          status: "error",
          scope: "project",
          message: `Recorded repository identity disagrees with origin (${result.slug}): ${result.findings
            .map((f) => `${f.field} is "${f.recorded}", origin says "${f.expected}"`)
            .join("; ")}.`,
          suggestion:
            "Run `minsky init --overwrite` in the project to re-derive it from origin (mt#5159 will make this automatic).",
        },
      };
    case "no-origin":
      return {
        ownerRepo: recorded.slug ?? null,
        diagnostic: {
          check,
          status: "warning",
          scope: "project",
          message:
            "The workspace has no `origin` remote; the recorded repository identity could not be compared.",
          suggestion:
            "Add a GitHub remote (`git remote add origin …`) and re-run `minsky init --overwrite`.",
        },
      };
    case "unparseable-origin":
      return {
        ownerRepo: recorded.slug ?? null,
        diagnostic: {
          check,
          status: "warning",
          scope: "project",
          message: `origin (${result.originUrl}) is not a GitHub owner/name URL Minsky can compare against.`,
        },
      };
  }
}

export async function coverageCheck(
  input: ProjectDoctorInput,
  deps: Deps,
  ownerRepo: string | null
): Promise<ProjectDoctorDiagnostic[]> {
  const check = PROJECT_CHECKS.coverage;
  if (!ownerRepo) {
    return [
      {
        check,
        status: "warning",
        scope: "project",
        message: "No repository identity to check App coverage against (see Repository Identity).",
      },
    ];
  }
  let coverage: AppRoleCoverage[];
  try {
    coverage = await deps.appCoverage(ownerRepo, describeConfiguredAppRoles(input.config));
  } catch (error) {
    return [
      {
        check,
        status: "error",
        scope: "project",
        message: `GitHub App coverage check failed: ${getErrorMessage(error)}`,
      },
    ];
  }
  return coverage.map((entry) => {
    const message = formatAppCoverage(entry.status, entry.slug, entry.settingsUrl);
    const status =
      entry.status.state === "covered"
        ? "pass"
        : entry.status.state === "not-covered"
          ? "error"
          : "warning";
    return {
      check: `${check} (${entry.role})`,
      status,
      scope: "project",
      message,
      ...(entry.status.state === "not-covered" && entry.settingsUrl
        ? {
            suggestion: `Grant the installation access to ${ownerRepo} at ${entry.settingsUrl}, or run \`minsky setup\` to file the request.`,
          }
        : {}),
    };
  });
}

export async function tokenCheck(
  input: ProjectDoctorInput,
  deps: Deps,
  ownerRepo: string | null
): Promise<ProjectDoctorDiagnostic> {
  const check = PROJECT_CHECKS.token;
  const token = input.config.github?.token?.trim();
  if (!token) {
    return {
      check,
      status: "warning",
      scope: "project",
      message: "No `github.token` is configured; repository access was not checked.",
    };
  }
  if (!ownerRepo) {
    return {
      check,
      status: "warning",
      scope: "project",
      message: "No repository identity to check token access against (see Repository Identity).",
    };
  }
  const access = await deps.tokenRepoAccess(ownerRepo, token);
  switch (access.state) {
    case "push":
      return {
        check,
        status: "pass",
        scope: "project",
        message: `The configured token has push access to ${ownerRepo}.`,
      };
    case "read-only":
      return {
        check,
        status: "error",
        scope: "project",
        message: `The configured token can read ${ownerRepo} but not push — PR creation and merge will fail.`,
        suggestion:
          "Grant the token write access to the repository (fine-grained PAT: Repository access + Contents/Pull requests: Read and write).",
      };
    case "not-accessible":
      return {
        check,
        status: "error",
        scope: "project",
        message: `The configured token cannot access ${ownerRepo} (HTTP ${access.status}) — its repository access does not include this repo, or the repository does not exist. \`session_pr_merge\` fails with "Resource not accessible by personal access token" here.`,
        suggestion:
          "Add the repository to the token's Repository access (github.com → Settings → Developer settings → Fine-grained tokens), or use a token that covers it.",
      };
    case "unknown":
      return {
        check,
        status: "warning",
        scope: "project",
        message: `Token access to ${ownerRepo} could not be verified: ${access.reason}.`,
      };
  }
}
