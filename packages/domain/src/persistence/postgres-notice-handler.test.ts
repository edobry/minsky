import { describe, expect, test } from "bun:test";
import { logPostgresNotice, describeNotice } from "./postgres-notice-handler";

/** Shared across this file's fixtures — drizzle's schema-create NOTICE routine. */
const CREATE_SCHEMA_COMMAND_ROUTINE = "CreateSchemaCommand";

describe("describeNotice (pure core, mt#3628)", () => {
  test("routes a well-formed NOTICE into a structured message + context", () => {
    const notice = {
      severity_local: "NOTICE",
      severity: "NOTICE",
      code: "42P06",
      message: 'schema "drizzle" already exists, skipping',
      file: "schemacmds.c",
      line: "132",
      routine: CREATE_SCHEMA_COMMAND_ROUTINE,
    };

    const entry = describeNotice(notice);

    expect(entry.message).toBe('postgres notice: schema "drizzle" already exists, skipping');
    expect(entry.context).toEqual({
      severity: "NOTICE",
      code: "42P06",
      routine: CREATE_SCHEMA_COMMAND_ROUTINE,
    });
  });

  test("handles a NOTICE missing optional fields", () => {
    const entry = describeNotice({ message: "something happened" });

    expect(entry.message).toBe("postgres notice: something happened");
    expect(entry.context).toEqual({
      severity: undefined,
      code: undefined,
      routine: undefined,
    });
  });

  test("handles non-object payloads with the diagnostic-prefix shape", () => {
    for (const payload of [null, undefined, "a string notice", 42]) {
      const entry = describeNotice(payload);
      expect(entry.message).toBe("postgres notice (non-object payload)");
      expect(entry.context).toEqual({ raw: String(payload) });
    }
  });
});

describe("logPostgresNotice", () => {
  test("wiring: routes the described entry through the injected debug sink, not spyOn(log) (mt#3628)", () => {
    const debugCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const deps = {
      debug: (message: string, meta?: Record<string, unknown>) => debugCalls.push([message, meta]),
    };

    logPostgresNotice(
      {
        severity: "NOTICE",
        code: "42P06",
        message: 'schema "drizzle" already exists, skipping',
        routine: CREATE_SCHEMA_COMMAND_ROUTINE,
      },
      deps
    );

    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0]?.[0]).toBe('postgres notice: schema "drizzle" already exists, skipping');
    expect(debugCalls[0]?.[1]).toEqual({
      severity: "NOTICE",
      code: "42P06",
      routine: CREATE_SCHEMA_COMMAND_ROUTINE,
    });
  });

  test("never throws even when the injected sink itself throws (defensive contract) — mt#3628 injected throwing fake", () => {
    // postgres-js invokes the handler inside its own error path. A thrown
    // exception would surface as a client-side disconnect. Guarantee the
    // handler swallows internal failures — exercised here via an injected
    // THROWING fake sink rather than a spy re-arm on the shared logger
    // singleton (the mechanism mt#3561 patched at the symptom level).
    const throwingDeps = {
      debug: () => {
        throw new Error("logger blew up");
      },
    };

    expect(() => logPostgresNotice({ message: "doesn't matter" }, throwingDeps)).not.toThrow();
  });

  test("defaults to the real shared logger when no deps are injected (production default)", () => {
    // No deps argument — exercises the production default path. The
    // defensive contract must still hold; describeNotice's own pure tests
    // above cover the message-shape decision independently.
    expect(() => logPostgresNotice({ message: "default-path smoke" })).not.toThrow();
    expect(() => logPostgresNotice(null)).not.toThrow();
  });
});
