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
  mountEntityThreadRoutes,
  parseEntityType,
  parseMessageBody,
  supportsOriginSeeding,
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
    expect(body.error).not.toMatch(/fail/i);
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
