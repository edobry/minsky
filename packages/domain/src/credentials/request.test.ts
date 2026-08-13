/**
 * Tests for the agent-initiated credential request core (mt#4030).
 *
 * Every function under test is pure, so these need no database, no network, and
 * no patched collaborator — the decisions are all in return values.
 */
import { describe, it, expect } from "bun:test";

import type { Ask } from "../ask/types";
import type { CredentialProvider } from "./types";
import {
  CREDENTIAL_REQUEST_ASK_KIND,
  CREDENTIAL_REQUEST_METADATA_KEY,
  buildCredentialRequestAsk,
  isPolicyResolved,
  readCredentialRequest,
  selectPendingCredentialRequests,
  selectSatisfiedCredentialRequests,
} from "./request";

const PROVIDER: CredentialProvider = {
  id: "supabase-service-role",
  displayName: "Supabase service-role key",
  configPath: "supabase.serviceRoleKey",
  acquireUrl: "https://supabase.com/dashboard/project/_/settings/api-keys",
  scopeGuidance: "Copy the service_role key, not the anon key.",
  validate: async () => ({ ok: true }),
  test: async () => ({ ok: true }),
};

function makeAsk(partial: Partial<Ask>): Ask {
  return {
    id: partial.id ?? "00000000-0000-0000-0000-000000000000",
    kind: partial.kind ?? CREDENTIAL_REQUEST_ASK_KIND,
    classifierVersion: "v1.0.0",
    state: partial.state ?? "suspended",
    requestor: "test",
    title: "t",
    question: "q",
    createdAt: new Date("2026-08-13T00:00:00Z"),
    ...partial,
  } as Ask;
}

function requestAsk(provider: string, partial: Partial<Ask> = {}): Ask {
  return makeAsk({
    ...partial,
    metadata: { [CREDENTIAL_REQUEST_METADATA_KEY]: { provider } },
  });
}

describe("buildCredentialRequestAsk", () => {
  it("files under the kind that reaches the operator inbox", () => {
    const draft = buildCredentialRequestAsk({ provider: PROVIDER, reason: "needed for X" });
    expect(draft.kind).toBe("authorization.approve");
  });

  it("carries only the provider id in metadata", () => {
    const draft = buildCredentialRequestAsk({ provider: PROVIDER, reason: "needed for X" });
    expect(draft.metadata[CREDENTIAL_REQUEST_METADATA_KEY]).toEqual({
      provider: "supabase-service-role",
    });
  });

  it("embeds the acquire URL so the principal is not sent hunting for the portal", () => {
    const draft = buildCredentialRequestAsk({ provider: PROVIDER, reason: "needed for X" });
    expect(draft.question).toContain(PROVIDER.acquireUrl);
  });

  it("states the reason and the destination config path", () => {
    const draft = buildCredentialRequestAsk({
      provider: PROVIDER,
      reason: "the archive client cannot reach storage without it",
    });
    expect(draft.question).toContain("the archive client cannot reach storage without it");
    expect(draft.question).toContain("supabase.serviceRoleKey");
  });

  it("does not read as a severity event — a queued chore is not an incident", () => {
    const draft = buildCredentialRequestAsk({ provider: PROVIDER, reason: "needed for X" });
    expect(draft.question).not.toMatch(/\b(outage|down|failing|incident|production)\b/i);
  });

  it("binds the request to a task when one is supplied, and omits the key otherwise", () => {
    const bound = buildCredentialRequestAsk({
      provider: PROVIDER,
      reason: "r",
      parentTaskId: "mt#4030",
    });
    expect(bound.parentTaskId).toBe("mt#4030");
    expect(buildCredentialRequestAsk({ provider: PROVIDER, reason: "r" })).not.toHaveProperty(
      "parentTaskId"
    );
  });

  it("exposes no field capable of carrying a credential value", () => {
    const draft = buildCredentialRequestAsk({ provider: PROVIDER, reason: "r" });
    const keys = [...Object.keys(draft), ...Object.keys(draft.metadata)];
    for (const key of keys) {
      expect(key).not.toMatch(/token|secret|key$|value|password|credential$/i);
    }
  });
});

describe("readCredentialRequest", () => {
  it("reads the provider back off a request ask", () => {
    expect(readCredentialRequest(requestAsk("github"))).toEqual({ provider: "github" });
  });

  it("returns null for an ask that is not a credential request", () => {
    expect(readCredentialRequest(makeAsk({ metadata: {} }))).toBeNull();
    expect(readCredentialRequest(makeAsk({}))).toBeNull();
    expect(readCredentialRequest(null)).toBeNull();
  });

  it("rejects a malformed payload rather than trusting the jsonb column", () => {
    const cases: unknown[] = [{ provider: "" }, { provider: 7 }, { notProvider: "x" }, "string", 3];
    for (const raw of cases) {
      const ask = makeAsk({ metadata: { [CREDENTIAL_REQUEST_METADATA_KEY]: raw } });
      expect(readCredentialRequest(ask)).toBeNull();
    }
  });
});

describe("isPolicyResolved", () => {
  it("detects a policy routing target", () => {
    expect(isPolicyResolved(makeAsk({ routingTarget: "policy" }))).toBe(true);
  });

  it("detects a policy responder even when the routing target reads otherwise", () => {
    const ask = makeAsk({
      routingTarget: "operator",
      response: { responder: "policy", payload: {} },
    });
    expect(isPolicyResolved(ask)).toBe(true);
  });

  it("is false for an ask that actually reached the operator", () => {
    expect(isPolicyResolved(makeAsk({ routingTarget: "operator" }))).toBe(false);
  });
});

describe("selectPendingCredentialRequests", () => {
  it("keeps requests still awaiting the principal", () => {
    const asks = [
      requestAsk("github", { id: "a", state: "suspended" }),
      requestAsk("railway", { id: "b", state: "routed" }),
    ];
    expect(selectPendingCredentialRequests(asks).map((p) => p.provider)).toEqual([
      "github",
      "railway",
    ]);
  });

  it("excludes terminal rows so a re-run cannot re-close a settled request", () => {
    const asks = [
      requestAsk("github", { id: "a", state: "closed" }),
      requestAsk("railway", { id: "b", state: "expired" }),
      requestAsk("google", { id: "c", state: "cancelled" }),
      requestAsk("anthropic", { id: "d", state: "responded" }),
    ];
    expect(selectPendingCredentialRequests(asks)).toEqual([]);
  });

  it("ignores asks that are not credential requests", () => {
    const asks = [makeAsk({ id: "a" }), requestAsk("github", { id: "b" })];
    expect(selectPendingCredentialRequests(asks).map((p) => p.ask.id)).toEqual(["b"]);
  });
});

describe("selectSatisfiedCredentialRequests", () => {
  const pending = selectPendingCredentialRequests([
    requestAsk("github", { id: "a" }),
    requestAsk("railway", { id: "b" }),
  ]);

  it("satisfies a request once its credential is present", () => {
    const satisfied = selectSatisfiedCredentialRequests(pending, [
      { provider: "github", configured: true, detail: "8 repos visible" },
      { provider: "railway", configured: false },
    ]);
    expect(satisfied).toHaveLength(1);
    expect(satisfied[0]?.ask.id).toBe("a");
    expect(satisfied[0]?.detail).toBe("8 repos visible");
  });

  it("satisfies out-of-band entry the same as in-cockpit entry — presence is the whole signal", () => {
    // No response was ever recorded on the ask; only the credential appeared.
    const satisfied = selectSatisfiedCredentialRequests(pending, [
      { provider: "railway", configured: true },
    ]);
    expect(satisfied.map((s) => s.ask.id)).toEqual(["b"]);
  });

  it("falls back to a status string when the provider reports no detail", () => {
    const satisfied = selectSatisfiedCredentialRequests(pending, [
      { provider: "github", configured: true },
    ]);
    expect(satisfied[0]?.detail).toBe("credential configured");
  });

  it("satisfies nothing when no credential is configured", () => {
    expect(
      selectSatisfiedCredentialRequests(pending, [
        { provider: "github", configured: false },
        { provider: "railway", configured: false },
      ])
    ).toEqual([]);
  });

  it("never surfaces a value — the close detail is the provider's own status line", () => {
    const satisfied = selectSatisfiedCredentialRequests(pending, [
      { provider: "github", configured: true, detail: "8 repos visible" },
    ]);
    expect(JSON.stringify(satisfied[0]?.detail)).not.toContain("sbp_");
  });
});
