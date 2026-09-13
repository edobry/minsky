/**
 * Computed autonomy class (mt#5130) — the pure classifier.
 *
 * Fixture-shaped per the task's acceptance tests: AT2 (a listed surface gates
 * even with a reproducing test and human origin), AT3 (every contained signal
 * but no human origin → pull-only), AT5 (missing spec row → unknown), and the
 * umbrella / rfc-tag / plain-TODO trio. The surface list and the marker set
 * are pinned so a change to either is a deliberate diff here.
 */

import { describe, test, expect } from "bun:test";
import {
  AUTONOMY_LISTED_SURFACE_PATTERNS,
  PRINCIPAL_GATED_TAGS,
  PRINCIPAL_RESERVED_MARKERS,
  computeAutonomyClass,
  extractScopePaths,
  isListedSurface,
  isServableClass,
  type AutonomyInput,
} from "./autonomy-class";

function input(overrides: Partial<AutonomyInput> = {}): AutonomyInput {
  return {
    id: "mt#1",
    kind: "implementation",
    status: "TODO",
    tags: [],
    title: "Fix the widget",
    spec: { scope: null, summary: null, origin: null },
    humanOrigin: undefined,
    ...overrides,
  };
}

/** Every `contained` conjunct satisfied — the fixture AT2/AT3 vary one signal of. */
function containedFixture(overrides: Partial<AutonomyInput> = {}): AutonomyInput {
  return input({
    status: "READY",
    humanOrigin: true,
    spec: {
      scope:
        "In scope: `packages/domain/src/tasks/widget.ts` and its test.\n\nOut of scope: everything else.",
      summary: "The widget drops the last item. A reproducing test is at widget.test.ts.",
      origin: null,
    },
    ...overrides,
  });
}

describe("computeAutonomyClass — principal-gated dominates", () => {
  test("AT2: a scope naming a listed deploy surface is principal-gated even with a reproducing test, READY and human origin", () => {
    const r = computeAutonomyClass(
      containedFixture({
        spec: {
          scope: "In scope: `services/reviewer/Dockerfile` and `services/reviewer/src/x.ts`.",
          summary: "A reproducing test is attached.",
          origin: null,
        },
      })
    );
    expect(r.class).toBe("principal-gated");
    expect(r.reasons).toContain("scope names listed surface services/reviewer/Dockerfile");
  });

  test("a scope naming a hook, a migration or persistence is gated the same way", () => {
    for (const p of [
      ".minsky/hooks/check-task-spec-read.ts",
      ".claude/hooks/x.ts",
      "packages/domain/src/storage/migrations/pg/0119_x.sql",
      "packages/domain/src/persistence/provider.ts",
      ".github/workflows/ci.yml",
      "infra/index.ts",
      "cockpit-tray/src-tauri/src/main.rs",
    ]) {
      const r = computeAutonomyClass(
        containedFixture({ spec: { scope: `Touches ${p}.`, summary: "", origin: null } })
      );
      expect(r.class).toBe("principal-gated");
    }
  });

  test("ordinary application source is NOT a listed surface — the deploy predicate's `^src/` is deliberately not used", () => {
    expect(isListedSurface("src/adapters/shared/commands/tasks/routing-commands.ts")).toBe(false);
    expect(isListedSurface("packages/domain/src/tasks/task-routing-service.ts")).toBe(false);
    expect(isListedSurface("packages/shared/src/logger.ts")).toBe(false);
    expect(isListedSurface("services/reviewer/src/prompt.ts")).toBe(false);
  });

  test("umbrella kind, state-ops kind, an rfc tag, and an RFC: title each resolve principal-gated", () => {
    expect(computeAutonomyClass(input({ kind: "umbrella" })).class).toBe("principal-gated");
    expect(computeAutonomyClass(input({ kind: "state-ops" })).class).toBe("principal-gated");
    expect(computeAutonomyClass(input({ tags: ["rfc"] })).class).toBe("principal-gated");
    expect(
      computeAutonomyClass(input({ title: "RFC: should agents have a sense of time" })).class
    ).toBe("principal-gated");
    expect(computeAutonomyClass(input({ title: "ADR-046 adoption" })).class).toBe(
      "principal-gated"
    );
  });

  test("the engprod-proposal tag gates whatever the status — this is the BLOCKED hack's replacement", () => {
    for (const status of ["TODO", "BLOCKED", "READY", "IN-PROGRESS"]) {
      const r = computeAutonomyClass(input({ status, tags: ["engprod-proposal"] }));
      expect(r.class).toBe("principal-gated");
      expect(r.reasons).toContain("tag engprod-proposal");
    }
  });

  test("a principal-reserved marker in the title or Summary gates; incidental prose does not", () => {
    expect(computeAutonomyClass(input({ title: "Rename the Attention surface" })).class).toBe(
      "principal-gated"
    );
    expect(
      computeAutonomyClass(
        input({ spec: { scope: null, summary: "Pick a vendor for hosting.", origin: null } })
      ).reasons
    ).toContain('principal-reserved marker "vendor"');
    // `renamed`, `vendored`, `architecture`, `production` are not in the set.
    expect(
      computeAutonomyClass(
        input({
          title: "The renamed helper is vendored under the clean architecture tree",
          spec: { scope: null, summary: "Production logs show the crash.", origin: null },
        })
      ).class
    ).toBe("pull-only");
  });

  test("a work package is pull-only with ADR-046 as its reason", () => {
    const r = computeAutonomyClass(input({ kind: "work-package", status: "READY" }));
    expect(r).toEqual({ class: "pull-only", reasons: ["ADR-046: claimed deliberately"] });
  });
});

describe("computeAutonomyClass — contained needs every conjunct", () => {
  test("AT3: every contained signal but no human-origin evidence → pull-only, naming the missing signal", () => {
    const r = computeAutonomyClass(containedFixture({ humanOrigin: undefined }));
    expect(r.class).toBe("pull-only");
    expect(r.reasons).toContain("no human-origin evidence");
    expect(computeAutonomyClass(containedFixture({ humanOrigin: false })).class).toBe("pull-only");
  });

  test("with human origin, READY, a reproducing test and no listed surface → contained", () => {
    const r = computeAutonomyClass(containedFixture());
    expect(r.class).toBe("contained");
    expect(r.reasons).toContain("bugfix with a reproducing test named in the spec");
  });

  test("not READY → pull-only even with every other signal", () => {
    const r = computeAutonomyClass(containedFixture({ status: "TODO" }));
    expect(r.class).toBe("pull-only");
    expect(r.reasons).toContain("status TODO is not READY");
  });

  test("the other contained shapes: incident lineage, cleared-blocker, docs-only", () => {
    const base = containedFixture({
      spec: { scope: "In scope: `docs/foo.md`.", summary: "No test here.", origin: null },
    });
    expect(computeAutonomyClass(base).reasons).toContain("docs-only or generated-only scope");
    expect(computeAutonomyClass({ ...base, tags: ["incident"] }).reasons).toContain(
      "incident follow-up"
    );
    expect(
      computeAutonomyClass({
        ...base,
        spec: {
          scope: "In scope: `docs/foo.md`.",
          summary: "No test here.",
          origin: "Origin: incident 2026-09-01 outage",
        },
      }).reasons
    ).toContain("incident follow-up");
    expect(computeAutonomyClass({ ...base, tags: ["cleared-blocker"] }).reasons).toContain(
      "cleared-blocker re-surface"
    );
  });

  test("a plain TODO implementation task with no signals is pull-only", () => {
    const r = computeAutonomyClass(input());
    expect(r.class).toBe("pull-only");
    expect(isServableClass(r.class)).toBe(true);
  });
});

describe("computeAutonomyClass — unknown only when inputs are unavailable", () => {
  test("AT5: no spec signals loaded → unknown, and unknown is never servable", () => {
    const r = computeAutonomyClass(input({ spec: undefined }));
    expect(r).toEqual({ class: "unknown", reasons: ["spec signals unavailable"] });
    expect(isServableClass("unknown")).toBe(false);
    expect(isServableClass("principal-gated")).toBe(false);
  });

  test("row signals still gate without a spec — unknown never hides a principal-gated task", () => {
    expect(computeAutonomyClass(input({ spec: undefined, kind: "umbrella" })).class).toBe(
      "principal-gated"
    );
    expect(computeAutonomyClass(input({ spec: undefined, title: "RFC: x" })).class).toBe(
      "principal-gated"
    );
  });

  test("a spec with no Scope/Summary section is a well-formed input, not unknown", () => {
    expect(computeAutonomyClass(input()).class).toBe("pull-only");
  });
});

describe("extractScopePaths", () => {
  test("reads bullet lists and backticked prose alike, stripping line refs and punctuation", () => {
    const paths = extractScopePaths(
      [
        "In scope:",
        "- `packages/domain/src/tasks/autonomy-class.ts:42` (new),",
        "- src/adapters/shared/commands/tasks/routing-commands.ts.",
        "Also docs/standing-pointings.md and the file `README.md`; see https://github.com/edobry/minsky/pull/1.",
      ].join("\n")
    );
    expect(paths).toContain("packages/domain/src/tasks/autonomy-class.ts");
    expect(paths).toContain("src/adapters/shared/commands/tasks/routing-commands.ts");
    expect(paths).toContain("docs/standing-pointings.md");
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.includes("github.com"))).toBe(false);
  });

  test("prose without paths yields nothing; `e.g.` and version numbers are not files", () => {
    expect(extractScopePaths("Out of scope: everything else, e.g. v1.2.3 of the thing.")).toEqual(
      []
    );
    expect(extractScopePaths(null)).toEqual([]);
  });
});

describe("pinned lists", () => {
  test("the listed surface = deploy boundaries + local app + security surfaces, nothing wholesale", () => {
    const sources = AUTONOMY_LISTED_SURFACE_PATTERNS.map((re) => re.source);
    expect(sources).toContain("^infra\\/");
    expect(sources).toContain("^Dockerfile$");
    expect(sources).toContain("^cockpit-tray\\/src-tauri\\/");
    expect(sources).toContain("^\\.github\\/workflows\\/");
    expect(sources).toContain("^\\.minsky\\/hooks\\/");
    expect(sources).toContain("^\\.claude\\/hooks\\/");
    expect(sources).toContain("^packages\\/domain\\/src\\/persistence\\/");
    expect(sources).toContain("^packages\\/domain\\/src\\/storage\\/migrations\\/");
    expect(sources).toContain("^drizzle\\.pg\\.config\\.ts$");
    expect(sources).toContain("^packages\\/domain\\/src\\/auth\\/");
    expect(sources).not.toContain("^src\\/");
    expect(sources).not.toContain("^packages\\/domain\\/src\\/");
  });

  test("the gating tags and the marker set are the measured, narrow ones", () => {
    expect([...PRINCIPAL_GATED_TAGS]).toEqual([
      "rfc",
      "adr",
      "naming",
      "product-surface",
      "vendor",
      "engprod-proposal",
    ]);
    expect([...PRINCIPAL_RESERVED_MARKERS]).toEqual([
      "rename",
      "naming",
      "product name",
      "customer-facing",
      "product surface",
      "vendor",
      "paid plan",
      "signup",
      "pricing",
    ]);
  });
});
