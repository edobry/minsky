/**
 * Tests for the extracted presence-backed request pattern (mt#4693 D4).
 *
 * These exercise the GENERIC core directly, against a key type the credential
 * request does not use — so a change that quietly re-specializes it to strings,
 * or to a provider-shaped payload, fails here rather than at the second
 * consumer. Deps are injected; no database, no patched module.
 */
import { describe, it, expect } from "bun:test";

import type { Ask } from "./types";
import {
  PENDING_REQUEST_STATES,
  resolveSatisfiedPresenceRequests,
  selectPendingPresenceRequests,
  selectSatisfiedPresenceRequests,
  type PresenceRequestShape,
} from "./presence-backed-request";

/** A composite key, deliberately not a bare string — see the file docblock. */
interface RepoRole {
  readonly repo: string;
  readonly role: string;
}

const SHAPE: PresenceRequestShape<RepoRole> = {
  label: "test-request",
  readKey: (ask) => (ask.metadata?.testKey as RepoRole | undefined) ?? null,
  identity: (k) => `${k.repo}|${k.role}`,
  defaultDetail: "provisioned",
};

function ask(id: string, key: RepoRole | null, state: Ask["state"] = "suspended"): Ask {
  return {
    id,
    kind: "authorization.approve",
    classifierVersion: "v1.0.0",
    state,
    requestor: "test",
    title: "t",
    question: "q",
    createdAt: new Date("2026-08-27T00:00:00Z"),
    metadata: key ? { testKey: key } : {},
  } as unknown as Ask;
}

const ALPHA: RepoRole = { repo: "edobry/alpha", role: "implementer" };
const BETA: RepoRole = { repo: "edobry/beta", role: "reviewer" };

describe("selectPendingPresenceRequests (mt#4693)", () => {
  it("keeps only asks in a pending state that carry this kind's key", () => {
    const pending = selectPendingPresenceRequests(
      [ask("a", ALPHA), ask("b", null), ask("c", BETA, "closed")],
      SHAPE
    );
    expect(pending.map((p) => p.ask.id)).toEqual(["a"]);
    expect(pending[0]?.key).toEqual(ALPHA);
  });

  it("covers every pending state, so a routed ask is not dropped alongside a suspended one", () => {
    // Both `routed` and `suspended` are reachable depending on the kind's
    // serviceStrategy. Narrowing this set to whichever one is observed today is
    // the documented hazard.
    expect([...PENDING_REQUEST_STATES].sort()).toEqual([
      "classified",
      "detected",
      "routed",
      "suspended",
    ]);
    const pending = selectPendingPresenceRequests(
      [ask("a", ALPHA, "routed"), ask("b", BETA, "suspended")],
      SHAPE
    );
    expect(pending).toHaveLength(2);
  });
});

describe("selectSatisfiedPresenceRequests (mt#4693)", () => {
  it("matches on composite-key identity, not object reference", () => {
    const satisfied = selectSatisfiedPresenceRequests(
      [{ ask: ask("a", ALPHA), key: ALPHA }],
      // A structurally-equal but distinct object — reference equality would miss it.
      [{ key: { repo: "edobry/alpha", role: "implementer" }, present: true, detail: "granted" }],
      SHAPE
    );
    expect(satisfied).toHaveLength(1);
    expect(satisfied[0]?.detail).toBe("granted");
  });

  it("does NOT close a request whose subject is reported absent", () => {
    const satisfied = selectSatisfiedPresenceRequests(
      [{ ask: ask("a", ALPHA), key: ALPHA }],
      [{ key: ALPHA, present: false }],
      SHAPE
    );
    expect(satisfied).toEqual([]);
  });

  it("falls back to the shape's default detail when the oracle gives no status line", () => {
    const satisfied = selectSatisfiedPresenceRequests(
      [{ ask: ask("a", ALPHA), key: ALPHA }],
      [{ key: ALPHA, present: true }],
      SHAPE
    );
    expect(satisfied[0]?.detail).toBe("provisioned");
  });
});

describe("resolveSatisfiedPresenceRequests (mt#4693)", () => {
  it("closes a satisfied request and reports it", async () => {
    const closed: string[] = [];
    const result = await resolveSatisfiedPresenceRequests<RepoRole>(
      {
        listCandidateAsks: async () => [ask("a", ALPHA)],
        listPresence: async () => [{ key: ALPHA, present: true, detail: "granted" }],
        satisfy: async (a) => {
          closed.push(a.id);
        },
      },
      SHAPE
    );
    expect(result).toEqual({ pending: 1, satisfied: ["a"], raced: [] });
    expect(closed).toEqual(["a"]);
  });

  it("short-circuits without consulting the oracle when nothing is pending", async () => {
    // The oracle is a live probe for the App-grant consumer, so this is a real
    // cost saving and not just a fast path.
    let oracleCalls = 0;
    const result = await resolveSatisfiedPresenceRequests<RepoRole>(
      {
        listCandidateAsks: async () => [ask("a", null)],
        listPresence: async () => {
          oracleCalls += 1;
          return [];
        },
        satisfy: async () => {},
      },
      SHAPE
    );
    expect(result).toEqual({ pending: 0, satisfied: [], raced: [] });
    expect(oracleCalls).toBe(0);
  });

  it("records a raced close rather than throwing, and does not release its parent", async () => {
    const released: string[] = [];
    const result = await resolveSatisfiedPresenceRequests<RepoRole>(
      {
        listCandidateAsks: async () => [ask("a", ALPHA)],
        listPresence: async () => [{ key: ALPHA, present: true }],
        satisfy: async () => {
          throw new Error("ask already closed");
        },
        releaseParent: async (a) => {
          released.push(a.id);
        },
      },
      SHAPE
    );
    expect(result).toEqual({ pending: 1, satisfied: [], raced: ["a"] });
    expect(released).toEqual([]);
  });

  it("releases the parent AFTER the close, never before", async () => {
    // Ordering is load-bearing: releasing first would leave a task released
    // against a request that a raced close left open.
    const order: string[] = [];
    await resolveSatisfiedPresenceRequests<RepoRole>(
      {
        listCandidateAsks: async () => [ask("a", ALPHA)],
        listPresence: async () => [{ key: ALPHA, present: true }],
        satisfy: async () => {
          order.push("satisfy");
        },
        releaseParent: async () => {
          order.push("release");
        },
      },
      SHAPE
    );
    expect(order).toEqual(["satisfy", "release"]);
  });

  it("is idempotent: a second pass over now-terminal rows does nothing", async () => {
    const result = await resolveSatisfiedPresenceRequests<RepoRole>(
      {
        listCandidateAsks: async () => [ask("a", ALPHA, "closed")],
        listPresence: async () => [{ key: ALPHA, present: true }],
        satisfy: async () => {
          throw new Error("must not be called for a terminal row");
        },
      },
      SHAPE
    );
    expect(result).toEqual({ pending: 0, satisfied: [], raced: [] });
  });
});
