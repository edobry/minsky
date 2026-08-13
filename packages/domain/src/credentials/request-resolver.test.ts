/**
 * Tests for the credential-request resolver shell (mt#4030).
 *
 * Deps are injected, so these exercise the real orchestration against fakes —
 * no database, no config file, and no patched module.
 */
import { describe, it, expect } from "bun:test";

import type { Ask } from "../ask/types";
import { CREDENTIAL_REQUEST_METADATA_KEY } from "./request";
import {
  resolveSatisfiedCredentialRequests,
  type CredentialRequestResolverDeps,
} from "./request-resolver";

function requestAsk(id: string, provider: string, state: Ask["state"] = "suspended"): Ask {
  return {
    id,
    kind: "authorization.approve",
    classifierVersion: "v1.0.0",
    state,
    requestor: "test",
    title: "t",
    question: "q",
    createdAt: new Date("2026-08-13T00:00:00Z"),
    metadata: { [CREDENTIAL_REQUEST_METADATA_KEY]: { provider } },
  } as unknown as Ask;
}

/** Records what was closed so the assertions read the real orchestration path. */
function makeDeps(
  asks: Ask[],
  presence: { provider: string; configured: boolean; detail?: string }[],
  satisfyImpl?: (ask: Ask, detail: string) => Promise<void>
): { deps: CredentialRequestResolverDeps; closed: { id: string; detail: string }[] } {
  const closed: { id: string; detail: string }[] = [];
  return {
    closed,
    deps: {
      listCandidateAsks: async () => asks,
      listPresence: async () => presence,
      satisfy: async (ask, detail) => {
        if (satisfyImpl) return satisfyImpl(ask, detail);
        closed.push({ id: ask.id, detail });
      },
    },
  };
}

describe("resolveSatisfiedCredentialRequests", () => {
  it("closes a request once its credential is present", async () => {
    const { deps, closed } = makeDeps(
      [requestAsk("a", "github")],
      [{ provider: "github", configured: true, detail: "8 repos visible" }]
    );

    const result = await resolveSatisfiedCredentialRequests(deps);

    expect(result).toEqual({ pending: 1, satisfied: ["a"], raced: [] });
    expect(closed).toEqual([{ id: "a", detail: "8 repos visible" }]);
  });

  it("leaves a request open while its credential is absent", async () => {
    const { deps, closed } = makeDeps(
      [requestAsk("a", "github")],
      [{ provider: "github", configured: false }]
    );

    const result = await resolveSatisfiedCredentialRequests(deps);

    expect(result).toEqual({ pending: 1, satisfied: [], raced: [] });
    expect(closed).toEqual([]);
  });

  it("resolves out-of-band entry — no response was ever recorded on the ask", async () => {
    // The principal ran `config credentials add` in a terminal. Nothing clicked.
    const { deps, closed } = makeDeps(
      [requestAsk("a", "railway")],
      [{ provider: "railway", configured: true }]
    );

    await resolveSatisfiedCredentialRequests(deps);

    expect(closed.map((c) => c.id)).toEqual(["a"]);
  });

  it("short-circuits with no IO beyond the ask read when nothing is pending", async () => {
    let presenceReads = 0;
    const deps: CredentialRequestResolverDeps = {
      listCandidateAsks: async () => [],
      listPresence: async () => {
        presenceReads += 1;
        return [];
      },
      satisfy: async () => {},
    };

    expect(await resolveSatisfiedCredentialRequests(deps)).toEqual({
      pending: 0,
      satisfied: [],
      raced: [],
    });
    expect(presenceReads).toBe(0);
  });

  it("is idempotent — a second pass over closed rows does nothing", async () => {
    const { deps } = makeDeps(
      [requestAsk("a", "github", "closed")],
      [{ provider: "github", configured: true }]
    );

    expect(await resolveSatisfiedCredentialRequests(deps)).toEqual({
      pending: 0,
      satisfied: [],
      raced: [],
    });
  });

  it("records a request that moved under us as raced, and keeps going", async () => {
    const { deps } = makeDeps(
      [requestAsk("a", "github"), requestAsk("b", "railway")],
      [
        { provider: "github", configured: true },
        { provider: "railway", configured: true },
      ],
      async (ask) => {
        if (ask.id === "a") throw new Error("ConcurrentTransitionError: state is cancelled");
      }
    );

    const result = await resolveSatisfiedCredentialRequests(deps);

    expect(result.raced).toEqual(["a"]);
    expect(result.satisfied).toEqual(["b"]);
  });

  it("ignores asks that are not credential requests", async () => {
    const plain = { ...requestAsk("x", "github"), metadata: {} } as Ask;
    const { deps, closed } = makeDeps([plain], [{ provider: "github", configured: true }]);

    const result = await resolveSatisfiedCredentialRequests(deps);

    expect(result.pending).toBe(0);
    expect(closed).toEqual([]);
  });
});
