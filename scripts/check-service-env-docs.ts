#!/usr/bin/env bun
/**
 * Every env var a service reads must be documented in its DEPLOY.md (mt#1566).
 *
 * ## Why this exists
 *
 * mt#1558: `services/reviewer/src/db/client.ts` read a Postgres connection
 * string from an env var that `services/reviewer/DEPLOY.md` did not list. The
 * deploy followed the runbook correctly and the service crashed, because the
 * runbook was incomplete. Nothing in CI could have caught it — typecheck sees
 * the code compile, tests run against mocked env, lint sees style. Nothing
 * compares what the code READS against what the operator is TOLD.
 *
 * ## Why a literal `process.env.X` sweep is not enough
 *
 * Measured on `services/reviewer` at 2026-09-04, the three read patterns below
 * yield 28 / 25 / 13 distinct names for a union of 59. A scanner that saw only
 * the first would miss `MINSKY_REVIEWER_APP_ID`, `MINSKY_REVIEWER_PRIVATE_KEY`,
 * `MINSKY_REVIEWER_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `REVIEWER_PROVIDER`,
 * `REVIEWER_MODEL` and `PORT` — i.e. every secret a deployer must set, plus the
 * model selection. It would report them as absent from the codebase rather than
 * as undocumented, which is the silent direction.
 *
 * So all three are extracted:
 *
 *   1. `process.env.X` / `process.env["X"]`      — direct reads
 *   2. `requireEnv("X")` / `optionalEnv("X",…)`  — the config.ts helper family
 *      / `parsePositiveIntEnv("X",…)`
 *   3. `…_ENV_VARS` / `…_ENV_VAR_NAMES` consts  — exported name registries
 *
 * Pattern 3 is CONVENTION-BOUND, and that is a deliberate limit rather than an
 * oversight: a registry named outside the convention is invisible here. The
 * three that exist today all conform (`RECOVERY_FLAG_ENV_VARS`,
 * `REVIEWER_CALLTIME_ENV_VAR_NAMES`, `CONNECTION_STRING_ENV_VARS`), and the
 * convention is cheap to keep. A registry that must not follow it should be
 * added to pattern 2's helper list instead.
 *
 * ## Why the grandfather list is printed rather than silent
 *
 * 39 of the 59 were undocumented when this shipped. An exemption list that size
 * is not configuration — it is the gap the check exists to prevent, wearing the
 * check's own badge. So the list is printed on every run with its count and its
 * age, and `check-service-env-docs.test.ts` asserts it may only SHRINK. New and
 * changed vars are enforced from the first commit; the backlog is visible and
 * monotonically decreasing. Burn-down: mt#4990.
 *
 * ## Usage
 *
 *     bun scripts/check-service-env-docs.ts            # check, exit non-zero on failure
 *     bun scripts/check-service-env-docs.ts --json     # machine-readable
 *     bun scripts/check-service-env-docs.ts --list     # print the current undocumented set
 *
 * The census test runs the same functions, so CI coverage needs no workflow.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICES_DIR = join(REPO_ROOT, "services");

/** An env-var name as it appears in code: SCREAMING_SNAKE, at least 4 chars. */
const ENV_NAME = String.raw`[A-Z][A-Z0-9_]{3,}`;

/**
 * The `config.ts` helper family. A read through one of these is invisible to a
 * `process.env` sweep — the name is an ARGUMENT, not a property access. Adding a
 * new helper here is what keeps it visible.
 */
export const ENV_HELPER_NAMES = ["requireEnv", "optionalEnv", "parsePositiveIntEnv"] as const;

/**
 * Registry declarations are matched by NAME, per the convention documented
 * above: a `const` whose identifier ends in `_ENV_VARS` or `_ENV_VAR_NAMES`.
 */
const REGISTRY_DECL =
  /(?:const|let|var)\s+[A-Z][A-Z0-9_]*_ENV_VARS?(?:_NAMES)?\s*(?::[^=]+)?=\s*([[{])/g;

/** Strip comments so a name mentioned only in prose is not counted as a read. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Pattern 1 — `process.env.X` and `process.env["X"]`. */
export function extractDirectReads(code: string): string[] {
  const re = new RegExp(
    String.raw`process\.env\.(${ENV_NAME})|process\.env\[\s*["'](${ENV_NAME})["']\s*\]`,
    "g"
  );
  return [...code.matchAll(re)].map((m) => m[1] ?? m[2]).filter((n): n is string => Boolean(n));
}

/** Pattern 2 — `requireEnv("X")` and friends. */
export function extractHelperReads(code: string): string[] {
  const re = new RegExp(
    String.raw`\b(?:${ENV_HELPER_NAMES.join("|")})\(\s*["'](${ENV_NAME})["']`,
    "g"
  );
  return [...code.matchAll(re)].map((m) => m[1]).filter((n): n is string => Boolean(n));
}

/**
 * Pattern 3 — SCREAMING_SNAKE string literals inside a `*_ENV_VARS` /
 * `*_ENV_VAR_NAMES` declaration.
 *
 * Bounded by bracket depth from the declaration's opening `[`/`{`, so a literal
 * in the next declaration down is not swept in. Depth counting is why this is
 * not a single regex: a registry of tuples nests one level.
 */
export function extractRegistryNames(code: string): string[] {
  const names: string[] = [];
  for (const decl of code.matchAll(REGISTRY_DECL)) {
    if (decl.index === undefined) continue;
    const open = decl.index + decl[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < code.length; i++) {
      const ch = code[i];
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = code.slice(open, end + 1);
    const lit = new RegExp(String.raw`["'](${ENV_NAME})["']`, "g");
    for (const m of body.matchAll(lit)) if (m[1]) names.push(m[1]);
  }
  return names;
}

/** Every env-var name a source tree reads, by any of the three patterns. */
export function extractEnvNames(code: string): string[] {
  const stripped = stripComments(code);
  return [
    ...extractDirectReads(stripped),
    ...extractHelperReads(stripped),
    ...extractRegistryNames(stripped),
  ];
}

/**
 * Names that are structurally NOT operator-facing, so absence from a runbook is
 * correct rather than a gap (SC3).
 *
 * `RAILWAY_*` is injected by the platform — an operator never sets it, and
 * documenting it would tell them to. The explicit list is for reads that only
 * ever happen under a test harness. Both are exclusions rather than grandfather
 * entries because they are permanent: a grandfather entry is debt to burn down,
 * and these will never be documented.
 */
export const PLATFORM_INJECTED_PREFIXES = ["RAILWAY_"] as const;
export const NOT_OPERATOR_FACING = [
  "RUN_INTEGRATION_TESTS",
  "RUN_TESTCONTAINER_TESTS",
  "REVIEWER_EVAL_LIVE_RUN_CONFIRMED",
] as const;

export function isOperatorFacing(name: string): boolean {
  if (PLATFORM_INJECTED_PREFIXES.some((p) => name.startsWith(p))) return false;
  return !(NOT_OPERATOR_FACING as readonly string[]).includes(name);
}

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

export interface ServiceReport {
  service: string;
  hasDeployDoc: boolean;
  hasDockerfile: boolean;
  /** Every distinct name read by the service's `src/`, sorted. */
  read: string[];
  /** Read but absent from DEPLOY.md, grandfather list NOT yet applied. */
  undocumented: string[];
  /** Undocumented and NOT grandfathered — these fail the check. */
  failing: string[];
  /** Grandfathered names no longer read anywhere — the list should shrink. */
  staleGrandfathered: string[];
  /** Name -> first `src`-relative `path:line` that reads it. */
  locations: Record<string, string>;
}

/** Names exempted at ship time, with provenance. Burn-down: mt#4990. */
export interface Grandfather {
  recordedAt: string;
  burndownTask: string;
  names: Record<string, string[]>;
}

export function loadGrandfather(): Grandfather {
  const path = join(REPO_ROOT, "scripts", "service-env-docs-grandfathered.json");
  if (!existsSync(path)) return { recordedAt: "", burndownTask: "", names: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Grandfather;
}

export function auditService(service: string, grandfather: Grandfather): ServiceReport {
  const dir = join(SERVICES_DIR, service);
  const srcFiles = walkTs(join(dir, "src"));

  // Name -> first `path:line` that reads it. The location is what makes the
  // failure actionable (SC2): "X is undocumented" sends the reader hunting,
  // "X is undocumented, read at src/foo.ts:41" does not. Located on the
  // COMMENT-STRIPPED source so a prose mention cannot supply the line.
  const locations = new Map<string, string>();
  const names = new Set<string>();
  for (const file of srcFiles) {
    const stripped = stripComments(readFileSync(file, "utf8"));
    const found = extractEnvNames(stripped);
    if (found.length === 0) continue;
    const rel = file.slice(dir.length + 1);
    const lines = stripped.split("\n");
    for (const name of found) {
      names.add(name);
      if (locations.has(name)) continue;
      const idx = lines.findIndex((l) => l.includes(name));
      locations.set(name, idx >= 0 ? `${rel}:${idx + 1}` : rel);
    }
  }
  const read = [...names].filter(isOperatorFacing).sort();

  const docPath = join(dir, "DEPLOY.md");
  const hasDeployDoc = existsSync(docPath);
  const doc = hasDeployDoc ? readFileSync(docPath, "utf8") : "";

  const undocumented = read.filter((n) => !doc.includes(n));
  const exempt = new Set(grandfather.names[service] ?? []);
  // A service with NO DEPLOY.md has nothing to be missing FROM. Failing it per
  // var would report the same finding once per env var and drown the one that
  // matters — that it deploys with no runbook at all, which `main` reports
  // separately. Silence here is scoped, not general: `hasDeployDoc: false` is
  // on the report, so a caller cannot mistake this for a clean pass.
  const failing = hasDeployDoc ? undocumented.filter((n) => !exempt.has(n)) : [];
  const staleGrandfathered = [...exempt].filter((n) => !undocumented.includes(n)).sort();

  return {
    service,
    hasDeployDoc,
    hasDockerfile: existsSync(join(dir, "Dockerfile")),
    read,
    undocumented,
    failing,
    staleGrandfathered,
    locations: Object.fromEntries(locations),
  };
}

/** Services that have a `src/` tree — the population this check can speak about. */
export function listServices(): string[] {
  if (!existsSync(SERVICES_DIR)) return [];
  return readdirSync(SERVICES_DIR)
    .filter((s) => existsSync(join(SERVICES_DIR, s, "src")))
    .sort();
}

export function auditAll(grandfather = loadGrandfather()): ServiceReport[] {
  return listServices().map((s) => auditService(s, grandfather));
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const grandfather = loadGrandfather();
  const reports = auditAll(grandfather);

  if (args.has("--json")) {
    console.log(JSON.stringify({ grandfather, reports }, null, 2));
  }

  // A service with a Dockerfile deploys, so it needs a runbook. Naming it is
  // the point: a silent skip is how it would acquire the same debt invisibly.
  const deployableWithoutDoc = reports.filter((r) => r.hasDockerfile && !r.hasDeployDoc);

  const totalExempt = Object.values(grandfather.names).flat().length;
  const failures = reports.filter((r) => r.failing.length > 0);

  if (!args.has("--json")) {
    for (const r of reports.filter((r) => r.hasDeployDoc)) {
      console.log(
        `${r.service}: ${r.read.length} read, ${r.read.length - r.undocumented.length} documented, ` +
          `${r.undocumented.length} undocumented (${r.failing.length} failing, ` +
          `${r.undocumented.length - r.failing.length} grandfathered)`
      );
      if (args.has("--list")) for (const n of r.undocumented) console.log(`    ${n}`);
    }
    // Printed every run, not only on failure: an exemption nobody sees is an
    // exemption nobody removes.
    console.log(
      `\ngrandfathered: ${totalExempt} name(s), recorded ${grandfather.recordedAt || "?"}, ` +
        `burn-down ${grandfather.burndownTask || "?"}`
    );
    for (const r of deployableWithoutDoc) {
      console.log(`\nNOTE: services/${r.service} has a Dockerfile and no DEPLOY.md.`);
      console.log(
        `      Its ${r.read.length} env var(s) are unchecked — it deploys with no runbook.`
      );
    }
  }

  for (const r of reports) {
    if (r.staleGrandfathered.length > 0) {
      console.error(
        `\nservices/${r.service}: ${r.staleGrandfathered.length} grandfathered name(s) are no ` +
          `longer undocumented — remove them from the list:\n  ${r.staleGrandfathered.join("\n  ")}`
      );
    }
  }

  if (failures.length > 0) {
    console.error("\nUNDOCUMENTED ENV VARS — add them to the service's DEPLOY.md:");
    for (const r of failures) {
      for (const n of r.failing) {
        const at = r.locations[n] ?? "unknown location";
        console.error(
          `  ${n}\n      read at services/${r.service}/${at}` +
            `\n      not documented in services/${r.service}/DEPLOY.md`
        );
      }
    }
    process.exit(1);
  }

  if (!args.has("--json")) console.log("\nOK — every newly-read env var is documented.");
}

if (import.meta.main) main();
