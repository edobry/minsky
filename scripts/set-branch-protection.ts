#!/usr/bin/env bun
//
// scripts/set-branch-protection.ts — apply the mt#1938 branch-protection config to
// `edobry/minsky:main`. Default behavior is dry-run (preview the desired config and
// the diff against the live state); pass `--apply` to actually call the API.
//
// Why this script exists:
//   The originating incident (PR #1163 / mt#1927, 2026-05-19) merged with a failing
//   required `build` check because `enforce_admins: false` let the admin token bypass
//   branch protection's required-status-check rule from the operator's terminal. The
//   load-bearing fix is to set `enforce_admins: true` on main, which the GitHub UI
//   does not expose convenient-enough for repeated drift checks. This script makes
//   the desired config declarative and auditable.
//
// Usage:
//   bun scripts/set-branch-protection.ts                    # dry-run (preview + diff vs live)
//   bun scripts/set-branch-protection.ts --check            # print live state + drift verdict
//   bun scripts/set-branch-protection.ts --apply            # apply default desired (enforce_admins=false)
//   bun scripts/set-branch-protection.ts --enforce-admins   # dry-run with enforce_admins=true
//   bun scripts/set-branch-protection.ts --enforce-admins --apply  # opt-in flip to enforce_admins=true
//
// `enforce_admins: true` is the load-bearing fix for mt#1938's originating-incident
// merge-bypass path (admin tokens skipping required-status-checks). The default
// desired config leaves it at `false` so this script's `--apply` path is
// non-disruptive; opting in requires the explicit `--enforce-admins` flag plus
// `--apply`. This makes the flip an operator-decided ceremony rather than a side
// effect of `--apply`. The hook (layer 1) and main-watch workflow (layer 3) cover
// distinct surfaces and ship enabled by default.
//
// Defaults follow the user's operational-safety-dry-run-first principle (CLAUDE.md).

const OWNER = "edobry";
const REPO = "minsky";
const BRANCH = "main";

// Desired branch-protection config. Mirrors the GitHub PUT /branches/<b>/protection
// schema. Required contexts are the CI job names that branch protection enforces.
//
// `enforce_admins` is intentionally LEFT AT FALSE in the default desired config.
// Flipping it to `true` is the load-bearing step that closes the operator-API
// bypass path identified in the mt#1938 originating incident — but the operator
// has chosen to defer that flip until layers 1 (this hook) and 3 (main-watch
// workflow) have been observed running in production. To opt in, pass
// `--enforce-admins` on the CLI (still `--apply`-gated).
const DESIRED_CONFIG_BASE = {
  required_status_checks: {
    strict: true,
    contexts: ["build", "Prevent Placeholder Tests"],
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
  },
  restrictions: null,
  required_linear_history: false,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
  lock_branch: false,
  allow_fork_syncing: false,
};

function buildDesiredConfig(enforceAdmins: boolean): typeof DESIRED_CONFIG_BASE {
  return { ...DESIRED_CONFIG_BASE, enforce_admins: enforceAdmins };
}

function readLiveProtection(): unknown {
  const result = Bun.spawnSync({
    cmd: ["gh", "api", `repos/${OWNER}/${REPO}/branches/${BRANCH}/protection`],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`gh api exited ${result.exitCode}: ${stderr || "(no stderr)"}`);
  }
  const stdout = new TextDecoder().decode(result.stdout);
  return JSON.parse(stdout);
}

function isLiveCompliant(
  live: unknown,
  desired: typeof DESIRED_CONFIG_BASE
): { compliant: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!live || typeof live !== "object") {
    return { compliant: false, reasons: ["live response is not an object"] };
  }
  const l = live as {
    required_status_checks?: { strict?: boolean; contexts?: string[] };
    enforce_admins?: { enabled?: boolean } | boolean;
    required_pull_request_reviews?: unknown;
  };

  // enforce_admins: drift is anything that doesn't match the chosen desired
  // value (default false; --enforce-admins flips to true). Compliance is
  // value-equality, not "true is always required."
  const liveEnforceAdmins =
    typeof l.enforce_admins === "boolean" ? l.enforce_admins : l.enforce_admins?.enabled === true;
  if (liveEnforceAdmins !== desired.enforce_admins) {
    const hint = desired.enforce_admins
      ? "mt#1938 LOAD-BEARING — pass --enforce-admins --apply to flip"
      : "run without --enforce-admins to match";
    reasons.push(
      `enforce_admins: live=${liveEnforceAdmins}, desired=${desired.enforce_admins} (${hint})`
    );
  }

  // Required status checks: contexts must include all desired.
  const liveContexts = l.required_status_checks?.contexts ?? [];
  for (const required of desired.required_status_checks.contexts) {
    if (!liveContexts.includes(required)) {
      reasons.push(`required_status_checks.contexts is missing "${required}"`);
    }
  }
  if (l.required_status_checks?.strict !== true) {
    reasons.push(
      "required_status_checks.strict: false (should be true — require branch up-to-date)"
    );
  }

  return { compliant: reasons.length === 0, reasons };
}

function applyProtection(desired: typeof DESIRED_CONFIG_BASE): void {
  // gh api PUT expects the body via stdin with `--input -`. Bun.spawnSync pipes
  // the body buffer into the child's stdin. inherit stdout/stderr so gh's
  // response prints directly to the operator's terminal.
  const body = JSON.stringify(desired);
  const result = Bun.spawnSync({
    cmd: [
      "gh",
      "api",
      "-X",
      "PUT",
      `repos/${OWNER}/${REPO}/branches/${BRANCH}/protection`,
      "--input",
      "-",
    ],
    stdin: new TextEncoder().encode(body),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`gh api PUT exited ${result.exitCode}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const check = args.includes("--check");
  const enforceAdmins = args.includes("--enforce-admins");

  if (apply && check) {
    process.stderr.write("--apply and --check are mutually exclusive\n");
    process.exit(2);
  }

  const desired = buildDesiredConfig(enforceAdmins);
  const live = readLiveProtection();
  const verdict = isLiveCompliant(live, desired);

  if (check) {
    process.stdout.write(`Live branch protection for ${OWNER}/${REPO}:${BRANCH}:\n`);
    process.stdout.write(`${JSON.stringify(live, null, 2)}\n\n`);
    if (verdict.compliant) {
      process.stdout.write("Verdict: COMPLIANT with desired config.\n");
      process.exit(0);
    } else {
      process.stdout.write("Verdict: DRIFT detected. Reasons:\n");
      for (const r of verdict.reasons) process.stdout.write(`  - ${r}\n`);
      process.exit(1);
    }
  }

  if (!apply) {
    process.stdout.write("DRY RUN — no changes will be applied. Pass --apply to execute.\n");
    if (!enforceAdmins) {
      process.stdout.write(
        "NOTE: enforce_admins is intentionally FALSE in default desired config. " +
          "Pass --enforce-admins to opt in (mt#1938 LOAD-BEARING — operator-decided).\n"
      );
    }
    process.stdout.write("\nDesired config:\n");
    process.stdout.write(`${JSON.stringify(desired, null, 2)}\n\n`);
    if (verdict.compliant) {
      process.stdout.write("Live state is already COMPLIANT — no PUT needed.\n");
    } else {
      process.stdout.write("Live state has DRIFT from desired:\n");
      for (const r of verdict.reasons) process.stdout.write(`  - ${r}\n`);
      process.stdout.write("\nRun with --apply to write the desired config.\n");
    }
    return;
  }

  // --apply path
  process.stdout.write(`Applying branch protection to ${OWNER}/${REPO}:${BRANCH} ...\n`);
  if (enforceAdmins) {
    process.stdout.write(
      "WARNING: --enforce-admins is set. Admin-authenticated `gh api PUT /merge` " +
        "calls will be subject to required-status-checks after this writes. " +
        "Reverse with `bun scripts/set-branch-protection.ts --apply` (without the flag).\n"
    );
  }
  applyProtection(desired);
  process.stdout.write("\nVerifying post-apply state ...\n");
  const live2 = readLiveProtection();
  const verdict2 = isLiveCompliant(live2, desired);
  if (verdict2.compliant) {
    process.stdout.write("SUCCESS — branch protection now matches desired config.\n");
    process.exit(0);
  } else {
    process.stderr.write("APPLIED but post-verify FAILED. Reasons:\n");
    for (const r of verdict2.reasons) process.stderr.write(`  - ${r}\n`);
    process.exit(1);
  }
}

main();
