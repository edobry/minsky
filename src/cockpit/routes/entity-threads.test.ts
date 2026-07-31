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

import { mountEntityThreadRoutes, parseEntityType, parseMessageBody } from "./entity-threads";

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
      expect((result as { error: string }).error).toContain(unsupported);
      expect((result as { error: string }).error).toContain("ask");
      expect((result as { error: string }).error).toContain("task");
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
      headers: { "Content-Type": "application/json" },
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
