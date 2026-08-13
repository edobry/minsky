import { describe, test, expect } from "bun:test";
import {
  isDeploySurfaceFile,
  isLocalAppDeploySurfaceFile,
  extractServiceFromPath,
  findAffectedServices,
} from "./deploy-surface";

// Reused fixture paths extracted to constants (custom/no-magic-string-duplication).
const REVIEWER_DOCKERFILE = "services/reviewer/Dockerfile";
const ROOT_DOCKERFILE = "Dockerfile";
const DEPLOY_WORKFLOW = ".github/workflows/deploy.yml";
const NON_SURFACE_DOC = "docs/architecture.md";

describe("isDeploySurfaceFile", () => {
  test("matches infra tree files", () => {
    expect(isDeploySurfaceFile("infra/index.ts")).toBe(true);
    expect(isDeploySurfaceFile("infra/nested/module.ts")).toBe(true);
  });

  test("matches per-service Dockerfile / railway.json / deploy.config.ts / railway.config.ts", () => {
    expect(isDeploySurfaceFile(REVIEWER_DOCKERFILE)).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/railway.json")).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/deploy.config.ts")).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/railway.config.ts")).toBe(true);
  });

  test("mt#3023: matches the ROOT Dockerfile — the minsky-mcp image", () => {
    // The per-service pattern is anchored to `services/<name>/`, so before
    // mt#3023 the root Dockerfile — the file that defines the deployed MCP
    // image — matched nothing and skipped the deploy-verification gate.
    expect(isDeploySurfaceFile(ROOT_DOCKERFILE)).toBe(true);
    expect(isDeploySurfaceFile("./Dockerfile")).toBe(true);
  });

  test("mt#3023: the root-Dockerfile pattern is anchored, not a suffix match", () => {
    expect(isDeploySurfaceFile("cockpit-tray/Dockerfile")).toBe(false);
    expect(isDeploySurfaceFile("docs/examples/Dockerfile")).toBe(false);
    expect(isDeploySurfaceFile("Dockerfile.dev")).toBe(false);
  });

  test("matches deploy workflow files (bare and per-service)", () => {
    expect(isDeploySurfaceFile(DEPLOY_WORKFLOW)).toBe(true);
    expect(isDeploySurfaceFile(".github/workflows/deploy-reviewer.yaml")).toBe(true);
  });

  test("does not match a non-deploy-surface file", () => {
    // Root src/** IS a surface as of mt#4013 (bundled into the minsky-mcp
    // image), so the negative examples here are paths genuinely outside
    // every deploy workflow's paths: block.
    expect(isDeploySurfaceFile("scripts/run-tests-main.ts")).toBe(false);
    expect(isDeploySurfaceFile(NON_SURFACE_DOC)).toBe(false);
    expect(isDeploySurfaceFile("README.md")).toBe(false);
  });

  test("normalises backslashes and a leading ./", () => {
    expect(isDeploySurfaceFile("./infra/index.ts")).toBe(true);
    expect(isDeploySurfaceFile("infra\\index.ts")).toBe(true);
  });

  test("mt#2809: tolerates null/undefined filename without throwing (trust-boundary guard)", () => {
    // Reproduces the actual runtime shape: `gh api .../files --jq` projects
    // `previous_filename` on every file entry, and jq returns `null` (not
    // "field omitted") for a missing key — so JSON.parse'd PrFile entries
    // carry a real `null`, not `undefined`, for non-renamed files.
    expect(() => isDeploySurfaceFile(null)).not.toThrow();
    expect(() => isDeploySurfaceFile(undefined)).not.toThrow();
    expect(isDeploySurfaceFile(null)).toBe(false);
    expect(isDeploySurfaceFile(undefined)).toBe(false);
  });
});

describe("isLocalAppDeploySurfaceFile (mt#2976)", () => {
  test("matches cockpit-tray binary source (src, Cargo.toml, tauri.conf.json)", () => {
    expect(isLocalAppDeploySurfaceFile("cockpit-tray/src-tauri/src/menu.rs")).toBe(true);
    expect(isLocalAppDeploySurfaceFile("cockpit-tray/src-tauri/Cargo.toml")).toBe(true);
    expect(isLocalAppDeploySurfaceFile("cockpit-tray/src-tauri/tauri.conf.json")).toBe(true);
  });

  test("does not match cockpit-web, services, or non-src-tauri tray files", () => {
    expect(isLocalAppDeploySurfaceFile("src/cockpit/web/App.tsx")).toBe(false);
    expect(isLocalAppDeploySurfaceFile("services/reviewer/Dockerfile")).toBe(false);
    expect(isLocalAppDeploySurfaceFile("cockpit-tray/README.md")).toBe(false);
    expect(isLocalAppDeploySurfaceFile("infra/index.ts")).toBe(false);
  });

  test("is disjoint from the Railway surface — a tray file is NOT a Railway deploy surface", () => {
    // Load-bearing: keeps the pre-merge gate + session.pr.drive deploy-watch
    // (both keyed on isDeploySurfaceFile) from ever treating a tray change as a
    // Railway deploy (mt#2976).
    expect(isDeploySurfaceFile("cockpit-tray/src-tauri/src/menu.rs")).toBe(false);
  });

  test("mt#2809: tolerates null/undefined without throwing", () => {
    expect(isLocalAppDeploySurfaceFile(null)).toBe(false);
    expect(isLocalAppDeploySurfaceFile(undefined)).toBe(false);
  });
});

describe("extractServiceFromPath", () => {
  test("extracts the service name from a services/<name>/... path", () => {
    expect(extractServiceFromPath(REVIEWER_DOCKERFILE)).toBe("reviewer");
    expect(extractServiceFromPath("services/cockpit/src/server.ts")).toBe("cockpit");
  });

  test("returns undefined for paths not scoped to a single service", () => {
    expect(extractServiceFromPath("infra/index.ts")).toBeUndefined();
    expect(extractServiceFromPath(DEPLOY_WORKFLOW)).toBeUndefined();
    expect(extractServiceFromPath("src/domain/session.ts")).toBeUndefined();
  });

  test("mt#2809: returns undefined (not a throw) for null/undefined", () => {
    expect(() => extractServiceFromPath(null)).not.toThrow();
    expect(extractServiceFromPath(null)).toBeUndefined();
    expect(extractServiceFromPath(undefined)).toBeUndefined();
  });
});

describe("findAffectedServices", () => {
  const available = ["reviewer", "cockpit", "site"];

  test("scopes to a single service for a services/<name>/... deploy-surface file", () => {
    const result = findAffectedServices([REVIEWER_DOCKERFILE], available);
    expect(result.services).toEqual(["reviewer"]);
    expect(result.matchedFiles).toEqual([REVIEWER_DOCKERFILE]);
  });

  test("treats infra/ changes as affecting every known service (broad impact)", () => {
    const result = findAffectedServices(["infra/index.ts"], available);
    expect(result.services).toEqual(["cockpit", "reviewer", "site"]);
  });

  test("mt#3023: treats the root Dockerfile as broad impact (not service-scoped)", () => {
    // `extractServiceFromPath` returns undefined for an unscoped path, so the
    // root Dockerfile lands on the conservative side — every known service is
    // watched rather than none.
    const result = findAffectedServices([ROOT_DOCKERFILE], available);
    expect(result.services).toEqual(["cockpit", "reviewer", "site"]);
    expect(result.matchedFiles).toEqual([ROOT_DOCKERFILE]);
  });

  test("treats a bare deploy workflow file as broad impact", () => {
    const result = findAffectedServices([DEPLOY_WORKFLOW], available);
    expect(result.services).toEqual(["cockpit", "reviewer", "site"]);
  });

  test("ignores non-deploy-surface files", () => {
    const result = findAffectedServices(["scripts/run-tests-main.ts", "README.md"], available);
    expect(result.services).toEqual([]);
    expect(result.matchedFiles).toEqual([]);
  });

  test("skips a services/<name>/... deploy file for a service with no deploy.config.ts", () => {
    const result = findAffectedServices(["services/minsky-ops/Dockerfile"], available);
    expect(result.services).toEqual([]);
    // still recorded as a matched (deploy-surface) file even though it maps
    // to no watchable service
    expect(result.matchedFiles).toEqual(["services/minsky-ops/Dockerfile"]);
  });

  test("combines scoped and broad-impact matches without duplicates", () => {
    const result = findAffectedServices([REVIEWER_DOCKERFILE, "infra/index.ts"], available);
    expect(result.services).toEqual(["cockpit", "reviewer", "site"]);
  });

  test("mixed changed-file set with no deploy-surface matches returns empty", () => {
    const result = findAffectedServices([NON_SURFACE_DOC, "README.md"], available);
    expect(result.services).toEqual([]);
    expect(result.matchedFiles).toEqual([]);
  });

  // mt#3523 previously asserted a `packages/domain/src/**` file matched
  // NOTHING here — that was the exact bug this task fixes. See the
  // "mt#3523 widened surface" describe block below for the corrected
  // (non-empty, minsky-mcp + reviewer) expectation.
});

// ---------------------------------------------------------------------------
// mt#3523 widened surface — application source + manifests, per the
// deploy-minsky-mcp.yml / deploy-reviewer.yml `paths:` blocks.
// ---------------------------------------------------------------------------

describe("mt#3523 widened surface", () => {
  // Includes "minsky-mcp" (services/minsky-mcp/deploy.config.ts exists in
  // this repo — it's the GHCR-image-based Railway service built from the
  // ROOT Dockerfile, not services/minsky-mcp/Dockerfile) in addition to the
  // `available` fixture above, which predates this task and omits it.
  const availableAll = ["cockpit", "minsky-ops", "minsky-mcp", "reviewer", "site"];
  const REVIEWER_PACKAGE_JSON = "services/reviewer/package.json";

  // --- AT1: packages/domain/src/** -> exactly {minsky-mcp, reviewer} ---
  test("AT1: isDeploySurfaceFile is true for packages/domain/src/**", () => {
    expect(isDeploySurfaceFile("packages/domain/src/transcripts/turns.ts")).toBe(true);
  });

  test("AT1: findAffectedServices for only packages/domain/src/** yields exactly {minsky-mcp, reviewer}", () => {
    const result = findAffectedServices(
      ["packages/domain/src/session/commands/pr-subcommands.ts"],
      availableAll
    );
    expect(result.services).toEqual(["minsky-mcp", "reviewer"]);
    expect(result.matchedFiles).toEqual(["packages/domain/src/session/commands/pr-subcommands.ts"]);
  });

  // --- AT2: PR #2865 reproduction ---
  test("AT2: PR #2865 shape (packages/domain/src/transcripts/** + tests) is a deploy surface for {minsky-mcp, reviewer}", () => {
    const files = [
      "packages/domain/src/transcripts/turns.ts",
      "packages/domain/src/transcripts/turns.test.ts",
      "packages/domain/src/transcripts/index.ts",
    ];
    const result = findAffectedServices(files, availableAll);
    expect(result.services).toEqual(["minsky-mcp", "reviewer"]);
    expect(result.matchedFiles).toEqual(files);
  });

  // --- AT3 (revised by mt#4013): src/cockpit/web/** IS a surface, but for
  // minsky-mcp (bundled input of that image), never for the cockpit service.
  // The original ask#7028 cockpit-inversion claim — the COCKPIT service is
  // not a merge-deploy target — still holds and is what the service
  // assertion below pins; the isDeploySurfaceFile half flipped when root
  // src/** joined the map (it was already a live workflow trigger).
  test("AT3: src/cockpit/web/** is a minsky-mcp surface (bundled input), never a cockpit one; docs/** stays out", () => {
    const cockpitWebFiles = ["src/cockpit/web/App.tsx", "src/cockpit/web/components/Widget.tsx"];
    for (const file of cockpitWebFiles) {
      expect(isDeploySurfaceFile(file)).toBe(true);
    }
    expect(isDeploySurfaceFile("docs/cockpit-ui.md")).toBe(false);
    const result = findAffectedServices([...cockpitWebFiles, "docs/cockpit-ui.md"], availableAll);
    expect(result.services).toEqual(["minsky-mcp"]);
    expect(result.services).not.toContain("cockpit");
    expect(result.matchedFiles).toEqual(cockpitWebFiles);
  });

  // --- AT4: docs-only PR is still NOT a deploy surface ---
  test("AT4: a docs-only changed-file set is NOT a deploy surface", () => {
    const files = [NON_SURFACE_DOC, "docs/testing-patterns.md", "README.md"];
    const result = findAffectedServices(files, availableAll);
    expect(result.services).toEqual([]);
    expect(result.matchedFiles).toEqual([]);
  });

  // --- Reviewer's own application source (services/reviewer/**) ---
  test("services/reviewer/src/** and migrations/** are deploy-surface files scoped to reviewer only", () => {
    expect(isDeploySurfaceFile("services/reviewer/src/index.ts")).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/migrations/pg/0001_init.sql")).toBe(true);
    const result = findAffectedServices(
      ["services/reviewer/src/index.ts", "services/reviewer/migrations/pg/0001_init.sql"],
      availableAll
    );
    expect(result.services).toEqual(["reviewer"]);
  });

  // --- services/reviewer/package.json triggers BOTH services ---
  // PR #2892 R1 BLOCKING 2: services/reviewer/package.json matches TWO
  // DEPLOY_SURFACE_SERVICE_MAP entries -- the specific
  // /^services\/reviewer\/package\.json$/ -> [minsky-mcp, reviewer] AND the
  // broad /^services\/reviewer\// -> [reviewer]. These tests prove the
  // overlap is safe by construction (Set-based union + per-service
  // availableServices gating, not entry ORDER or de-duplication) rather
  // than asserting it once and hoping availableServices never changes.
  test("services/reviewer/package.json affects both minsky-mcp and reviewer", () => {
    const result = findAffectedServices([REVIEWER_PACKAGE_JSON], availableAll);
    expect(result.services).toEqual(["minsky-mcp", "reviewer"]);
  });

  test("services/reviewer/package.json invariant: overlapping map entries union correctly under varying availableServices", () => {
    // minsky-mcp NOT available -> only reviewer (from either matching entry).
    expect(
      findAffectedServices([REVIEWER_PACKAGE_JSON], ["reviewer", "cockpit", "site"]).services
    ).toEqual(["reviewer"]);

    // reviewer NOT available -> only minsky-mcp (from the specific entry only;
    // the broad entry contributes nothing extra since it only lists "reviewer").
    expect(
      findAffectedServices([REVIEWER_PACKAGE_JSON], ["minsky-mcp", "cockpit", "site"]).services
    ).toEqual(["minsky-mcp"]);

    // Neither available -> empty, not a crash or a phantom entry.
    expect(findAffectedServices([REVIEWER_PACKAGE_JSON], ["cockpit", "site"]).services).toEqual([]);
  });

  // --- minsky-mcp-only manifests ---
  // PR #2892 R1 BLOCKING 4: named individually (not just covered implicitly
  // by the workflow-drift test's generic loop) so a reader can see each
  // manifest's expected service without cross-referencing the workflow file.
  test("minsky-mcp-only manifest: .dockerignore (deploy-minsky-mcp.yml paths:)", () => {
    expect(findAffectedServices([".dockerignore"], availableAll).services).toEqual(["minsky-mcp"]);
  });

  test("minsky-mcp-only manifest: .minsky/config.yaml (deploy-minsky-mcp.yml paths:)", () => {
    expect(findAffectedServices([".minsky/config.yaml"], availableAll).services).toEqual([
      "minsky-mcp",
    ]);
  });

  // --- reviewer-only manifest ---
  test("reviewer-only manifest: bunfig.toml (deploy-reviewer.yml paths:)", () => {
    expect(findAffectedServices(["bunfig.toml"], availableAll).services).toEqual(["reviewer"]);
  });

  // --- shared manifests affect both ---
  test("root package.json / bun.lock / tsconfig.json affect both minsky-mcp and reviewer", () => {
    for (const file of ["package.json", "bun.lock", "tsconfig.json"]) {
      expect(findAffectedServices([file], availableAll).services).toEqual([
        "minsky-mcp",
        "reviewer",
      ]);
    }
  });

  // --- root src/** -> minsky-mcp (mt#4013: trigger kept, map aligned) ---
  test("root src/** is a minsky-mcp deploy surface (mt#4013 decision)", () => {
    // Root src is COPYed wholesale into the minsky-mcp image
    // (Dockerfile `COPY src ./src`), and deploy-minsky-mcp.yml has carried
    // "src/**" in its paths: block since 2026-06-12. mt#4013 decided the
    // trigger stays and the map matches it — see the
    // DEPLOY_SURFACE_SERVICE_MAP doc comment in deploy-surface.ts.
    expect(isDeploySurfaceFile("src/mcp/tools/example.ts")).toBe(true);
    expect(isDeploySurfaceFile("src/domain/session/session.ts")).toBe(true);
    const result = findAffectedServices(["src/mcp/tools/example.ts"], availableAll);
    expect(result.services).toEqual(["minsky-mcp"]);
  });
});
