/**
 * Workflow-paths drift test (mt#3523).
 *
 * Parses the LIVE `on.push.paths` blocks of `.github/workflows/deploy-minsky-mcp.yml`
 * and `.github/workflows/deploy-reviewer.yml` — the in-repo trigger authority
 * for what actually deploys `minsky-mcp` and `reviewer` on merge to main —
 * and fails if `DEPLOY_SURFACE_PATTERNS` / `DEPLOY_SURFACE_SERVICE_MAP`
 * (./deploy-surface.ts) no longer recognise every one of those paths as a
 * deploy surface mapped to the right service(s).
 *
 * Deliberately NOT a hardcoded duplicate of the workflows' path lists —
 * that would just be a second hand-maintained list drifting against the
 * first, the exact failure class this task exists to close (mt#3523
 * planning audit, premise (iv): mt#3023 and mt#3523 are the SAME class of
 * gap, twice). This reads the workflow files directly via the `yaml`
 * package (an existing project dependency) at test-run time, so a future
 * edit to either workflow's `paths:` block is caught automatically, with no
 * companion edit required here.
 *
 * No carve-outs remain: the root `src/**` exception that reserved the
 * mapping decision for mt#4013 was removed when that decision landed
 * (keep the trigger; map `/^src\//` to minsky-mcp — see
 * `DEPLOY_SURFACE_SERVICE_MAP`'s doc comment in ./deploy-surface.ts).
 * `KNOWN_DIVERGENCES` below stays as the named-allowlist mechanism for
 * any future documented exception.
 *
 * Negative-control observation (this task's spec item 3): before shipping,
 * a path was temporarily added to one workflow's `paths:` list, this test
 * was confirmed to go RED, then the addition was reverted and the test
 * confirmed GREEN again. See the mt#3523 PR body's `Execution evidence:`
 * block for the transcript.
 */

import { describe, test, expect } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the committed workflow files to assert DEPLOY_SURFACE_PATTERNS tracks their actual trigger paths; the workflows' content IS the thing under test (mt#3523)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isDeploySurfaceFile, findAffectedServices } from "./deploy-surface";
import { listServicesWithDeployConfig } from "./service-resolver";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

interface WorkflowTarget {
  readonly workflowPath: string;
  readonly service: string;
}

const WORKFLOWS: readonly WorkflowTarget[] = [
  { workflowPath: ".github/workflows/deploy-minsky-mcp.yml", service: "minsky-mcp" },
  { workflowPath: ".github/workflows/deploy-reviewer.yml", service: "reviewer" },
];

/**
 * Documented, tracked carve-outs: a `"<workflowPath>::<literal path glob>"`
 * pair that this drift test deliberately does NOT check. See
 * ./deploy-surface.ts's `DEPLOY_SURFACE_SERVICE_MAP` doc comment for the
 * full rationale. Any OTHER divergence between the two workflow files and
 * `DEPLOY_SURFACE_PATTERNS` still fails this test — this is a named
 * allowlist of exactly one entry, not a blanket skip.
 */
const KNOWN_DIVERGENCES: ReadonlySet<string> = new Set<string>();

function readWorkflowPushPaths(workflowPath: string): string[] {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the committed workflow file to assert DEPLOY_SURFACE_PATTERNS tracks its actual trigger paths; the workflow's content IS the thing under test (mt#3523)
  const raw = readFileSync(join(REPO_ROOT, workflowPath), "utf8");
  const doc = parseYaml(raw) as { on?: { push?: { paths?: string[] } } };
  const paths = doc.on?.push?.paths;
  if (!paths || paths.length === 0) {
    throw new Error(
      `${workflowPath}: on.push.paths is empty or missing — this drift test has nothing to ` +
        `compare against. Either the workflow lost its paths: filter (a real regression) or ` +
        `this test's YAML-parse assumptions broke.`
    );
  }
  return paths;
}

/**
 * A GitHub Actions path glob -> a concrete example repo-relative path that
 * glob matches. Only the two glob shapes actually used by these two
 * workflows are supported; an unrecognised shape throws rather than
 * silently generating a wrong (and therefore falsely-passing) example.
 */
function globToExamplePath(glob: string): string {
  if (glob.endsWith("/**")) {
    return `${glob.slice(0, -3)}/__drift-example__.ts`;
  }
  if (/[*?[\]]/.test(glob)) {
    throw new Error(
      `Unsupported path-glob shape in a deploy workflow's paths: block: "${glob}". Extend ` +
        `globToExamplePath in deploy-surface-workflow-drift.test.ts to handle it.`
    );
  }
  return glob;
}

describe("deploy-surface workflow-paths drift (mt#3523)", () => {
  const availableServices = listServicesWithDeployConfig(REPO_ROOT);

  for (const { workflowPath, service } of WORKFLOWS) {
    describe(workflowPath, () => {
      const paths = readWorkflowPushPaths(workflowPath);

      test("every on.push.paths entry is classified as a deploy surface mapped to its service", () => {
        const unmatched: string[] = [];
        const misrouted: string[] = [];

        for (const glob of paths) {
          if (KNOWN_DIVERGENCES.has(`${workflowPath}::${glob}`)) continue;

          const examplePath = globToExamplePath(glob);

          if (!isDeploySurfaceFile(examplePath)) {
            unmatched.push(glob);
            continue;
          }

          const { services } = findAffectedServices([examplePath], availableServices);
          if (!services.includes(service)) {
            misrouted.push(
              `${glob} -> got [${services.join(", ")}], expected to include "${service}"`
            );
          }
        }

        expect(unmatched).toEqual([]);
        expect(misrouted).toEqual([]);
      });
    });
  }

  test("every KNOWN_DIVERGENCES entry still names a real, currently-present workflow path (no stale carve-outs)", () => {
    for (const key of KNOWN_DIVERGENCES) {
      const [workflowPath, glob] = key.split("::");
      const paths = readWorkflowPushPaths(workflowPath as string);
      expect(paths).toContain(glob);
    }
  });

  // Sentinel (PR #2892 R1 BLOCKING 3): a carve-out can go stale in TWO
  // directions — the path could be REMOVED from the workflow (caught by
  // the test above) or DEPLOY_SURFACE_PATTERNS could gain coverage for it
  // (e.g. mt#4013 resolves in favor of keeping root src/** as a trigger)
  // WITHOUT the carve-out being removed here, silently skipping a check
  // that would now pass anyway. This test fails the moment that happens,
  // forcing KNOWN_DIVERGENCES (and deploy-surface.ts's matching doc
  // comment) to be updated rather than left stale indefinitely.
  test("every KNOWN_DIVERGENCES entry is NOT already covered by DEPLOY_SURFACE_PATTERNS (remove the carve-out once coverage lands)", () => {
    for (const key of KNOWN_DIVERGENCES) {
      const glob = key.split("::")[1] as string;
      const examplePath = globToExamplePath(glob);
      expect(isDeploySurfaceFile(examplePath)).toBe(false);
    }
  });
});

describe("globToExamplePath (mt#3523)", () => {
  // PR #2892 R1 BLOCKING 1: proves the "fail with an actionable message"
  // behavior directly, rather than leaving it as an untested code path. An
  // unrecognised glob shape in a future workflow edit must be loud, not
  // silently mapped to a wrong (and therefore falsely-passing) example.
  test("throws an actionable error for a glob shape neither `/**` nor a bare literal supports", () => {
    expect(() => globToExamplePath("packages/*/package.json")).toThrow(
      /Unsupported path-glob shape/
    );
    expect(() => globToExamplePath("services/reviewer/**/*.ts")).toThrow(
      /Unsupported path-glob shape/
    );
  });

  test("handles the two glob shapes actually used by the two live workflows", () => {
    expect(globToExamplePath("packages/domain/src/**")).toBe(
      "packages/domain/src/__drift-example__.ts"
    );
    expect(globToExamplePath("package.json")).toBe("package.json");
  });
});
