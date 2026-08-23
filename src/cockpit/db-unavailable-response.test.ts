/**
 * mt#4125 — two separate concerns, deliberately in one file.
 *
 * 1. `respondIfDatabaseUnavailable` DISCRIMINATES: a database outage answers
 *    503, anything else is left to the caller's own 500 branch.
 * 2. The cockpit HTTP layer has ADOPTED it. Without this, the sweep is a
 *    one-time cleanup and site 43 arrives unclassified — which is how the
 *    predicate ended up with 3 adopters against 42 sites in the first place.
 */

import { describe, test, expect } from "bun:test";
// The adoption guard's SUBJECT is the repository's own source text; reading it IS the
// measurement, not an incidental dependency an in-memory mock could stand in for. A fixture
// would only assert that the fixture adopts the branch.
// eslint-disable-next-line custom/no-real-fs-in-tests -- see note above
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { Response } from "express";
import { respondIfDatabaseUnavailable } from "./db-unavailable-response";

/**
 * A stand-in for the pair of statements the real route hands us. Injected as a
 * value rather than patched onto a real `Response` — the function takes the
 * response as a parameter precisely so this needs no patching (ADR-036).
 */
function fakeRes(headersSent = false): {
  res: Response;
  calls: { status?: number; body?: unknown };
} {
  const calls: { status?: number; body?: unknown } = {};
  const res = {
    headersSent,
    status(code: number) {
      calls.status = code;
      return this;
    },
    json(body: unknown) {
      calls.body = body;
      return this;
    },
  };
  return { res: res as unknown as Response, calls };
}

/** The shape observed live in mt#4086: drizzle wraps the driver error. */
function poolExhaustionError(): Error {
  const pg = new Error(
    "(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15"
  );
  pg.name = "PostgresError";
  const wrapped = new Error(
    'Failed query: select "session", "repo_name" from "sessions"\nparams: ',
    { cause: pg }
  );
  wrapped.name = "DrizzleQueryError";
  return wrapped;
}

describe("respondIfDatabaseUnavailable (mt#4125)", () => {
  test("answers 503 for a drizzle-wrapped pool exhaustion", async () => {
    const { res, calls } = fakeRes();

    const handled = await respondIfDatabaseUnavailable(res, poolExhaustionError(), "test");

    expect(handled).toBe(true);
    expect(calls.status).toBe(503);
    expect(calls.body).toHaveProperty("error");
  });

  test("answers 503 for a bare driver error, not only the wrapped form", async () => {
    const bare = new Error("(EMAXCONNSESSION) max clients reached in session mode");
    bare.name = "PostgresError";
    const { res, calls } = fakeRes();

    expect(await respondIfDatabaseUnavailable(res, bare, "test")).toBe(true);
    expect(calls.status).toBe(503);
  });

  test("leaves an unrelated error to the caller's 500 branch", async () => {
    const { res, calls } = fakeRes();

    const handled = await respondIfDatabaseUnavailable(res, new Error("boom"), "test");

    // The discrimination is the whole point: were this true, every handler bug
    // would be reported to the operator as a database outage.
    expect(handled).toBe(false);
    expect(calls.status).toBeUndefined();
    expect(calls.body).toBeUndefined();
  });

  test("the log carries the CAUSE CHAIN, not just the wrapper's message", async () => {
    const { res } = fakeRes();
    const logged: { message: string; meta: Record<string, unknown> }[] = [];

    await respondIfDatabaseUnavailable(res, poolExhaustionError(), "test", {
      logWarn: (message, meta) => logged.push({ message, meta }),
      describeUnavailability: async () => "stub",
    });

    // The whole point of routing through getLoggableErrorSummary: a drizzle
    // wrapper's own message is the QUERY TEXT, so a message-only log names the
    // statement and never the reason (mt#4086 cost a live capture to this).
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.meta["error"])).toContain("EMAXCONNSESSION");
    expect(String(logged[0]?.meta["error"])).toContain("caused by");
  });

  test("the 503 body carries the persistence description", async () => {
    const { res, calls } = fakeRes();

    await respondIfDatabaseUnavailable(res, poolExhaustionError(), "test", {
      logWarn: () => {},
      describeUnavailability: async () => "the pooler refused the connection",
    });

    expect((calls.body as { error: string }).error).toContain("the pooler refused the connection");
  });

  test("reports handled without writing when the response is already committed", async () => {
    const { res, calls } = fakeRes(true);

    // The SSE live-tail handlers can reach their catch after streaming has
    // begun; writing a status there would throw.
    expect(await respondIfDatabaseUnavailable(res, poolExhaustionError(), "test")).toBe(true);
    expect(calls.status).toBeUndefined();
  });
});

/**
 * Walk the cockpit HTTP layer and assert the invariant directly, rather than
 * trusting that the one-time sweep stays swept.
 */
describe("cockpit HTTP layer adopts the database-unavailable branch (mt#4125)", () => {
  const ROOT = join(import.meta.dir);
  const FILES = [
    // eslint-disable-next-line custom/no-real-fs-in-tests -- see the import note above.
    ...readdirSync(join(ROOT, "routes"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join("routes", f)),
    "conversation-shares.ts",
    "passkey-auth.ts",
  ];

  /**
   * Split a file into its `catch` blocks by brace depth. Deliberately syntactic
   * — the invariant is "this catch considered the database", which is a
   * property of the text a maintainer reads.
   */
  function catchBlocks(source: string): string[] {
    const lines = source.split("\n");
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/\}\s*catch\s*\(/.test(lines[i] ?? "")) continue;
      let depth = 1;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && depth > 0; j++) {
        const line = lines[j] ?? "";
        depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
        if (depth > 0) body.push(line);
      }
      blocks.push(body.join("\n"));
    }
    return blocks;
  }

  /**
   * The 500s that are NOT in a catch, and therefore have no error object to
   * classify. This list IS the enumeration mt#4125's Success Criterion 2 asks
   * for — kept beside the guard rather than in prose, so that adding a new
   * unclassified 500 has to be a deliberate edit here (PR #2997 R1).
   */
  /** The call every classifying site makes; named once so the scans agree. */
  const HELPER_CALL = "respondIfDatabaseUnavailable";

  const NON_CATCH_500_EXCEPTIONS: Record<string, string> = {
    "routes/agent-focus.ts":
      "an unreachable defensive branch — `liveLocal.length > 0` is checked immediately above, " +
      "and the branch exists only to satisfy control-flow analysis. No `err` is in scope.",
  };

  test("every catch that answers 500 also classifies a database outage", () => {
    const offenders: string[] = [];

    for (const rel of FILES) {
      // `String(...)` rather than an encoding argument: this repo's `fs` types
      // resolve `readFileSync` to `string | Buffer` on every overload.
      // eslint-disable-next-line custom/no-real-fs-in-tests -- see the import note above
      const source = String(readFileSync(join(ROOT, rel)));
      for (const block of catchBlocks(source)) {
        if (!block.includes("status(500)")) continue;
        const classifies =
          block.includes(HELPER_CALL) || block.includes("isDatabaseUnavailableError");
        if (!classifies) offenders.push(rel);
      }
    }

    // A new unconditional 500 in a cockpit catch reports a database outage to
    // the operator as an application bug (mt#4086). Add the guard, or — if the
    // handler genuinely cannot reach persistence — say so in a comment beside
    // the 500 and add the file to the exceptions above with the reason.
    expect(offenders).toEqual([]);
  });

  test("every 500 OUTSIDE a catch is a declared exception with a reason", () => {
    // The catch scan above cannot see these — `tasks.ts`'s allSettled rejected
    // reason was exactly this shape and DID carry a driver error, so "not in a
    // catch" is not by itself evidence that a site is safe (PR #2997 R1).
    const undeclared: string[] = [];

    for (const rel of FILES) {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- see the import note above
      const source = String(readFileSync(join(ROOT, rel)));
      const inCatch = new Set(
        catchBlocks(source)
          .join("\n")
          .split("\n")
          .map((l) => l.trim())
      );
      const lines = source.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!line.includes("status(500)")) continue;
        if (inCatch.has(line.trim())) continue;

        // A non-catch 500 is fine when the enclosing block classified first —
        // `tasks.ts`'s allSettled branch does exactly that. Otherwise it must be
        // a declared exception.
        const preceding = lines.slice(Math.max(0, i - 25), i).join("\n");
        if (preceding.includes(HELPER_CALL)) continue;
        if (rel in NON_CATCH_500_EXCEPTIONS) continue;
        undeclared.push(`${rel}:${i + 1}`);
      }
    }

    expect(undeclared).toEqual([]);
  });

  test("the enumeration does not outlive the sites it explains", () => {
    // A stale exception is worse than none: it reads as a considered decision
    // about a site that no longer exists.
    const stale = Object.keys(NON_CATCH_500_EXCEPTIONS).filter((rel) => {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- see the import note above
      const source = String(readFileSync(join(ROOT, rel)));
      const withinCatch = catchBlocks(source).join("\n").split("status(500)").length - 1;
      return source.split("status(500)").length - 1 <= withinCatch;
    });

    expect(stale).toEqual([]);
  });

  test("the guard would notice a regression", () => {
    // Negative control for the scan itself: the detector must be able to fail.
    const regressed = `
      try {
        await thing();
      } catch (err) {
        res.status(500).json({ error: "nope" });
      }
    `;
    const blocks = catchBlocks(regressed).filter((b) => b.includes("status(500)"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.includes(HELPER_CALL)).toBe(false);
  });
});
