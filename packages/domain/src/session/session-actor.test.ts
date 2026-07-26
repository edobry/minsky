/**
 * mt#3103 — session live-actor primitive.
 *
 * Every row of the SC3 state table gets a test (AT1), the DB-read failure is
 * asserted to be `inconclusive` and explicitly NOT `not-live` (AT2), a
 * remote-host fresh claim is asserted `live` (AT3), and the threshold is
 * driven to opposite verdicts on one fixture to prove it is injectable (AT4).
 */
import { describe, it, expect } from "bun:test";
import type { PresenceClaim, PresenceClaimRepository } from "../presence/index";
import {
  resolveSessionActor,
  DEFAULT_SESSION_ACTOR_RECENCY_MS,
  type SessionActorDeps,
} from "./session-actor";

const SESSION_ID = "sess-mt3103";
const LOCAL_HOST = "test-host";
const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const LIVE_PID = 4242;
const DEAD_PID = 9999;

function claim(overrides: Partial<PresenceClaim> = {}): PresenceClaim {
  return {
    id: "claim-1",
    subjectKind: "session",
    subjectId: SESSION_ID,
    actorId: "agent-under-test",
    host: LOCAL_HOST,
    pid: LIVE_PID,
    lastRefreshedAt: new Date(NOW).toISOString(),
    claimedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as PresenceClaim;
}

/** Minutes-ago helper — expresses each fixture's age in the unit the threshold uses. */
function agoMs(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function deps(
  claims: PresenceClaim[] | (() => never),
  overrides: Partial<SessionActorDeps> = {}
): SessionActorDeps {
  return {
    getRepository: async () =>
      ({
        listClaims: async () => {
          if (typeof claims === "function") claims();
          return claims as PresenceClaim[];
        },
      }) as unknown as PresenceClaimRepository,
    isPidAlive: (pid: number) => pid === LIVE_PID,
    localHost: LOCAL_HOST,
    now: () => NOW,
    ...overrides,
  };
}

describe("resolveSessionActor — state table (mt#3103 SC3 / AT1)", () => {
  it("pid alive + recent refresh -> live", async () => {
    const r = await resolveSessionActor(SESSION_ID, deps([claim({ lastRefreshedAt: agoMs(1) })]));
    expect(r.verdict).toBe("live");
    expect(r.actorId).toBe("agent-under-test");
    expect(r.lastRefreshedAt).toBe(agoMs(1));
  });

  it("pid alive + STALE refresh -> inconclusive (a wedged agent is not safe to delete over)", async () => {
    const r = await resolveSessionActor(SESSION_ID, deps([claim({ lastRefreshedAt: agoMs(45) })]));
    expect(r.verdict).toBe("inconclusive");
  });

  it("pid dead + recent refresh -> live (activity outlives the recorded pid)", async () => {
    const r = await resolveSessionActor(
      SESSION_ID,
      deps([claim({ pid: DEAD_PID, lastRefreshedAt: agoMs(1) })])
    );
    expect(r.verdict).toBe("live");
  });

  it("pid dead + stale refresh -> not-live (the ONLY cell that authorizes a delete)", async () => {
    const r = await resolveSessionActor(
      SESSION_ID,
      deps([claim({ pid: DEAD_PID, lastRefreshedAt: agoMs(45) })])
    );
    expect(r.verdict).toBe("not-live");
  });

  it("pid unverifiable + stale refresh -> inconclusive, NOT not-live", async () => {
    // An unprobeable pid plus a cold claim means we learned nothing. Fail closed.
    const r = await resolveSessionActor(
      SESSION_ID,
      deps([claim({ host: "some-other-host", lastRefreshedAt: agoMs(45) })])
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.verdict).not.toBe("not-live");
  });

  it("a claim with no pid recorded is unverifiable, not dead", async () => {
    const r = await resolveSessionActor(
      SESSION_ID,
      deps([claim({ pid: undefined, lastRefreshedAt: agoMs(45) })])
    );
    expect(r.verdict).toBe("inconclusive");
  });
});

describe("resolveSessionActor — fail-closed resolution (mt#3103 SC4 / AT2)", () => {
  it("a DB read failure returns inconclusive, explicitly NOT not-live", async () => {
    const r = await resolveSessionActor(
      SESSION_ID,
      deps(() => {
        throw new Error("connection terminated unexpectedly");
      })
    );
    expect(r.verdict).toBe("inconclusive");
    expect(r.verdict).not.toBe("not-live");
    expect(r.reason).toContain("connection terminated");
  });

  it("an unavailable repository returns inconclusive, not not-live", async () => {
    const r = await resolveSessionActor(SESSION_ID, {
      getRepository: async () => null,
      localHost: LOCAL_HOST,
      now: () => NOW,
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.verdict).not.toBe("not-live");
  });

  it("a repository that throws on resolution returns inconclusive", async () => {
    const r = await resolveSessionActor(SESSION_ID, {
      getRepository: async () => {
        throw new Error("no database connection");
      },
      localHost: LOCAL_HOST,
      now: () => NOW,
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("no claim row at all returns inconclusive — absence of a claim is not evidence of absence of an actor", async () => {
    const r = await resolveSessionActor(SESSION_ID, deps([]));
    expect(r.verdict).toBe("inconclusive");
    expect(r.verdict).not.toBe("not-live");
  });

  it("an empty sessionId returns inconclusive rather than silently passing", async () => {
    const r = await resolveSessionActor("", deps([claim()]));
    expect(r.verdict).toBe("inconclusive");
  });

  it("never throws, even when every dependency misbehaves", async () => {
    const r = await resolveSessionActor(SESSION_ID, {
      getRepository: async () => {
        throw new Error("boom");
      },
      isPidAlive: () => {
        throw new Error("also boom");
      },
      localHost: LOCAL_HOST,
      now: () => NOW,
    });
    expect(r.verdict).toBe("inconclusive");
  });
});

describe("resolveSessionActor — remote-host claim (mt#3103 AT3)", () => {
  it("a FRESH claim from a different host is live: the pid check cannot see it and must not read as absence", async () => {
    const r = await resolveSessionActor(
      SESSION_ID,
      deps([claim({ host: "another-machine", pid: DEAD_PID, lastRefreshedAt: agoMs(2) })])
    );
    expect(r.verdict).toBe("live");
  });
});

describe("resolveSessionActor — threshold is injectable (mt#3103 SC5 / AT4)", () => {
  const fixture = [claim({ lastRefreshedAt: agoMs(12) })];

  it("the SAME fixture yields opposite verdicts under different thresholds", async () => {
    const strict = await resolveSessionActor(SESSION_ID, deps(fixture), {
      recencyThresholdMs: 5 * 60_000,
    });
    const loose = await resolveSessionActor(SESSION_ID, deps(fixture), {
      recencyThresholdMs: 30 * 60_000,
    });

    // 12 minutes old: stale under a 5-min ceiling, fresh under a 30-min one.
    expect(strict.verdict).toBe("inconclusive");
    expect(loose.verdict).toBe("live");
  });

  it("the documented default is 10 minutes, shorter than the 15-minute claim TTL", async () => {
    expect(DEFAULT_SESSION_ACTOR_RECENCY_MS).toBe(10 * 60 * 1000);
    // Erring short pushes borderline rows toward inconclusive, which refuses.
    expect(DEFAULT_SESSION_ACTOR_RECENCY_MS).toBeLessThan(15 * 60 * 1000);
  });

  it("applies the default when no threshold is supplied", async () => {
    const justInside = await resolveSessionActor(
      SESSION_ID,
      deps([claim({ lastRefreshedAt: agoMs(9) })])
    );
    const justOutside = await resolveSessionActor(
      SESSION_ID,
      deps([claim({ lastRefreshedAt: agoMs(11) })])
    );
    expect(justInside.verdict).toBe("live");
    expect(justOutside.verdict).toBe("inconclusive");
  });
});

describe("resolveSessionActor — multi-claim reduction", () => {
  it("one live actor makes the session live regardless of dead rows beside it", async () => {
    const r = await resolveSessionActor(
      SESSION_ID,
      deps([
        claim({ id: "c1", actorId: "dead-agent", pid: DEAD_PID, lastRefreshedAt: agoMs(90) }),
        claim({ id: "c2", actorId: "working-agent", lastRefreshedAt: agoMs(1) }),
      ])
    );
    expect(r.verdict).toBe("live");
    // The refusal must name the actor that is actually holding it, not the dead one.
    expect(r.actorId).toBe("working-agent");
  });

  it("all-dead-and-stale rows reduce to not-live", async () => {
    const r = await resolveSessionActor(
      SESSION_ID,
      deps([
        claim({ id: "c1", pid: DEAD_PID, lastRefreshedAt: agoMs(90) }),
        claim({ id: "c2", pid: DEAD_PID, lastRefreshedAt: agoMs(120) }),
      ])
    );
    expect(r.verdict).toBe("not-live");
  });
});

describe("resolveSessionActor — the repository's `stale` annotation is ignored (PR #2347 R1)", () => {
  // listClaims returns AnnotatedPresenceClaim: PresenceClaim + a `stale` boolean
  // the REPOSITORY computed against its own 15-minute TTL. This gate asks a
  // different question ("older than recencyThresholdMs?"), so reading that flag
  // would silently re-impose 15 minutes and make the injectable threshold inert.
  // These two tests pin that it is not consulted, in BOTH directions.

  it("a row annotated stale:true is still live when it is inside OUR threshold", async () => {
    const annotatedStale = { ...claim({ lastRefreshedAt: agoMs(2) }), stale: true };
    const r = await resolveSessionActor(SESSION_ID, deps([annotatedStale]));
    expect(r.verdict).toBe("live");
  });

  it("a row annotated stale:false is still not-live when it is outside OUR threshold", async () => {
    const annotatedFresh = {
      ...claim({ pid: DEAD_PID, lastRefreshedAt: agoMs(45) }),
      stale: false,
    };
    const r = await resolveSessionActor(SESSION_ID, deps([annotatedFresh]));
    expect(r.verdict).toBe("not-live");
  });
});
