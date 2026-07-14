/**
 * Regression tests for mt#2323 — forge.* MCP tools threw
 * "Session provider unavailable: no persistence dependency provided" because
 * `resolveForgeBackend()` called a bare `createSessionProvider()` (no deps).
 *
 * The fix resolves the persistence provider from the per-call execution context
 * (`ctx.container`) — the same container-free pattern the principal-corpus
 * command group uses — instead of the bare call. These tests exercise
 * `resolveForgePersistence`, where that resolution decision now lives:
 *
 *   1. With a container that has "persistence", it returns the provider and does
 *      NOT throw the "no persistence dependency" error (the regression).
 *   2. With no container (or a container lacking "persistence"), it throws a
 *      typed forge error — proving the resolution comes from the container, not
 *      the bare `createSessionProvider()` path.
 *
 * Reference: mt#2323 spec; src/adapters/shared/commands/forge.ts.
 */

import { describe, expect, test } from "bun:test";

import { resolveForgePersistence } from "./forge";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { CommandExecutionContext } from "../command-registry";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import { MinskyError } from "@minsky/domain/errors/index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A sentinel standing in for a resolved PersistenceProvider. */
const FAKE_PERSISTENCE = { __brand: "fake-persistence" } as unknown as PersistenceProvider;

/**
 * Build a fake DI container exposing only the `has`/`get` surface
 * `resolveForgePersistence` touches. `hasPersistence: false` models the
 * pre-initialization / missing-registration case.
 */
function fakeContainer(hasPersistence: boolean): AppContainerInterface {
  return {
    has: (key: string) => key === "persistence" && hasPersistence,
    get: (key: string) => {
      if (key === "persistence" && hasPersistence) return FAKE_PERSISTENCE;
      throw new Error(`unexpected container.get(${key})`);
    },
  } as unknown as AppContainerInterface;
}

function ctxWith(
  container: AppContainerInterface | undefined,
  iface: "mcp" | "cli" = "mcp"
): CommandExecutionContext {
  return { interface: iface, format: "json", container } as CommandExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveForgePersistence (mt#2323)", () => {
  test("returns the container-provided persistence without throwing", () => {
    const ctx = ctxWith(fakeContainer(true));
    const persistence = resolveForgePersistence(ctx);
    expect(persistence).toBe(FAKE_PERSISTENCE);
  });

  test("does NOT surface the bare 'no persistence dependency' error", () => {
    const ctx = ctxWith(fakeContainer(true));
    // The pre-fix bug raised this exact phrase from createSessionProvider().
    expect(() => resolveForgePersistence(ctx)).not.toThrow();
  });

  // Resolution is interface-agnostic: ctx.container carries persistence on BOTH
  // the MCP bridge (shared-command-integration sets container: config.container)
  // and the CLI bridge (cli.ts setContainer + container.initialize()). This
  // asserts the CLI path resolves identically — no MCP-only assumption, and no
  // silent CLI regression (forge threw on CLI before the fix too).
  test("resolves identically on the CLI interface", () => {
    const ctx = ctxWith(fakeContainer(true), "cli");
    expect(resolveForgePersistence(ctx)).toBe(FAKE_PERSISTENCE);
  });

  test("throws a typed forge error when the container is absent", () => {
    const ctx = ctxWith(undefined);
    expect(() => resolveForgePersistence(ctx)).toThrow(MinskyError);
    expect(() => resolveForgePersistence(ctx)).toThrow(/persistence provider not available/i);
  });

  test("throws a typed forge error when the container lacks persistence", () => {
    const ctx = ctxWith(fakeContainer(false));
    expect(() => resolveForgePersistence(ctx)).toThrow(/persistence provider not available/i);
  });
});

// ---------------------------------------------------------------------------
// forge.ci_run_rerun registry registration (mt#2775)
// ---------------------------------------------------------------------------

describe("forge.ci_run_rerun registration", () => {
  test("is registered in the shared command registry under the FORGE category", () => {
    const command = sharedCommandRegistry.getCommand("forge.ci_run_rerun");
    expect(command).toBeDefined();
    expect(command?.category).toBe(CommandCategory.FORGE);
    expect(command?.name).toBe("ci_run_rerun");
  });

  test("declares a required numeric runId parameter and an optional fullRerun boolean", () => {
    const command = sharedCommandRegistry.getCommand("forge.ci_run_rerun");
    expect(command?.parameters.runId?.required).toBe(true);
    expect(command?.parameters.runId?.schema.safeParse(123).success).toBe(true);
    expect(command?.parameters.runId?.schema.safeParse(-1).success).toBe(false);
    expect(command?.parameters.runId?.schema.safeParse("not-a-number").success).toBe(false);

    expect(command?.parameters.fullRerun?.required).toBe(false);
    expect(command?.parameters.fullRerun?.schema.safeParse(true).success).toBe(true);
    expect(command?.parameters.fullRerun?.schema.safeParse(undefined).success).toBe(true);
  });

  // execute() is a thin delegation to `backend.workflowRuns.rerun(runId, { fullRerun })`;
  // resolveForgeBackend() is not exported (same as every other forge.* command), so the
  // request-shape / happy-path / structured-error behavior this delegates to is covered
  // directly against the Octokit layer in github-workflow-runs.test.ts's
  // `describe("rerunWorkflowRun (mt#2775)", ...)` block.
});
