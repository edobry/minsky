import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { log } from "@minsky/shared/logger";
import { logPostgresNotice } from "./postgres-notice-handler";

describe("logPostgresNotice", () => {
  let debugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    debugSpy = spyOn(log, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  test("routes a well-formed NOTICE through log.debug with structured fields", () => {
    const notice = {
      severity_local: "NOTICE",
      severity: "NOTICE",
      code: "42P06",
      message: 'schema "drizzle" already exists, skipping',
      file: "schemacmds.c",
      line: "132",
      routine: "CreateSchemaCommand",
    };

    logPostgresNotice(notice);

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message, context] = debugSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('postgres notice: schema "drizzle" already exists, skipping');
    expect(context).toEqual({
      severity: "NOTICE",
      code: "42P06",
      routine: "CreateSchemaCommand",
    });
  });

  test("handles a NOTICE missing optional fields without throwing", () => {
    const minimal = { message: "something happened" };

    expect(() => logPostgresNotice(minimal)).not.toThrow();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message, context] = debugSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe("postgres notice: something happened");
    expect(context).toEqual({
      severity: undefined,
      code: undefined,
      routine: undefined,
    });
  });

  test("handles non-object payloads without throwing (defensive contract)", () => {
    expect(() => logPostgresNotice(null)).not.toThrow();
    expect(() => logPostgresNotice(undefined)).not.toThrow();
    expect(() => logPostgresNotice("a string notice")).not.toThrow();
    expect(() => logPostgresNotice(42)).not.toThrow();

    expect(debugSpy).toHaveBeenCalledTimes(4);
    // All non-object inputs share the same diagnostic-prefix string.
    for (const call of debugSpy.mock.calls) {
      expect(call[0]).toBe("postgres notice (non-object payload)");
    }
  });

  test("never throws even when log.debug itself throws (defensive contract)", () => {
    // postgres-js invokes the handler inside its own error path. A thrown
    // exception would surface as a client-side disconnect. Guarantee the
    // handler swallows internal failures.
    debugSpy = mock(() => {
      throw new Error("logger blew up");
    });

    expect(() => logPostgresNotice({ message: "doesn't matter" })).not.toThrow();
  });
});
