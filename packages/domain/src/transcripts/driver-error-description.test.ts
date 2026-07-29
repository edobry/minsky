/**
 * mt#3342 — `describeDriverError` must surface the Postgres failure fields that
 * Drizzle's wrapper message drops.
 *
 * Why this matters: the upsert catch used to log only
 * `getLoggableErrorSummary(err)`, which for a Drizzle failure is
 * `"Failed query: <entire SQL> params: <every bound value>"` — tens of KB of
 * params with no SQLSTATE, no constraint name, no detail. 57 corrupted rows
 * existed with no recoverable explanation of the original write error, which is
 * why the root cause had to be re-derived from source rather than read from a
 * log. These tests pin the extraction so that regression can't return silently.
 */
import { describe, test, expect } from "bun:test";
import { describeDriverError } from "./agent-transcript-ingest-service";

describe("describeDriverError (mt#3342)", () => {
  test("extracts the PG fields when they sit directly on the error", () => {
    const err = Object.assign(new Error("boom"), {
      code: "22021",
      detail: "invalid byte sequence for encoding UTF8",
      routine: "report_invalid_encoding",
    });

    expect(describeDriverError(err)).toEqual({
      code: "22021",
      detail: "invalid byte sequence for encoding UTF8",
      constraint: undefined,
      table: undefined,
      routine: "report_invalid_encoding",
    });
  });

  test("reaches through a wrapper's cause — the Drizzle shape this exists for", () => {
    // Drizzle throws its own Error whose message is the SQL+params blob and
    // attaches the driver error as `cause`. Reading only the outer error is
    // exactly the blind spot that made the original failure undiagnosable.
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "agent_transcripts_pkey",
      table: "agent_transcripts",
    });
    const wrapped = Object.assign(new Error("Failed query: insert into ... params: ..."), {
      cause: driverError,
    });

    expect(describeDriverError(wrapped)).toEqual({
      code: "23505",
      detail: undefined,
      constraint: "agent_transcripts_pkey",
      table: "agent_transcripts",
      routine: undefined,
    });
  });

  test("returns undefined for a non-PG error so callers omit the field entirely", () => {
    // A bag of nulls in the log is worse than an absent key: it reads as "we
    // looked and Postgres said nothing", when the truth is "this was never a
    // driver error".
    expect(describeDriverError(new Error("plain failure"))).toBeUndefined();
    expect(describeDriverError("not an error at all")).toBeUndefined();
    expect(describeDriverError(null)).toBeUndefined();
  });

  test("ignores empty-string PG fields rather than reporting them as present", () => {
    const err = Object.assign(new Error("boom"), { code: "", detail: "" });
    expect(describeDriverError(err)).toBeUndefined();
  });
});
