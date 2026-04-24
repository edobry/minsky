/**
 * Tests for provenance.get shared command
 *
 * @see mt#1085 — provenance.get MCP exposure
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createSharedCommandRegistry } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import type { AppContainerInterface } from "../../../composition/types";
import type { ProvenanceRecord } from "../../../domain/provenance/types";
import { AuthorshipTier } from "../../../domain/provenance/types";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const MOCK_RECORD: ProvenanceRecord = {
  id: "prov-abc123",
  artifactId: "42",
  artifactType: "pr",
  taskId: "mt#1085",
  sessionId: "session-xyz",
  transcriptId: null,
  taskOrigin: "human",
  specAuthorship: "human",
  initiationMode: "interactive",
  humanMessages: 5,
  totalMessages: 10,
  corrections: 1,
  participants: [],
  substantiveHumanInput: null,
  trajectoryChanges: null,
  authorshipTier: AuthorshipTier.HUMAN_AUTHORED,
  tierRationale: "preliminary tier",
  policyVersion: "1.0.0",
  judgingModel: null,
  computedAt: new Date("2026-01-01"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

// ---------------------------------------------------------------------------
// Helper: build a minimal mock AppContainerInterface
// ---------------------------------------------------------------------------

function buildMockContainer(
  getProvenanceForArtifact: (
    artifactId: string,
    artifactType: string
  ) => Promise<ProvenanceRecord | null>
): AppContainerInterface {
  // Fake DB — never actually called; ProvenanceService is prototype-patched below
  const fakeDb = {} as never;

  const fakePersistenceProvider = {
    getDatabaseConnection: mock(() => Promise.resolve(fakeDb)),
  } as unknown as ReturnType<AppContainerInterface["get"]>;

  return {
    has: mock((key: string) => key === "persistence") as AppContainerInterface["has"],
    get: mock((_key: string) => fakePersistenceProvider) as AppContainerInterface["get"],
    // Stubs — the command never calls these
    register: mock(() => ({}) as AppContainerInterface),
    set: mock(() => ({}) as AppContainerInterface),
    initialize: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// Helper: get command or throw (avoids non-null assertions in every test)
// ---------------------------------------------------------------------------

function requireCommand(registry: SharedCommandRegistry, id: string) {
  const cmd = registry.getCommand(id);
  if (!cmd) throw new Error(`Command ${id} not registered`);
  return cmd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provenance.get shared command", () => {
  let registry: SharedCommandRegistry;

  beforeEach(async () => {
    registry = createSharedCommandRegistry();
    const { registerProvenanceCommands } = await import("./provenance");
    registerProvenanceCommands(undefined, registry);
  });

  afterEach(() => {
    mock.restore();
  });

  test("is registered in the command registry", () => {
    const cmd = registry.getCommand("provenance.get");
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe("get");
    expect(cmd?.category).toBeDefined();
  });

  test("returns an existing provenance record", async () => {
    const getProvenanceForArtifact = mock(() => Promise.resolve(MOCK_RECORD));

    // Patch ProvenanceService at the prototype level so the dynamic import inside
    // the command sees the mock.
    const { ProvenanceService } = await import("../../../domain/provenance/provenance-service");
    const original = ProvenanceService.prototype.getProvenanceForArtifact;
    ProvenanceService.prototype.getProvenanceForArtifact =
      getProvenanceForArtifact as typeof original;

    const container = buildMockContainer(getProvenanceForArtifact);
    const cmd = requireCommand(registry, "provenance.get");

    const result = await cmd.execute({ artifactId: "42", artifactType: "pr" }, { container });

    expect(result).toEqual(MOCK_RECORD);
    expect(getProvenanceForArtifact).toHaveBeenCalledWith("42", "pr");

    ProvenanceService.prototype.getProvenanceForArtifact = original;
  });

  test("returns null for a missing record", async () => {
    const getProvenanceForArtifact = mock(() => Promise.resolve(null));

    const { ProvenanceService } = await import("../../../domain/provenance/provenance-service");
    const original = ProvenanceService.prototype.getProvenanceForArtifact;
    ProvenanceService.prototype.getProvenanceForArtifact =
      getProvenanceForArtifact as typeof original;

    const container = buildMockContainer(getProvenanceForArtifact);
    const cmd = requireCommand(registry, "provenance.get");

    const result = await cmd.execute({ artifactId: "999", artifactType: "pr" }, { container });

    expect(result).toBeNull();

    ProvenanceService.prototype.getProvenanceForArtifact = original;
  });

  test("throws a validation error for an invalid artifactType", () => {
    const cmd = requireCommand(registry, "provenance.get");

    // artifactType must be one of the valid enum values; "unknown_type" is invalid.
    // The Zod schema validation is done by the registry bridge before execute() is
    // called in production, but we can verify the schema rejects the bad value here.
    const param = cmd.parameters["artifactType"];
    expect(param).toBeDefined();
    if (!param) return;
    const parsed = param.schema.safeParse("unknown_type");
    expect(parsed.success).toBe(false);
  });

  test("throws when persistence provider is missing from container", async () => {
    const emptyContainer: AppContainerInterface = {
      has: mock(() => false) as AppContainerInterface["has"],
      get: mock(() => {
        throw new Error("not found");
      }) as AppContainerInterface["get"],
      register: mock(() => ({}) as AppContainerInterface),
      set: mock(() => ({}) as AppContainerInterface),
      initialize: mock(() => Promise.resolve()),
      close: mock(() => Promise.resolve()),
    };

    const cmd = requireCommand(registry, "provenance.get");

    await expect(
      cmd.execute({ artifactId: "1", artifactType: "pr" }, { container: emptyContainer })
    ).rejects.toThrow("DI container missing 'persistence'");
  });
});
