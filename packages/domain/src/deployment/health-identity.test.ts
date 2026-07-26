/**
 * Health-identity assertion coverage (mt#3148).
 *
 * mt#3148's SC3 is explicit that inspection is not enough: *"Proven by negative
 * control, not by inspection: point a service's healthcheck at a different
 * Minsky service and demonstrate the check FAILS. A check that has never been
 * observed failing is not known to discriminate — that is the entire point."*
 *
 * So the fixtures below are **real captured bodies**, probed live on
 * 2026-07-26 against the production hosts, not invented shapes. The decisive
 * case replays the mt#3142 signature exactly: the MCP server's body arriving
 * where the reviewer's was expected.
 */
import { describe, test, expect } from "bun:test";
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  SERVICE_IDENTITIES,
} from "./health-identity";

/**
 * Captured live 2026-07-26 from `minsky-mcp-production.up.railway.app/health`,
 * BEFORE this task added `service`. This is the body that answered 200 on the
 * reviewer's host throughout the mt#3142 outage.
 */
const MCP_BODY_AT_INCIDENT = {
  status: "ok",
  server: "Minsky MCP Server",
  transport: "http",
  timestamp: "2026-07-26T16:43:43.231Z",
  persistence: { mode: "connected" },
};

/** Captured live 2026-07-26 from the reviewer host, before `service` was added. */
const REVIEWER_BODY_BEFORE = {
  status: "ok",
  provider: "openai",
  model: "gpt-5",
  tier2Enabled: true,
  inflightCount: 0,
};

/** Captured live 2026-07-26 from `services/site` — it already emitted `service`. */
const SITE_BODY = { status: "ok", service: "minsky-site" };

describe("assertServiceIdentity", () => {
  describe("negative control — the check must be OBSERVED failing (SC3)", () => {
    test("mt#3142 replay: the MCP server's body where the reviewer's was expected FAILS", () => {
      const result = assertServiceIdentity(
        { ...MCP_BODY_AT_INCIDENT, service: SERVICE_IDENTITIES.mcp },
        SERVICE_IDENTITIES.reviewer
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable — asserted false above");
      expect(result.reason).toBe("wrong-service");
      // The failure names BOTH sides, so an operator reading a red check knows
      // immediately which application is actually deployed.
      expect(describeHealthIdentityResult(result)).toContain("minsky-reviewer");
      expect(describeHealthIdentityResult(result)).toContain("minsky-mcp");
      expect(describeHealthIdentityResult(result)).toContain("different application");
    });

    test("every cross-pairing of the four services fails — no accidental collisions", () => {
      const identities = Object.values(SERVICE_IDENTITIES);
      for (const expected of identities) {
        for (const actual of identities) {
          const result = assertServiceIdentity({ status: "ok", service: actual }, expected);
          if (expected === actual) {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
          }
        }
      }
    });

    test("the PRE-mt#3148 reviewer body fails as missing-identity, not as a pass", () => {
      // This is the state the fleet was in before this task: a healthy, correct
      // reviewer whose body simply had no assertable identity. It must NOT
      // silently pass — a probe that accepts an unidentified body is the bare-200
      // problem wearing a different hat.
      const result = assertServiceIdentity(REVIEWER_BODY_BEFORE, SERVICE_IDENTITIES.reviewer);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("missing-identity");
    });

    test("a non-JSON 200 (proxy error page) fails as not-json", () => {
      expect(assertServiceIdentity("<html>OK</html>", SERVICE_IDENTITIES.cockpit).ok).toBe(false);
      expect(assertServiceIdentity(null, SERVICE_IDENTITIES.cockpit).ok).toBe(false);

      const result = assertServiceIdentity("<html>OK</html>", SERVICE_IDENTITIES.cockpit);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("not-json");
    });

    test("an empty-string service is treated as missing, not as a match against empty", () => {
      const result = assertServiceIdentity({ status: "ok", service: "" }, SERVICE_IDENTITIES.site);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("missing-identity");
    });
  });

  describe("positive path", () => {
    test("the site's real captured body passes against its own identity", () => {
      const result = assertServiceIdentity(SITE_BODY, SERVICE_IDENTITIES.site);
      expect(result.ok).toBe(true);
      expect(describeHealthIdentityResult(result)).toContain("identity OK");
    });

    test("extra fields are ignored — services keep their own health payloads", () => {
      const result = assertServiceIdentity(
        { status: "ok", service: SERVICE_IDENTITIES.reviewer, provider: "openai", model: "gpt-5" },
        SERVICE_IDENTITIES.reviewer
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("the identity registry", () => {
    test("every canonical name is unique — a duplicate would silently defeat the check", () => {
      const values = Object.values(SERVICE_IDENTITIES);
      expect(new Set(values).size).toBe(values.length);
    });

    test("minsky-ops is deliberately absent (no application source, no health endpoint)", () => {
      expect(Object.values(SERVICE_IDENTITIES)).not.toContain("minsky-ops");
    });
  });
});
