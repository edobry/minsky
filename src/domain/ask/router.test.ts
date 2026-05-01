/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp dirs for hermetic policy-router integration tests */
/**
 * Tests for the Ask router (policyFirstRoute).
 *
 * Three scenarios per the spec:
 *   1. End-to-end: authorization.approve Ask with a CLAUDE.md fixture containing
 *      "auto-approve formatter commits" → RoutedAsk has state="closed",
 *      responder="policy", citation.source="CLAUDE.md".
 *   2. Routing-only (uncovered): direction.decide with no policy match →
 *      RoutedAsk has state="routed", routingTarget="operator", transport.kind="inbox".
 *   3. capability.escalate uncovered → transport.kind="subagent", routingTarget="subagent".
 *
 * The tests that verify routing (Phase 2) do not write CLAUDE.md fixtures;
 * only Phase 1 coverage tests use real FS to create fixture files.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { policyFirstRoute } from "./router";
import type { Ask } from "./types";

// ---------------------------------------------------------------------------
// Shared constants (avoid magic-string-duplication warnings)
// ---------------------------------------------------------------------------

const KIND_AUTH_APPROVE: Ask["kind"] = "authorization.approve";
const KIND_DIR_DECIDE: Ask["kind"] = "direction.decide";
const KIND_CAPABILITY_ESCALATE: Ask["kind"] = "capability.escalate";
const KIND_STUCK_UNBLOCK: Ask["kind"] = "stuck.unblock";
const KIND_COORD_NOTIFY: Ask["kind"] = "coordination.notify";
const KIND_QUALITY_REVIEW: Ask["kind"] = "quality.review";
const KIND_INFO_RETRIEVE: Ask["kind"] = "information.retrieve";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal valid Ask fixture. Does not use `as` casts. */
function makeAsk(kind: Ask["kind"], title = "test ask"): Ask {
  return {
    id: "router-test-ask-001",
    kind,
    classifierVersion: "v1",
    requestor: "test-agent:proc:abc123",
    state: "classified",
    title,
    question: `Please resolve: ${title}`,
    createdAt: new Date().toISOString(),
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("policyFirstRoute", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ask-router-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("Phase 1: policy-covered asks", () => {
    it("closes an authorization.approve Ask when CLAUDE.md covers it (auto-approve formatter commits)", async () => {
      await writeFile(
        join(tmpDir, "CLAUDE.md"),
        `
# Auto-approvals

- auto-approve formatter commits: commits that only change formatting (whitespace,
  semicolons, trailing commas) are pre-approved without requiring manual review.
`,
        "utf-8"
      );

      const ask = makeAsk(KIND_AUTH_APPROVE, "Approve formatter commit changes");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("closed");
      expect(result.routingTarget).toBe("policy");
      expect(result.transport.kind).toBe("policy");
      expect(result.response?.responder).toBe("policy");

      const payload = result.packagedPayload;
      expect(payload.citation).toBeDefined();
      expect(payload.citation?.source).toBe("CLAUDE.md");
    });

    it("sets closedAt on policy-covered asks", async () => {
      await writeFile(
        join(tmpDir, "CLAUDE.md"),
        "auto-approve test runs without manual review.",
        "utf-8"
      );

      const ask = makeAsk(KIND_AUTH_APPROVE, "Approve running tests");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.closedAt).toBeTruthy();
      expect(result.routedAt).toBeTruthy();
    });

    it("carries the citation in response.payload for policy-covered asks", async () => {
      await writeFile(
        join(tmpDir, "CLAUDE.md"),
        "policy: lint fixes are auto-approved without operator sign-off.",
        "utf-8"
      );

      const ask = makeAsk(KIND_AUTH_APPROVE, "Approve lint fix");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("closed");
      const responseCitation = (result.response?.payload as { citation?: unknown })?.citation;
      expect(responseCitation).toBeDefined();
    });
  });

  describe("Phase 2: uncovered asks — routing by kind", () => {
    it("routes a direction.decide Ask with no policy match to operator via inbox", async () => {
      // Empty CLAUDE.md — no policy coverage.
      await writeFile(
        join(tmpDir, "CLAUDE.md"),
        "# Project guidelines\n\nFollow clean architecture.",
        "utf-8"
      );

      const ask = makeAsk(KIND_DIR_DECIDE, "Choose between SQL and NoSQL for analytics");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("routed");
      expect(result.routingTarget).toBe("operator");
      expect(result.transport.kind).toBe("inbox");
    });

    it("routes a capability.escalate Ask to subagent", async () => {
      const ask = makeAsk(KIND_CAPABILITY_ESCALATE, "Model too small — need Opus");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("routed");
      expect(result.routingTarget).toBe("subagent");
      expect(result.transport.kind).toBe("subagent");
    });

    it("routes a stuck.unblock Ask to subagent", async () => {
      const ask = makeAsk(KIND_STUCK_UNBLOCK, "Stuck after 3 attempts on type error");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("routed");
      expect(result.routingTarget).toBe("subagent");
      expect(result.transport.kind).toBe("subagent");
    });

    it("routes a coordination.notify Ask to mesh", async () => {
      const ask = makeAsk(KIND_COORD_NOTIFY, "Notify peer session of schema change");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("routed");
      expect(result.routingTarget).toBe("peer");
      expect(result.transport.kind).toBe("mesh");
    });

    it("routes a quality.review Ask to reviewer via inbox", async () => {
      const ask = makeAsk(KIND_QUALITY_REVIEW, "Review PR #42 before merge");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("routed");
      expect(result.routingTarget).toBe("reviewer");
      expect(result.transport.kind).toBe("inbox");
    });

    it("routes an information.retrieve Ask to retriever transport", async () => {
      const ask = makeAsk(KIND_INFO_RETRIEVE, "Fetch the prior migration artifact");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("routed");
      expect(result.routingTarget).toBe("retriever");
      expect(result.transport.kind).toBe("retriever");
    });

    it("sets routedAt on routed asks", async () => {
      const ask = makeAsk(KIND_DIR_DECIDE, "Pick deployment strategy");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.routedAt).toBeTruthy();
      // Should be a valid ISO-8601 date
      const routedAtMs = result.routedAt !== undefined ? new Date(result.routedAt).getTime() : 0;
      expect(routedAtMs).toBeGreaterThan(0);
    });

    it("preserves the original Ask fields (id, kind, requestor, question)", async () => {
      const ask = makeAsk(KIND_DIR_DECIDE, "Architectural choice");
      ask.parentTaskId = "mt#999";

      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.id).toBe(ask.id);
      expect(result.kind).toBe(ask.kind);
      expect(result.requestor).toBe(ask.requestor);
      expect(result.question).toBe(ask.question);
      expect(result.parentTaskId).toBe("mt#999");
    });

    it("packages the question in the payload", async () => {
      const ask = makeAsk(KIND_DIR_DECIDE, "Choose DB");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.packagedPayload.question).toBe(ask.question);
    });
  });

  describe("workspaceRoot defaults", () => {
    it("falls back to process.cwd() when workspaceRoot is not provided", async () => {
      const ask = makeAsk(KIND_DIR_DECIDE, "Pick strategy");
      // Should not throw even without explicit workspaceRoot
      const result = await policyFirstRoute(ask);
      expect(result.state).toBe("routed");
    });
  });

  describe("specContent policy consultation", () => {
    it("uses specContent as a policy source for task-spec coverage", async () => {
      const specContent = `
## Constraints

The following steps are permitted: approve and run the CI test suite at any time.
`;
      const ask = makeAsk(KIND_AUTH_APPROVE, "Approve CI step");
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir, specContent });

      expect(result.state).toBe("closed");
      expect(result.packagedPayload.citation?.source).toBe("task-spec");
    });
  });

  // -------------------------------------------------------------------------
  // mt#1457 — capability-aware routing
  // -------------------------------------------------------------------------

  describe("capability-aware routing (mt#1457)", () => {
    /** Stub registry that lets tests toggle the capability state. */
    function makeRegistry(hasElicitation: boolean) {
      return {
        hasElicitation: () => hasElicitation,
        activeElicitationServer: () => null,
      };
    }

    const QUESTION_ARCH_CHOICE = "Architectural choice";

    it("direction.decide routes to elicitation when registry reports hasElicitation=true", async () => {
      const ask = makeAsk(KIND_DIR_DECIDE, QUESTION_ARCH_CHOICE);
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(true),
      });

      expect(result.state).toBe("routed");
      expect(result.transport.kind).toBe("elicitation");
      expect(result.routingTarget).toBe("operator");
    });

    it("direction.decide falls back to inbox when hasElicitation=false", async () => {
      const ask = makeAsk(KIND_DIR_DECIDE, QUESTION_ARCH_CHOICE);
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(false),
      });

      expect(result.state).toBe("routed");
      expect(result.transport.kind).toBe("inbox");
      expect(result.routingTarget).toBe("operator");
    });

    it("direction.decide falls back to inbox when no capabilityRegistry is provided", async () => {
      const ask = makeAsk(KIND_DIR_DECIDE, QUESTION_ARCH_CHOICE);
      const result = await policyFirstRoute(ask, { workspaceRoot: tmpDir });

      expect(result.state).toBe("routed");
      expect(result.transport.kind).toBe("inbox");
    });

    it("async kinds (capability.escalate) ignore the capability registry — sync axis only", async () => {
      const ask = makeAsk(KIND_CAPABILITY_ESCALATE, "Need bigger model");
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(true),
      });

      // capability.escalate is async per the sync/async axis — should still
      // route to subagent regardless of elicitation capability.
      expect(result.state).toBe("routed");
      expect(result.transport.kind).toBe("subagent");
      expect(result.routingTarget).toBe("subagent");
    });

    it("async kinds (quality.review) ignore the capability registry", async () => {
      const ask = makeAsk(KIND_QUALITY_REVIEW, "Review my output");
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(true),
      });

      expect(result.transport.kind).toBe("inbox");
    });

    it("async kinds (coordination.notify) ignore the capability registry", async () => {
      const ask = makeAsk(KIND_COORD_NOTIFY, "Heads up");
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(true),
      });

      expect(result.transport.kind).toBe("mesh");
    });

    it("async kinds (information.retrieve) ignore the capability registry", async () => {
      const ask = makeAsk(KIND_INFO_RETRIEVE, "Look up X");
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(true),
      });

      expect(result.transport.kind).toBe("retriever");
    });

    it("async kinds (stuck.unblock) ignore the capability registry", async () => {
      const ask = makeAsk(KIND_STUCK_UNBLOCK, "Stuck on X");
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(true),
      });

      expect(result.transport.kind).toBe("subagent");
    });

    it("policy coverage takes precedence over elicitation routing", async () => {
      // Phase 1 (policy) runs before Phase 2 (capability-aware kind dispatch).
      // A direction.decide Ask whose context is policy-covered should close,
      // even when elicitation is available.
      const claudeMdPath = join(tmpDir, "CLAUDE.md");
      await writeFile(claudeMdPath, "Policy: auto-approve direction.decide on test scope.\n");

      const ask = makeAsk(KIND_DIR_DECIDE, "Some routine choice");
      const result = await policyFirstRoute(ask, {
        workspaceRoot: tmpDir,
        capabilityRegistry: makeRegistry(true),
      });

      // Policy short-circuits to closed, regardless of capability.
      expect(result.state).toBe("closed");
      expect(result.transport.kind).toBe("policy");
    });
  });
});
