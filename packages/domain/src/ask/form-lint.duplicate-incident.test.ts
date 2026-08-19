/**
 * mt#4312 — the `duplicate-open-incident` check, asserted against the two REAL
 * asks that produced it.
 *
 * Fixtures are sampled VERBATIM from ask#9278 and ask#9279 (mem#1020: a
 * paraphrased detector fixture can reach no matcher, and then a negative
 * assertion passes forever AND survives its own negative control). Each
 * suppression case below asserts LIVENESS first — that the input does produce
 * signature tokens — so a silent case is a real silence rather than an inert
 * fixture.
 */
import { describe, test, expect } from "bun:test";
import {
  computeFormLintMatches,
  extractIncidentSignatureTokens,
  findOverlappingIncidentAsks,
  MIN_SHARED_SIGNATURE_TOKENS,
  type FormLintInput,
} from "./form-lint";

/** ask#9278, created 2026-08-19T03:01:32Z. Verbatim excerpt. */
const ASK_9278 = `**May I run \`pg_terminate_backend\` on the ~10 wedged Supavisor backends?** It fixes this in about a minute and aborts whatever those clients were mid-transaction on — possibly another agent's in-flight commit. Shared prod state, so it is your call.

**Cause, measured:** the DB is not saturated (36 of 60 connections). The Supavisor transaction-mode pooler is: ~10 backends sit in \`active\` + \`wait_event = ClientRead\` for 835–844s on trivial queries, i.e. waiting on clients that went away while holding pool slots.`;

/** ask#9279, created 2026-08-19T03:02:12Z — 40 seconds later. Verbatim excerpt. */
const ASK_9279 = `May I run pg_terminate_backend on the 16 backends stuck in state='active', wait_event='ClientRead', older than 5 minutes?

They hold every Supavisor transaction-pooler slot, so all tasks_*/memory_*/asks_* calls time out at 60s. Postgres itself is healthy (30 conns, 0 idle-in-transaction). They hold no open transactions, so nothing rolls back.`;

/**
 * A genuinely different incident, for the no-over-fire direction.
 *
 * Carries identifiers deliberately. An earlier draft of this fixture was plain
 * prose ("the reviewer webhook is returning HTTP 502 and crash-looping…") and
 * produced ZERO signature tokens, so the no-overlap assertion below passed
 * without the comparison ever running — caught by the liveness test beside it,
 * not by review. That inertness is also a real property of the check, recorded
 * as a known false-negative class in `form-lint.ts`: an incident ask written
 * without identifiers has no signature and is never compared.
 */
const UNRELATED_INCIDENT = `\`publishCheckRun\` returns 403 because the App lacks \`checks:write\`. \`deployment_wait-for-latest\` reported SUCCESS, so the container booted, but \`assertServiceIdentity\` shows a different service answering the host.`;

/** The identifier both originating asks share — the join key AT1 turns on. */
const SHARED_TOKEN = "pg_terminate_backend";

function incidentInput(
  question: string,
  open: { shortId: string; question: string }[]
): FormLintInput {
  return {
    kind: "authorization.approve",
    question,
    options: [{ label: "Approve" }],
    forceImmediate: true,
    severity: "incident",
    openIncidentAsks: open,
  };
}

const fired = (input: FormLintInput): boolean =>
  computeFormLintMatches(input).some((m) => m.check === "duplicate-open-incident");

describe("signature-token extraction", () => {
  test("identifier-shaped tokens are signatures", () => {
    const tokens = extractIncidentSignatureTokens(ASK_9278);
    expect(tokens.has(SHARED_TOKEN)).toBe(true);
    expect(tokens.has("wait_event")).toBe(true);
    expect(tokens.has("clientread")).toBe(true);
  });

  test("long PROSE words are NOT signatures — this is the whole discriminator", () => {
    // Admitting these would make the check fire on any two incident asks at
    // once, because they are exactly what unrelated incidents share.
    const tokens = extractIncidentSignatureTokens(
      "The production connection failed and authorization was denied to the principal."
    );
    expect(tokens.size).toBe(0);
  });

  test("a short identifier is below the length floor", () => {
    expect(extractIncidentSignatureTokens("a `pg_stat` read").size).toBe(0);
  });
});

describe("AT1 — the originating pair", () => {
  test("both fixtures are LIVE: each yields signature tokens", () => {
    expect(extractIncidentSignatureTokens(ASK_9278).size).toBeGreaterThan(0);
    expect(extractIncidentSignatureTokens(ASK_9279).size).toBeGreaterThan(0);
  });

  test("ask#9279 is flagged as overlapping ask#9278", () => {
    const overlaps = findOverlappingIncidentAsks(ASK_9279, [
      { shortId: "ask#9278", question: ASK_9278 },
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.shortId).toBe("ask#9278");
    expect(overlaps[0]?.sharedTokens.length).toBeGreaterThanOrEqual(MIN_SHARED_SIGNATURE_TOKENS);
    expect(overlaps[0]?.sharedTokens).toContain(SHARED_TOKEN);
  });

  test("the check fires, and its message names the ask to go read", () => {
    const matches = computeFormLintMatches(
      incidentInput(ASK_9279, [{ shortId: "ask#9278", question: ASK_9278 }])
    );
    const match = matches.find((m) => m.check === "duplicate-open-incident");
    expect(match).toBeDefined();
    expect(match?.message).toContain("ask#9278");
    expect(match?.message).toContain(SHARED_TOKEN);
  });
});

describe("AT2 — unrelated incidents both create, unflagged", () => {
  test("a different incident does not overlap", () => {
    expect(
      fired(incidentInput(UNRELATED_INCIDENT, [{ shortId: "ask#9278", question: ASK_9278 }]))
    ).toBe(false);
  });

  test("liveness: the unrelated fixture is not silent for lack of tokens", () => {
    // Without this, the assertion above would pass on any inert string.
    expect(extractIncidentSignatureTokens(UNRELATED_INCIDENT).size).toBeGreaterThan(0);
  });
});

describe("AT3 — silence when there is nothing to duplicate", () => {
  test("no open incident asks", () => {
    expect(fired(incidentInput(ASK_9279, []))).toBe(false);
  });

  test("caller not checking at all (field omitted) stays silent", () => {
    const { openIncidentAsks: _omitted, ...rest } = incidentInput(ASK_9279, [
      { shortId: "ask#9278", question: ASK_9278 },
    ]);
    expect(fired(rest as FormLintInput)).toBe(false);
  });

  test("a non-incident ask is not checked, even on an exact subject match", () => {
    const input = incidentInput(ASK_9279, [{ shortId: "ask#9278", question: ASK_9278 }]);
    expect(fired({ ...input, severity: undefined })).toBe(false);
  });
});

describe("the two-token floor", () => {
  test("ONE shared identifier is not enough", () => {
    const a = "The `pg_terminate_backend` call is the remedy under discussion.";
    const b = "A `pg_terminate_backend` sweep was considered for a different subsystem entirely.";
    const shared = [...extractIncidentSignatureTokens(a)].filter((t) =>
      extractIncidentSignatureTokens(b).has(t)
    );
    expect(shared).toEqual([SHARED_TOKEN]);
    expect(findOverlappingIncidentAsks(a, [{ shortId: "ask#1", question: b }])).toHaveLength(0);
  });
});
