/**
 * Tests for the pgvector migration preflight (mt#5016).
 *
 * The load-bearing cases are the two ASYMMETRIES this module encodes, because
 * both are easy to "simplify" away later:
 *
 * 1. `unavailable` and `inconclusive` are distinct, and only the first throws.
 *    A preflight that blocked on an unparseable catalog read would invent a new
 *    way to break migrations in exchange for a better error message.
 * 2. `installed` and `available` BOTH pass. The ordinary fresh-container case is
 *    `available` — pgvector on disk, not yet created — and the bootstrap
 *    snapshot's own `CREATE EXTENSION IF NOT EXISTS` is what creates it.
 */

import { describe, test, expect } from "bun:test";
import {
  classifyPgvectorAvailability,
  probePgvectorAvailability,
  assertPgvectorAvailableForMigration,
  pgvectorUnavailableMessage,
  PgvectorUnavailableError,
  PGVECTOR_UNAVAILABLE_SUMMARY,
  PGVECTOR_DOCKER_IMAGE,
  PLAIN_POSTGRES_IMAGE,
  PGVECTOR_APT_PACKAGE,
  POSTGRES_MAJOR_VERSION,
  postgresMajorFromPgvectorImage,
  PGVECTOR_AVAILABILITY_QUERY,
  type PgvectorProbeClient,
} from "./pgvector-preflight";

/** A client that answers the availability probe with fixed rows. */
function clientReturning(rows: unknown): PgvectorProbeClient {
  return { unsafe: () => Promise.resolve(rows) };
}

/** A client whose query rejects — a dropped connection, an unreadable catalog. */
function clientThrowing(): PgvectorProbeClient {
  return { unsafe: () => Promise.reject(new Error("connection terminated")) };
}

describe("classifyPgvectorAvailability", () => {
  test("installed short-circuits regardless of the available column", () => {
    expect(classifyPgvectorAvailability([{ installed: true, available: false }])).toBe("installed");
  });

  test("not installed but available — the ordinary fresh-container case", () => {
    expect(classifyPgvectorAvailability([{ installed: false, available: true }])).toBe("available");
  });

  test("neither installed nor available — the failure this module names", () => {
    expect(classifyPgvectorAvailability([{ installed: false, available: false }])).toBe(
      "unavailable"
    );
  });

  // The strictness below mirrors vector-capability-probe.ts: a driver returning
  // "f" / 0 / null is not ASSERTING that pgvector is missing, and reading any of
  // those as false is the collapse both modules exist to prevent. Here the
  // consequence is worse than a bad provider — it is a refused migration.
  test.each([
    ["no rows", []],
    ["a non-array result", { installed: false, available: false }],
    ["a null first row", [null]],
    ["a missing installed column", [{ available: false }]],
    ["a string 'f' for installed", [{ installed: "f", available: false }]],
    ["a numeric 0 for installed", [{ installed: 0, available: false }]],
    ["installed false with a missing available column", [{ installed: false }]],
    ["installed false with a string available", [{ installed: false, available: "f" }]],
  ])("%s reads as inconclusive, never unavailable", (_label, rows) => {
    expect(classifyPgvectorAvailability(rows)).toBe("inconclusive");
  });
});

describe("probePgvectorAvailability", () => {
  test("issues the availability query and classifies its result", async () => {
    const seen: string[] = [];
    const sql: PgvectorProbeClient = {
      unsafe: (query: string) => {
        seen.push(query);
        return Promise.resolve([{ installed: false, available: true }]);
      },
    };
    expect(await probePgvectorAvailability(sql)).toBe("available");
    expect(seen).toEqual([PGVECTOR_AVAILABILITY_QUERY]);
  });

  test("queries BOTH catalogs — pg_extension and pg_available_extensions", () => {
    // The distinction is the module's reason to exist: pg_extension answers
    // "installed here", pg_available_extensions answers "installable at all",
    // and only the second one decides whether a migration can run.
    expect(PGVECTOR_AVAILABILITY_QUERY).toContain("pg_extension");
    expect(PGVECTOR_AVAILABILITY_QUERY).toContain("pg_available_extensions");
  });

  test("a rejecting client is inconclusive, not unavailable", async () => {
    expect(await probePgvectorAvailability(clientThrowing())).toBe("inconclusive");
  });
});

describe("assertPgvectorAvailableForMigration", () => {
  test("throws only when the server explicitly cannot load pgvector", async () => {
    await expect(
      assertPgvectorAvailableForMigration(clientReturning([{ installed: false, available: false }]))
    ).rejects.toBeInstanceOf(PgvectorUnavailableError);
  });

  test.each([
    ["installed", [{ installed: true, available: true }]],
    ["available but not yet created", [{ installed: false, available: true }]],
    ["inconclusive rows", []],
  ])("passes on %s", async (_label, rows) => {
    expect(await assertPgvectorAvailableForMigration(clientReturning(rows))).toBeUndefined();
  });

  test("a rejecting probe never blocks a migration", async () => {
    expect(await assertPgvectorAvailableForMigration(clientThrowing())).toBeUndefined();
  });
});

describe("pgvectorUnavailableMessage", () => {
  // SC3: the failure must name the CAUSE and the REMEDY. Postgres's own hint
  // already names the cause; the remedy is the half only Minsky can supply,
  // because only Minsky knows which image it should have told you to run.
  test("names the replacement image as the remedy", () => {
    expect(pgvectorUnavailableMessage()).toContain(PGVECTOR_DOCKER_IMAGE);
  });

  test("names pgvector and the setup command that prints the fixed one-liner", () => {
    const message = pgvectorUnavailableMessage();
    expect(message).toContain("pgvector");
    expect(message).toContain("minsky setup db");
  });

  test("covers the hosted-Postgres case, not just local Docker", () => {
    expect(pgvectorUnavailableMessage()).toContain("CREATE EXTENSION vector;");
  });

  test("the error carries the summary, not a bare class name", () => {
    expect(new PgvectorUnavailableError().message).toBe(PGVECTOR_UNAVAILABLE_SUMMARY);
  });
});

// These four exist because the first live run of this preflight PASSED every
// test above and still showed the operator nothing useful. `handleCliError`'s
// default branch renders `msg.split("\n")[0]` capped at 300 chars, so the
// multi-line message the error originally carried was cut after its opening
// clause — cause visible, remedy gone, which is precisely what SC3 asks for and
// exactly what shipped would have failed to deliver. Unit tests asserting the
// message's CONTENT cannot see that; only its SHAPE gives it away.
describe("PGVECTOR_UNAVAILABLE_SUMMARY survives the CLI's first-line truncation", () => {
  test("is a single line", () => {
    expect(PGVECTOR_UNAVAILABLE_SUMMARY).not.toContain("\n");
  });

  test("fits inside handleCliError's 300-character cap", () => {
    expect(PGVECTOR_UNAVAILABLE_SUMMARY.length).toBeLessThanOrEqual(300);
  });

  // The half that gets lost first is the remedy, so assert the remedy — not the
  // cause, which is the part that survives any truncation by virtue of position.
  test("names the remedy image, not just the cause", () => {
    expect(PGVECTOR_UNAVAILABLE_SUMMARY).toContain(PGVECTOR_DOCKER_IMAGE);
  });

  test("still names the cause", () => {
    expect(PGVECTOR_UNAVAILABLE_SUMMARY).toContain("pgvector is not available");
  });
});

// PR #3678 R1. The reviewer caught `PGVECTOR_UNAVAILABLE_SUMMARY` hard-coding
// `postgres:17` beside an interpolated PGVECTOR_DOCKER_IMAGE — a drift vector
// inside the mechanism built to prevent drift. A class scan found three more:
// the detail message's contrasted tag, its apt package name (which encodes the
// same major), and the wizard's prose. All four are derived now.
describe("every version-bearing string derives from PGVECTOR_DOCKER_IMAGE", () => {
  test.each([
    ["pgvector/pgvector:pg17", "17"],
    ["pgvector/pgvector:pg16", "16"],
    ["pgvector/pgvector:pg18-trixie", "18"],
    ["pgvector/pgvector:pg15-bookworm", "15"],
  ])("parses %s as major %s", (image, expected) => {
    expect(postgresMajorFromPgvectorImage(image)).toBe(expected);
  });

  // Throws rather than defaulting: a silently wrong major prints a confidently
  // wrong remedy, which is worse than the visibly-stale literal it replaced.
  test.each([
    ["a plain postgres image", "postgres:17"],
    ["a floating tag", "pgvector/pgvector:latest"],
    ["no tag at all", "pgvector/pgvector"],
    ["an empty string", ""],
    ["a non-numeric major", "pgvector/pgvector:pgXX"],
  ])("throws on %s", (_label, image) => {
    expect(() => postgresMajorFromPgvectorImage(image)).toThrow(
      /Cannot derive a Postgres major version/
    );
  });

  test("the plain image and apt package both carry the derived major", () => {
    expect(PLAIN_POSTGRES_IMAGE).toBe(`postgres:${POSTGRES_MAJOR_VERSION}`);
    expect(PGVECTOR_APT_PACKAGE).toBe(`postgresql-${POSTGRES_MAJOR_VERSION}-pgvector`);
  });

  // THIS is the assertion that would have caught R1. Every content assertion in
  // this file passed while the summary said "plain postgres:17" next to a
  // templated pg17 image — they agreed by coincidence, and a bump to pg18 would
  // have silently broken the agreement without failing anything. Scanning for a
  // major that is NOT the derived one catches the disagreement itself.
  test.each([
    ["the one-line summary", () => PGVECTOR_UNAVAILABLE_SUMMARY],
    ["the multi-line detail", () => pgvectorUnavailableMessage()],
  ])("%s mentions no Postgres major other than the derived one", (_label, produce) => {
    const foreign = new Set<string>();
    for (const match of produce().matchAll(/postgres(?:ql)?[:-](\d+)/gi)) {
      const major = match[1];
      if (major !== undefined && major !== POSTGRES_MAJOR_VERSION) foreign.add(major);
    }
    expect([...foreign]).toEqual([]);
  });
});
