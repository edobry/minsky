/**
 * Tests for the entity-thread route validators (mt#3364).
 *
 * These cover the request-shape contract the panel (mt#3365) will code
 * against: which entity types are accepted today, and what a rejected request
 * gets told.
 */

import { describe, expect, test, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";

import {
  ENTITY_THREAD_SUPPORTED_TYPES,
  formatSupportedEntityTypes,
} from "@minsky/shared/entity-thread-types";
import {
  isDatabaseUnavailableError,
  isPgRetryableConnectionError,
} from "@minsky/domain/persistence/postgres-retry";
import {
  armEntityThreadBootWork,
  deriveAgentStopReason,
  deriveAgentStopReasonWithPersisted,
  describeEntityThreadArmOutcome,
  mountEntityThreadRoutes,
  parseEntityType,
  parseMessageBody,
  supportsOriginSeeding,
  type EntityThreadArmOutcome,
} from "./entity-threads";

describe("parseEntityType", () => {
  test("accepts the ask type", () => {
    expect(parseEntityType("ask")).toBe("ask");
  });

  test("accepts the task type (mt#3366)", () => {
    // Flipped from a rejection assertion when mt#3366 added `taskToEntitySeed`.
    // A type is accepted ONLY once it has an adapter — otherwise every request
    // for it 404s, which reads as "your id is wrong" rather than "not built".
    expect(parseEntityType("task")).toBe("task");
  });

  test("refuses an entity type with no seed adapter yet, and names what IS supported", () => {
    // Silently accepting these would seed an agent with an empty body — an
    // agent confidently discussing nothing. Changeset and memory are NOT merely
    // unbuilt: mt#3366 deliberately declined to mount them. The error names the
    // supported set so a caller isn't left guessing whether the type, the id,
    // or the feature is the problem.
    for (const unsupported of ["changeset", "memory", "session"]) {
      const result = parseEntityType(unsupported);
      expect(typeof result).toBe("object");
      // Asserted VERBATIM, not by substring presence (PR #2467 R1 non-blocking):
      // the supported list's order comes from the shared declaration's array, so
      // it is stable and worth pinning. A substring check would pass even if the
      // message degraded to an unordered or partial list.
      expect((result as { error: string }).error).toBe(
        `entity threads are not yet available for '${unsupported}' — supported: ask, task`
      );
    }
  });

  test("every supported type is accepted, and the list drives the message", () => {
    // Guards the drift the shared declaration exists to prevent: if a kind is
    // added to ENTITY_THREAD_SUPPORTED_TYPES without an adapter, this still
    // passes — but the accompanying buildSeedForEntity branch is what the
    // route-level 404 behavior tests cover. Here the point is that validation
    // and the advertised list cannot disagree.
    for (const supported of ENTITY_THREAD_SUPPORTED_TYPES) {
      expect(parseEntityType(supported)).toBe(supported);
      expect(formatSupportedEntityTypes()).toContain(supported);
    }
  });

  test("refuses an unknown type", () => {
    expect(typeof parseEntityType("banana")).toBe("object");
  });

  test("refuses a missing or non-string type", () => {
    expect((parseEntityType(undefined) as { error: string }).error).toContain("required");
    expect((parseEntityType("") as { error: string }).error).toContain("required");
    expect(typeof parseEntityType(42)).toBe("object");
  });
});

const CONNECTION_ENDED_CODE = "CONNECTION_ENDED";

describe("isDatabaseUnavailableError (mt#3398)", () => {
  /** The postgres-js shape: a transport-layer code, no `query` own-property. */
  function connectionError(code: string): Error {
    return Object.assign(new Error(`connection failure: ${code}`), { code });
  }

  /**
   * The Drizzle shape actually observed in the 2026-07-30 incident: the message
   * IS the query text, and `query` is an own-property with a DEFINED value —
   * which is exactly what `isPgRetryableConnectionError` rejects.
   */
  function drizzleWrapped(cause: unknown): Error {
    return Object.assign(
      new Error(
        'Failed query: select "id", "short_id" from "asks" where "asks"."id" = $1 limit $2'
      ),
      { query: 'select "id" from "asks"', cause }
    );
  }

  test("detects a bare connection error", () => {
    expect(isDatabaseUnavailableError(connectionError(CONNECTION_ENDED_CODE))).toBe(true);
    expect(isDatabaseUnavailableError(connectionError("ECONNRESET"))).toBe(true);
  });

  test("detects a connection error WRAPPED by Drizzle — the incident's actual shape", () => {
    // The load-bearing case. Calling `isPgRetryableConnectionError` directly on
    // this returns FALSE (its query-shape guard rejects it, correctly, for
    // RETRY purposes), so a fix built on that predicate alone would pass its
    // own tests and do nothing in production.
    const wrapped = drizzleWrapped(connectionError("CONNECTION_CLOSED"));
    expect(isPgRetryableConnectionError(wrapped)).toBe(false);
    expect(isDatabaseUnavailableError(wrapped)).toBe(true);
  });

  test("does NOT classify an ordinary application error as unavailable", () => {
    // Over-reporting 503 would tell an operator to wait out a handler bug that
    // will never clear on its own.
    expect(isDatabaseUnavailableError(new Error(ORDINARY_HANDLER_ERROR))).toBe(false);
    expect(isDatabaseUnavailableError(drizzleWrapped(new Error("syntax error at or near")))).toBe(
      false
    );
  });

  test("tolerates a non-error, a null cause, and a cyclic chain without spinning", () => {
    expect(isDatabaseUnavailableError(undefined)).toBe(false);
    expect(isDatabaseUnavailableError("a string")).toBe(false);
    expect(isDatabaseUnavailableError(drizzleWrapped(null))).toBe(false);

    const cyclic = new Error("outer") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isDatabaseUnavailableError(cyclic)).toBe(false);
  });

  test("finds a connection cause nested more than one level down", () => {
    expect(
      isDatabaseUnavailableError(drizzleWrapped(drizzleWrapped(connectionError("EPIPE"))))
    ).toBe(true);
  });

  test("the depth bound is a real stop, and sits above any observed nesting", () => {
    // PR #2514 R1 non-blocking asked for the rationale to be testable rather
    // than asserted in a comment. Both directions:
    //   - a chain within the bound resolves,
    //   - a chain deeper than it gives up rather than searching forever.
    // The deepest chain actually observed is 2 (Drizzle over postgres-js), so
    // the bound has ample headroom; what matters is that it terminates.
    const nest = (depth: number): unknown => {
      let err: unknown = connectionError(CONNECTION_ENDED_CODE);
      for (let i = 0; i < depth; i++) err = drizzleWrapped(err);
      return err;
    };
    expect(isDatabaseUnavailableError(nest(4))).toBe(true);
    expect(isDatabaseUnavailableError(nest(9))).toBe(false);
  });
});

describe("supportsOriginSeeding (mt#3367, PR #2493 R1 BLOCKING)", () => {
  test("asks support origin seeding", () => {
    expect(supportsOriginSeeding("ask")).toBe(true);
  });

  test("tasks do NOT — so the route must omit originSeeded rather than report false", () => {
    // Reporting `false` for a task renders "the originating conversation isn't
    // reachable", which asserts a failed lookup that never ran. That is the same
    // species of unfounded claim this task exists to remove, aimed at the
    // principal instead of the agent.
    expect(supportsOriginSeeding("task")).toBe(false);
  });

  test("origin support is a SUBSET of thread support, not the same set", () => {
    // A kind can have a thread without having an origin — exactly the task case.
    // If these two ever coincide by accident, the distinction above is lost.
    const originCapable = ENTITY_THREAD_SUPPORTED_TYPES.filter(supportsOriginSeeding);
    expect(originCapable.length).toBeGreaterThan(0);
    expect(originCapable.length).toBeLessThan(ENTITY_THREAD_SUPPORTED_TYPES.length);
  });
});

/**
 * mt#4037 — the panel's claim about a stopped agent must come from state the
 * restart could not erase (criterion 4).
 *
 * `reconnecting` is that state: boot reconciliation builds it FROM the persisted
 * `driven_sessions` row, for a row still non-terminal when the daemon stopped
 * writing. Every other status is either live, or a terminal verdict the session driver
 * wrote about itself — neither of which is evidence the cockpit killed it.
 */
describe("deriveAgentStopReason (mt#4037)", () => {
  const LOCAL_ID = "entity-thread:ask:a902cba7";

  function registryWith(record: unknown) {
    return { get: (id: string) => (id === LOCAL_ID ? record : undefined) } as never;
  }

  /** The shape boot reconciliation registers for a resumable persisted row. */
  function bootRecord(status: string) {
    return { localId: LOCAL_ID, status, proc: undefined, harnessSessionId: "1b355295" };
  }

  test("a boot-reconciled record reports the cockpit as the cause", () => {
    expect(deriveAgentStopReason(LOCAL_ID, registryWith(bootRecord("reconnecting")))).toBe(
      "cockpit-restart"
    );
  });

  test("an unresumable record says so instead", () => {
    expect(deriveAgentStopReason(LOCAL_ID, registryWith(bootRecord("unrecoverable")))).toBe(
      "unrecoverable"
    );
  });

  test("an agent that exited on its own is NOT reported as a restart kill", () => {
    // The session driver wrote its own terminal status, so the cockpit did not kill
    // it. Claiming otherwise would tell the operator to re-send at a thread
    // whose agent decided it was finished.
    expect(deriveAgentStopReason(LOCAL_ID, registryWith(bootRecord("exited")))).toBeUndefined();
    expect(deriveAgentStopReason(LOCAL_ID, registryWith(bootRecord("crashed")))).toBeUndefined();
  });

  test("no record at all is UNKNOWN, not a restart", () => {
    expect(deriveAgentStopReason(LOCAL_ID, registryWith(undefined))).toBeUndefined();
  });
});

/**
 * mt#4093 — the registry-only form above says nothing in the one case that
 * matters most after a restart: an ABSENT record.
 *
 * Boot reconciliation loads only non-terminal rows and may not run at all, so
 * "no record" is routine — and it renders identically to a thread that never
 * had an agent. The persisted row settles it, and the row is the same evidence
 * boot reconciliation would have built its record from.
 */
describe("deriveAgentStopReasonWithPersisted (mt#4093)", () => {
  const LOCAL_ID = "entity-thread:ask:a902cba7";
  const EMPTY_REGISTRY = { get: () => undefined } as never;
  const db = {} as never;

  test("an absent record falls back to the persisted row and reports the restart", async () => {
    const reason = await deriveAgentStopReasonWithPersisted(LOCAL_ID, db, {
      registry: EMPTY_REGISTRY,
      getPersisted: async () =>
        ({ localId: LOCAL_ID, status: "spawned", harnessSessionId: "1b355295" }) as never,
    });
    // A row naming a conversation IS resumable — the next message resumes it,
    // which is exactly what `cockpit-restart` already means to the panel.
    expect(reason).toBe("cockpit-restart");
  });

  test("a persisted unrecoverable verdict is reported as such", async () => {
    const reason = await deriveAgentStopReasonWithPersisted(LOCAL_ID, db, {
      registry: EMPTY_REGISTRY,
      getPersisted: async () =>
        ({ localId: LOCAL_ID, status: "unrecoverable", harnessSessionId: "1b355295" }) as never,
    });
    expect(reason).toBe("unrecoverable");
  });

  test("a row that never linked a conversation stays UNKNOWN", async () => {
    // There is nothing to resume, so telling the operator "send anything to
    // pick it back up" would be false.
    const reason = await deriveAgentStopReasonWithPersisted(LOCAL_ID, db, {
      registry: EMPTY_REGISTRY,
      getPersisted: async () =>
        ({ localId: LOCAL_ID, status: "spawned", harnessSessionId: null }) as never,
    });
    expect(reason).toBeUndefined();
  });

  test("no row at all is still UNKNOWN", async () => {
    const reason = await deriveAgentStopReasonWithPersisted(LOCAL_ID, db, {
      registry: EMPTY_REGISTRY,
      getPersisted: async () => null,
    });
    expect(reason).toBeUndefined();
  });

  test("a registry record present is answered by the registry — the store is not consulted", async () => {
    let consulted = 0;
    const registry = {
      get: (id: string) =>
        id === LOCAL_ID
          ? { localId: LOCAL_ID, status: "exited", proc: undefined, harnessSessionId: "1b355295" }
          : undefined,
    } as never;

    const reason = await deriveAgentStopReasonWithPersisted(LOCAL_ID, db, {
      registry,
      getPersisted: async () => {
        consulted += 1;
        return { localId: LOCAL_ID, status: "spawned", harnessSessionId: "1b355295" } as never;
      },
    });

    // An `exited` record is the session driver's own verdict about itself. Re-deriving
    // from the row could only disagree with it — and would turn "the agent
    // finished" into "send anything to pick it back up".
    expect(reason).toBeUndefined();
    expect(consulted).toBe(0);
  });
});

describe("parseMessageBody", () => {
  test("accepts a message and trims it", () => {
    expect(parseMessageBody({ text: "  what is this?  " })).toEqual({ text: "what is this?" });
  });

  test("refuses an empty or whitespace-only message", () => {
    // An empty message would still spawn an agent and burn a turn on nothing.
    expect((parseMessageBody({ text: "" }) as { error: string }).error).toContain("empty");
    expect((parseMessageBody({ text: "   " }) as { error: string }).error).toContain("empty");
  });

  test("refuses a body with no text field, or a non-string one", () => {
    expect((parseMessageBody({}) as { error: string }).error).toContain("required");
    expect((parseMessageBody({ text: 42 }) as { error: string }).error).toContain("required");
  });

  test("refuses a non-object body", () => {
    expect((parseMessageBody(null) as { error: string }).error).toContain("object");
    expect((parseMessageBody("hi") as { error: string }).error).toContain("object");
  });
});

/**
 * Ordering regression coverage for PR #2427 R1 (BLOCKING).
 *
 * The original handlers created the thread row — and, on POST, stored the
 * operator's turn — BEFORE checking that the entity existed, so a mistyped or
 * deleted id left orphan rows nothing could retract. These tests pin the fixed
 * ordering at BOTH sites (the reviewer flagged POST; GET had the same defect).
 */
describe("validate-before-write ordering", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
  });

  /**
   * A database that refuses every operation. Any touch is a failure, which is
   * exactly the assertion for a request that must not reach persistence: if a
   * handler writes before validating, this throws, the handler's catch turns it
   * into a 500, and the 404 expectation below fails.
   */
  function explodingDb(): unknown {
    return {
      insert: () => {
        throw new Error("db write attempted before entity validation");
      },
      execute: () => {
        throw new Error("db query attempted before entity validation");
      },
    };
  }

  async function serve(options: Parameters<typeof mountEntityThreadRoutes>[1]): Promise<string> {
    const app = express();
    app.use(express.json());
    mountEntityThreadRoutes(app, options);
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    return `http://127.0.0.1:${address.port}`;
  }

  test("GET on a nonexistent entity 404s without touching the database", async () => {
    const url = await serve({
      dbOverride: explodingDb() as never,
      loadSeed: async () => null,
    });
    const res = await fetch(`${url}/api/entity-thread/ask/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("POST to a nonexistent entity 404s without storing a thread or a turn", async () => {
    const url = await serve({
      dbOverride: explodingDb() as never,
      loadSeed: async () => null,
    });
    const res = await fetch(`${url}/api/entity-thread/ask/does-not-exist/message`, {
      method: "POST",
      headers: { "Content-Type": JSON_CONTENT_TYPE },
      body: JSON.stringify({ text: "what is this?" }),
    });
    expect(res.status).toBe(404);
  });

  test("GET on a real entity with no thread yet returns empty and still writes nothing", async () => {
    // A GET is a read: the panel polls it, so creating a row per glance would
    // mint threads for entities the principal merely looked at.
    let inserted = false;
    const readOnlyDb = {
      insert: () => {
        inserted = true;
        throw new Error("GET must not create a thread row");
      },
      execute: async () => [],
    };
    const url = await serve({
      dbOverride: readOnlyDb as never,
      loadSeed: async () => ({
        entityType: "ask" as const,
        entityId: "real",
        title: "ask#1",
        body: "q",
      }),
    });
    const res = await fetch(`${url}/api/entity-thread/ask/real`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: unknown[]; localId: string };
    expect(body.blocks).toEqual([]);
    expect(body.localId).toBe("entity-thread:ask:real");
    expect(inserted).toBe(false);
  });
});

/**
 * Route-level status classification (mt#3398, PR #2514 R1 BLOCKING).
 *
 * The predicate tests above prove the CLASSIFIER is right. They do not prove the
 * ROUTES use it — a handler could classify correctly and still answer 500. That
 * gap is the production-wiring failure class this family has hit before
 * (mt#3402: a helper existed, the callsite never supplied it, hermetic tests
 * stayed green), so the status codes are asserted over real HTTP here.
 */
const JSON_CONTENT_TYPE = "application/json";
const ORDINARY_HANDLER_ERROR = "Cannot read property 'id' of undefined";

describe("DB-unavailable status classification on the routes", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
  });

  async function serveWithFailingSeed(err: unknown): Promise<string> {
    const app = express();
    app.use(express.json());
    mountEntityThreadRoutes(app, {
      // A db handle must be PRESENT, or the pre-existing missing-handle branch
      // would return 503 for the wrong reason and the test would pass vacuously.
      dbOverride: { execute: async () => [], insert: () => ({}) } as never,
      loadSeed: async () => {
        throw err;
      },
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    return `http://127.0.0.1:${address.port}`;
  }

  /** The exact shape from the 2026-07-30 daemon log: Drizzle wrapper, pg cause. */
  function wedgedDbError(): Error {
    return Object.assign(
      new Error(
        'Failed query: select "id", "short_id" from "asks" where "asks"."id" = $1 limit $2'
      ),
      {
        query: 'select "id" from "asks"',
        cause: Object.assign(new Error("write CONNECTION_ENDED"), { code: CONNECTION_ENDED_CODE }),
      }
    );
  }

  /**
   * The guarantee mt#3398 shipped: a DB-unavailable 503 names the STORE as
   * unavailable and does NOT claim the THREAD failed — the turns are intact and
   * the agent may still be running.
   *
   * That guarantee was originally asserted by banning `/fail/i`, a sound PROXY
   * while the only failure language the message could contain was about the
   * thread. mt#3687 made the message also name WHY persistence is unavailable,
   * and that cause legitimately contains failure language about the DATABASE
   * ("persistence failed to initialize") — the actionable half, and the opposite
   * of the confusion the guard exists to prevent. So the guarantee is now
   * asserted directly rather than through the proxy. The test below pins that
   * this pattern still fires on the claims the proxy was protecting against.
   */
  const CLAIMS_THREAD_FAILED = /thread\s+(failed|is broken|could not|was lost)/i;

  test("GET answers 503 and names the store when the database is unreachable", async () => {
    const url = await serveWithFailingSeed(wedgedDbError());
    const res = await fetch(`${url}/api/entity-thread/ask/real`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    // Names the STORE as unavailable rather than claiming the thread failed —
    // the turns are intact and the agent may still be running. ("thread" itself
    // appears in the store's name, `entity-thread store`, so the meaningful
    // assertion is the absence of failure language, not of the word.)
    expect(body.error).toContain("store unavailable");
    expect(body.error).not.toMatch(CLAIMS_THREAD_FAILED);
  });

  // PR #2626 R1. The reviewer blocked on this narrowing (mt#3687 SC4), and was
  // right to: "the rationale is sound" is exactly what a weakened test always
  // sounds like. So the narrowing does not rest on the rationale — this test
  // pins that the replacement assertion still CATCHES what the original
  // protected. A guard nobody has shown can fire is not a guard.
  test("the thread-failure guard is not vacuous", () => {
    // Still rejected — these are the claims mt#3398 shipped the guard to prevent.
    for (const claim of [
      "the thread failed to load",
      "entity thread is broken",
      "the thread could not be read",
      "The Thread Was Lost",
    ]) {
      expect(claim).toMatch(CLAIMS_THREAD_FAILED);
    }
    // Accepted — names the STORE and the DATABASE cause, claims nothing about
    // the thread. This is the message the routes now emit, and the string the
    // original /fail/i proxy rejected.
    //
    // Kept in sync with `describeFailedPersistenceInit` (mt#4383 dropped the
    // "The database is unreachable" / "restart" / "reports the same failure"
    // clauses). The sample matters because this test's whole point is that the
    // narrowed guard still fires on real claims while accepting the real
    // message — a sample that has drifted from what the routes emit tests the
    // guard against a message nobody sends. Note the current wording carries
    // MORE failure vocabulary than the old one ("may well PASS while this
    // fails", "the initialization attempt that just failed"), so it is a
    // stricter exercise of a regex anchored on `thread\s+failed`.
    expect(
      "entity-thread store unavailable — Postgres IS configured, but persistence " +
        "failed to initialize: getaddrinfo ENOTFOUND. This is a degraded provider, " +
        "not a missing configuration. Note `minsky persistence check` may well PASS " +
        "while this fails: it probes the live connection, whereas this reports the " +
        "initialization attempt that just failed."
    ).not.toMatch(CLAIMS_THREAD_FAILED);
  });

  test("POST answers 503 when the database is unreachable", async () => {
    const url = await serveWithFailingSeed(wedgedDbError());
    const res = await fetch(`${url}/api/entity-thread/ask/real/message`, {
      method: "POST",
      headers: { "Content-Type": JSON_CONTENT_TYPE },
      body: JSON.stringify({ text: "what is this?" }),
    });
    expect(res.status).toBe(503);
  });

  test("GET still answers 500 for an ordinary handler error", async () => {
    // The negative control: without this, a route that returned 503 for
    // EVERYTHING would pass the two tests above.
    const url = await serveWithFailingSeed(new Error(ORDINARY_HANDLER_ERROR));
    const res = await fetch(`${url}/api/entity-thread/ask/real`);
    expect(res.status).toBe(500);
  });

  test("POST still answers 500 for an ordinary handler error", async () => {
    const url = await serveWithFailingSeed(new Error(ORDINARY_HANDLER_ERROR));
    const res = await fetch(`${url}/api/entity-thread/ask/real/message`, {
      method: "POST",
      headers: { "Content-Type": JSON_CONTENT_TYPE },
      body: JSON.stringify({ text: "what is this?" }),
    });
    expect(res.status).toBe(500);
  });
});

/**
 * Boot-work arming (mt#4133).
 *
 * Three of the four outcomes below used to produce NO operator-visible line. The `catch` logged
 * at `debug`, under the default level; and a db handle that never settled reached neither the
 * `if (db)` nor the catch, because the `await` had no bound at all — the daemon skipped its
 * pending-reply drain and transcript reconcile in silence. That is the shape mt#4103 found next
 * door, where an unsettled await left the driven-session registry empty for a daemon's whole life.
 *
 * These drive the real `armEntityThreadBootWork` on every branch that does NOT reach the db, so
 * no fake handle is passed to `schedulePendingDrain` or the reconcile. The `armed` branch is
 * covered at the describer, where the decision that matters (no second line) actually lives.
 */
describe("armEntityThreadBootWork (mt#4133)", () => {
  test("bounds a handle that never settles instead of hanging silently", async () => {
    const outcome = await armEntityThreadBootWork({
      // Never settles — the case with no bound before this change.
      getDb: () => new Promise<never>(() => {}),
      timeoutMs: 15_000,
      // Resolves immediately, so the timeout branch is exercised deterministically rather than
      // by waiting out a real 15 seconds.
      timeoutSignal: async () => ({ timedOut: true }) as const,
    });

    expect(outcome).toEqual({ kind: "timed-out", timeoutMs: 15_000 });
  });

  test("reports a rejected handle as an outcome rather than throwing out of the mount path", async () => {
    const outcome = await armEntityThreadBootWork({
      getDb: () => Promise.reject(new Error("pool exhausted")),
    });

    expect(outcome.kind).toBe("failed");
    // The cause survives into the line an operator reads — a bare "could not arm" would send
    // them back to the code to guess.
    expect(outcome.kind === "failed" && outcome.error).toContain("pool exhausted");
  });

  test("distinguishes no-persistence from a failure", async () => {
    const outcome = await armEntityThreadBootWork({ getDb: async () => null });

    expect(outcome).toEqual({ kind: "no-persistence" });
  });
});

describe("describeEntityThreadArmOutcome (mt#4133)", () => {
  test("says nothing for the armed case, because the reconcile logs its own line", () => {
    // Pins the no-double-logging decision. Without this, a later change that "helpfully" adds a
    // success line here would report one healthy boot twice and nothing would catch it.
    expect(describeEntityThreadArmOutcome({ kind: "armed" })).toBeNull();
  });

  test("warns — not debugs — on every outcome that skipped the boot work", () => {
    const outcomes: EntityThreadArmOutcome[] = [
      { kind: "no-persistence" },
      { kind: "timed-out", timeoutMs: 15_000 },
      { kind: "failed", error: "pool exhausted" },
    ];

    for (const outcome of outcomes) {
      const described = describeEntityThreadArmOutcome(outcome);
      // `warn` is the whole point: `debug` sits below the default level, which is why these were
      // invisible on a real boot.
      expect(described?.level).toBe("warn");
      expect(described?.message).toContain("entity-thread boot:");
    }
  });

  test("names the bound it exceeded, so the line is actionable on its own", () => {
    const described = describeEntityThreadArmOutcome({ kind: "timed-out", timeoutMs: 15_000 });

    expect(described?.message).toContain("15000ms");
  });

  // PR #2990 R1. The `never` check is compile-time only; a value from an older or newer build of
  // a caller still reaches the default branch at runtime. This previously returned that value
  // unchanged, so the mount site would have called `log[undefined](undefined)` and thrown inside
  // a fire-and-forget IIFE — the boot-time crash the mount-site comment promises cannot happen.
  // The cast is the point of the test: it constructs exactly the input the type system forbids.
  test("returns a usable line for an unrecognized outcome instead of the raw object", () => {
    const described = describeEntityThreadArmOutcome({
      kind: "from-a-future-build",
    } as unknown as EntityThreadArmOutcome);

    expect(described?.level).toBe("warn");
    expect(described?.message).toContain("from-a-future-build");
  });
});
