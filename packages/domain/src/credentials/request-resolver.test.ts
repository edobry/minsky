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
  createCredentialRequestResolverDeps,
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

describe("createCredentialRequestResolverDeps — closing takes the legal path", () => {
  /**
   * Regression for PR #3264 R2. The reviewer caught a real bug: closing a
   * `routed` row is not a legal transition, so it threw, was misfiled as a
   * "race", and left the row routed to repeat forever.
   *
   * The obvious fix — stop looking at routed rows — is WRONG and these tests pin
   * why. `buildCredentialRequestAsk` sets no serviceStrategy, so the router takes
   * the `asap` path and every credential request lands in `routed`. Excluding it
   * would mean the sweep never fires at all: a silent no-op that all the other
   * tests would still pass.
   */
  it("still queries routed — that is where these asks actually live", async () => {
    const queried: string[] = [];
    const repo = {
      listByState: async (state: string) => {
        queried.push(state);
        return [];
      },
    } as never;

    await createCredentialRequestResolverDeps(repo).listCandidateAsks();

    expect(queried.sort()).toEqual(["routed", "suspended"]);
  });

  it("moves a routed row through suspended before closing, never jumping to closed", async () => {
    const calls: string[] = [];
    const repo = {
      transition: async (_id: string, to: string) => {
        calls.push(`transition:${to}`);
      },
      respondAndClose: async () => {
        calls.push("respondAndClose");
      },
      close: async () => {
        calls.push("close");
      },
    } as never;

    const ask = requestAsk("ask-1", "github", "routed");
    await createCredentialRequestResolverDeps(repo).satisfy(ask, "3 buckets visible");

    // The order is the point: routed -> suspended, then the legal
    // suspended -> responded -> closed walk. A bare close() would throw.
    expect(calls).toEqual(["transition:suspended", "respondAndClose"]);
    expect(calls).not.toContain("close");
  });

  it("a suspended row needs no transition — it is already there", async () => {
    const calls: string[] = [];
    const repo = {
      transition: async (_id: string, to: string) => {
        calls.push(`transition:${to}`);
      },
      respondAndClose: async () => {
        calls.push("respondAndClose");
      },
    } as never;

    const ask = requestAsk("ask-1", "github", "suspended");
    await createCredentialRequestResolverDeps(repo).satisfy(ask, "ok");

    expect(calls).toEqual(["respondAndClose"]);
  });
});
