import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describeEmitFailure, DrizzleEventEmitter } from "./emitter";

/**
 * Build the error shape drizzle actually throws: `message` is only
 * `Failed query: ...`, and the driver's error hangs off `.cause`. Matches
 * `DrizzleQueryError` in `drizzle-orm/errors` — the reason the pre-mt#4131 log
 * line, which read `message` alone, could never say why a write failed.
 */
function drizzleQueryError(cause: unknown): Error {
  const err = new Error('Failed query: insert into "system_events" ...\nparams: ...');
  err.cause = cause;
  return err;
}

const CONNECTION_ENDED = "CONNECTION_ENDED";
const CONNECTION_ENDED_MESSAGE = `write ${CONNECTION_ENDED} db.example.com:6543`;

/** postgres.js `Errors.connection()`: a plain Error carrying a `code` token. */
function connectionCause(): Error {
  const err = new Error(CONNECTION_ENDED_MESSAGE);
  Object.assign(err, { code: CONNECTION_ENDED });
  return err;
}

/** postgres.js `PostgresError`: the server's own fields assigned onto the error. */
function postgresCause(): Error {
  const err = new Error('null value in column "payload" violates not-null constraint');
  Object.assign(err, {
    code: "23502",
    detail: "Failing row contains (…).",
    constraint_name: "system_events_payload_not_null",
  });
  return err;
}

function rejectingDb(err: unknown): PostgresJsDatabase {
  return {
    insert: () => ({ values: () => Promise.reject(err) }),
  } as unknown as PostgresJsDatabase;
}

describe("describeEmitFailure (mt#4131)", () => {
  test("surfaces the connection-class cause code drizzle's message hides", () => {
    const entry = describeEmitFailure(drizzleQueryError(connectionCause()), "mcp.disconnect");

    expect(entry.context.causeCode).toBe(CONNECTION_ENDED);
    expect(entry.context.causeMessage).toBe(CONNECTION_ENDED_MESSAGE);
    expect(entry.context.eventType).toBe("mcp.disconnect");
    // The wrapper message is still carried — it names the failing statement.
    expect(String(entry.context.error)).toContain("Failed query:");
  });

  test("surfaces SQLSTATE, detail and constraint for a server-rejected row", () => {
    const entry = describeEmitFailure(drizzleQueryError(postgresCause()), "ask.created");

    expect(entry.context.causeCode).toBe("23502");
    expect(entry.context.causeDetail).toBe("Failing row contains (…).");
    expect(entry.context.causeConstraint).toBe("system_events_payload_not_null");
  });

  test("omits the cause keys entirely when the error carries no cause", () => {
    const entry = describeEmitFailure(new Error("plain failure"), "pr.merged");

    expect(entry.context).toEqual({ eventType: "pr.merged", error: "plain failure" });
  });

  test("stringifies a non-Error throw rather than losing it", () => {
    const entry = describeEmitFailure("not an error", "session.started");

    expect(entry.context.error).toBe("not an error");
    expect(entry.context.causeCode).toBeUndefined();
  });

  test("carries a non-Error cause through as a string", () => {
    const err = new Error("wrapped");
    err.cause = "raw driver string";
    const entry = describeEmitFailure(err, "hook.fired");

    expect(entry.context.causeMessage).toBe("raw driver string");
    expect(entry.context.causeCode).toBeUndefined();
  });
});

describe("DrizzleEventEmitter.tryEmit (mt#4131)", () => {
  test("wiring: routes the described failure through the injected warn sink", async () => {
    const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const emitter = new DrizzleEventEmitter(rejectingDb(drizzleQueryError(connectionCause())), {
      warn: (message, meta) => warnCalls.push({ message, meta }),
    });

    const written = await emitter.tryEmit({ eventType: "mcp.disconnect", payload: {} });

    expect(written).toBe(false);
    expect(warnCalls).toHaveLength(1);
    const call = warnCalls.at(0);
    expect(call?.message).toContain("failed to emit system event");
    // The whole point of mt#4131: the driver's cause reaches the log line.
    expect(call?.meta?.causeCode).toBe(CONNECTION_ENDED);
    expect(call?.meta?.causeMessage).toBe(CONNECTION_ENDED_MESSAGE);
  });

  test("never throws, and reports success as true when the insert lands", async () => {
    const warnCalls: string[] = [];
    const db = {
      insert: () => ({ values: () => Promise.resolve() }),
    } as unknown as PostgresJsDatabase;
    const emitter = new DrizzleEventEmitter(db, { warn: (m) => warnCalls.push(m) });

    await expect(emitter.tryEmit({ eventType: "pr.merged", payload: {} })).resolves.toBe(true);
    expect(warnCalls).toHaveLength(0);
  });
});
