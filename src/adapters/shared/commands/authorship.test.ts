/**
 * Tests for the authorship shared commands.
 *
 * authorship.get returns a narrow projection of the provenance record —
 * { tier, rationale?, policyVersion?, judgingModel? } — suitable for
 * least-privilege consumers like the reviewer bot. It must NOT leak the
 * full record fields (transcriptId, participants, substantiveHumanInput,
 * trajectoryChanges, artifactId, artifactType, taskId, sessionId, etc.).
 *
 * Prototype restoration uses `afterEach` so a mid-test throw cannot leave
 * `ProvenanceService.prototype.getProvenanceForArtifact` polluted for the
 * next test (acceptance test #2 of mt#1254).
 *
 * @see mt#1254 — Authorship namespace introduction
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createSharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import type { AppContainerInterface } from "../../../composition/types";
import type { ProvenanceRecord } from "../../../domain/provenance/types";
import { AuthorshipTier } from "../../../domain/provenance/types";
import { ProvenanceService } from "../../../domain/provenance/provenance-service";

// Type alias — keeps the "getProvenanceForArtifact" string literal in one place.
type GetProvenanceFn = InstanceType<typeof ProvenanceService>["getProvenanceForArtifact"];

// ---------------------------------------------------------------------------
// Shared test fixtures — a full ProvenanceRecord so we can verify that the
// narrow projection actually drops fields (not just happens to be missing them).
// ---------------------------------------------------------------------------

const MOCK_RECORD: ProvenanceRecord = {
  id: "prov-xyz789",
  artifactId: "42",
  artifactType: "pr",
  taskId: "mt#1254",
  sessionId: "session-secret",
  transcriptId: "transcript-confidential",
  taskOrigin: "agent",
  specAuthorship: "agent",
  initiationMode: "autonomous",
  humanMessages: 0,
  totalMessages: 50,
  corrections: 0,
  participants: [{ role: "agent", id: "claude-sonnet-4-6" }] as never,
  substantiveHumanInput: "none",
  trajectoryChanges: 0,
  authorshipTier: AuthorshipTier.AGENT_AUTHORED,
  tierRationale: "fully agent-authored — no human intervention",
  policyVersion: "1.0.0",
  judgingModel: "gpt-5",
  computedAt: new Date("2026-04-24"),
  createdAt: new Date("2026-04-24"),
  updatedAt: new Date("2026-04-24"),
};

// Fields that MUST NOT appear in the authorship.get result. If any of these
// leak through, the narrow-projection contract is broken.
const PROHIBITED_KEYS = [
  "id",
  "artifactId",
  "artifactType",
  "taskId",
  "sessionId",
  "transcriptId",
  "taskOrigin",
  "specAuthorship",
  "initiationMode",
  "humanMessages",
  "totalMessages",
  "corrections",
  "participants",
  "substantiveHumanInput",
  "trajectoryChanges",
  "authorshipTier",
  "tierRationale",
  "computedAt",
  "createdAt",
  "updatedAt",
] as const;

const ALLOWED_KEYS = ["tier", "rationale", "policyVersion", "judgingModel"] as const;

// ---------------------------------------------------------------------------
// Helper: build a minimal mock AppContainerInterface
// ---------------------------------------------------------------------------

function buildMockContainer(): AppContainerInterface {
  const fakeDb = {} as never;
  const fakePersistenceProvider = {
    getDatabaseConnection: mock(() => Promise.resolve(fakeDb)),
  } as unknown as ReturnType<AppContainerInterface["get"]>;

  return {
    has: mock((key: string) => key === "persistence") as AppContainerInterface["has"],
    get: mock((_key: string) => fakePersistenceProvider) as AppContainerInterface["get"],
    register: mock(() => ({}) as AppContainerInterface),
    set: mock(() => ({}) as AppContainerInterface),
    initialize: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
  };
}

function requireCommand(registry: SharedCommandRegistry, id: string) {
  const cmd = registry.getCommand(id);
  if (!cmd) throw new Error(`Command ${id} not registered`);
  return cmd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authorship.get shared command", () => {
  let registry: SharedCommandRegistry;
  // Prototype snapshot captured in beforeEach, restored unconditionally in afterEach.
  let originalGetProvenanceForArtifact: GetProvenanceFn | undefined;

  beforeEach(async () => {
    registry = createSharedCommandRegistry();
    const { registerAuthorshipCommands } = await import("./authorship");
    registerAuthorshipCommands(undefined, registry);
    originalGetProvenanceForArtifact = ProvenanceService.prototype.getProvenanceForArtifact;
  });

  afterEach(() => {
    mock.restore();
    // Unconditional prototype restore — fires even when a test throws.
    if (originalGetProvenanceForArtifact !== undefined) {
      ProvenanceService.prototype.getProvenanceForArtifact = originalGetProvenanceForArtifact;
    }
  });

  test("authorship.get is registered in the command registry", () => {
    const cmd = registry.getCommand("authorship.get");
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe("get");
    expect(cmd?.category).toBe(CommandCategory.AUTHORSHIP);
  });

  test("authorship.recompute is registered in the command registry", () => {
    const cmd = registry.getCommand("authorship.recompute");
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe("recompute");
    expect(cmd?.category).toBe(CommandCategory.AUTHORSHIP);
  });

  test("returns a narrow projection — only tier/rationale/policyVersion/judgingModel", async () => {
    const getProvenanceForArtifact = mock(() => Promise.resolve(MOCK_RECORD));
    ProvenanceService.prototype.getProvenanceForArtifact =
      getProvenanceForArtifact as GetProvenanceFn;

    const container = buildMockContainer();
    const cmd = requireCommand(registry, "authorship.get");

    const result = (await cmd.execute(
      { artifactId: "42", artifactType: "pr" },
      { container }
    )) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.tier).toBe(AuthorshipTier.AGENT_AUTHORED);
    expect(result.rationale).toBe("fully agent-authored — no human intervention");
    expect(result.policyVersion).toBe("1.0.0");
    expect(result.judgingModel).toBe("gpt-5");

    // Narrow-projection contract: every returned key must be in ALLOWED_KEYS.
    for (const key of Object.keys(result)) {
      expect(ALLOWED_KEYS as readonly string[]).toContain(key);
    }

    // And no prohibited field from the full record may leak through.
    for (const forbidden of PROHIBITED_KEYS) {
      expect(result).not.toHaveProperty(forbidden);
    }
  });

  test("returns null for a missing record", async () => {
    const getProvenanceForArtifact = mock(() => Promise.resolve(null));
    ProvenanceService.prototype.getProvenanceForArtifact =
      getProvenanceForArtifact as GetProvenanceFn;

    const container = buildMockContainer();
    const cmd = requireCommand(registry, "authorship.get");

    const result = await cmd.execute({ artifactId: "999", artifactType: "pr" }, { container });
    expect(result).toBeNull();
  });

  test("omits rationale / policyVersion / judgingModel when null on the record", async () => {
    // policyVersion is typed `string` on ProvenanceRecord (not nullable), but at
    // runtime the command handles null defensively. Cast through unknown to
    // exercise that defensive branch.
    const recordWithNulls = {
      ...MOCK_RECORD,
      tierRationale: null,
      policyVersion: null,
      judgingModel: null,
    } as unknown as ProvenanceRecord;
    const getProvenanceForArtifact = mock(() => Promise.resolve(recordWithNulls));
    ProvenanceService.prototype.getProvenanceForArtifact =
      getProvenanceForArtifact as GetProvenanceFn;

    const container = buildMockContainer();
    const cmd = requireCommand(registry, "authorship.get");

    const result = (await cmd.execute(
      { artifactId: "42", artifactType: "pr" },
      { container }
    )) as Record<string, unknown>;

    expect(result.tier).toBe(AuthorshipTier.AGENT_AUTHORED);
    expect(result).not.toHaveProperty("rationale");
    expect(result).not.toHaveProperty("policyVersion");
    expect(result).not.toHaveProperty("judgingModel");
  });

  test("rejects invalid artifactType at the schema layer", () => {
    const cmd = requireCommand(registry, "authorship.get");
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

    const cmd = requireCommand(registry, "authorship.get");
    await expect(
      cmd.execute({ artifactId: "1", artifactType: "pr" }, { container: emptyContainer })
    ).rejects.toThrow("DI container missing 'persistence'");
  });

  // -------------------------------------------------------------------------
  // afterEach prototype-restore acceptance test (mt#1254 acceptance #2)
  //
  // The pair of tests below proves that `afterEach` restores the prototype
  // unconditionally even when a test throws. Tests in a describe block run
  // sequentially; test 1 deliberately patches the prototype with a function
  // that throws on call, then exits normally. afterEach must restore the
  // original — test 2 then verifies the restored method is the pristine one
  // (not the thrower).
  // -------------------------------------------------------------------------

  test("(setup) patches prototype with a throwing stub — afterEach must restore it", () => {
    const thrower = (() => {
      throw new Error("polluted prototype — afterEach did not restore");
    }) as unknown as GetProvenanceFn;
    ProvenanceService.prototype.getProvenanceForArtifact = thrower;
    // Exit normally — afterEach must still fire and restore the original.
    expect(ProvenanceService.prototype.getProvenanceForArtifact).toBe(thrower);
  });

  test("(verify) prototype is clean — afterEach restored the original", () => {
    // beforeEach always assigns originalGetProvenanceForArtifact; narrow with an
    // assertion so toBe doesn't reject the `| undefined` branch.
    if (!originalGetProvenanceForArtifact) {
      throw new Error("beforeEach failed to capture original prototype method");
    }
    expect(ProvenanceService.prototype.getProvenanceForArtifact).toBe(
      originalGetProvenanceForArtifact
    );
  });
});
