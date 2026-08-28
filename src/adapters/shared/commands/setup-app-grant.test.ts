/**
 * Tests for `setup`'s App-grant request filing (mt#4693).
 *
 * These cover the two success criteria whose logic lives in the ADAPTER rather
 * than the domain, and which are the easiest in the whole feature to get
 * silently wrong:
 *
 *  - a probe that could not run (`unknown`) must file NOTHING, because telling
 *    an operator to grant access they already have wastes the trip;
 *  - an ask the router auto-resolved in-policy must not be counted as filed,
 *    because it produces a request that never resolves while reading as settled.
 *
 * `fileAppGrantRequests` takes its repository as a parameter precisely so both
 * are assertable against a fake instead of the real persistence stack.
 */
import { describe, test, expect } from "bun:test";

import type { Ask } from "@minsky/domain/ask/types";
import type { AskRepository } from "@minsky/domain/ask/repository";
import type { AppRoleCoverage } from "@minsky/domain/setup/app-coverage";
import { APP_GRANT_REQUEST_METADATA_KEY } from "@minsky/domain/setup/app-grant-request";
import { fileAppGrantRequests, renderCoverageLines } from "./setup";

const UNGRANTED_REPO = "edobry/peezombie.me";

const UNCOVERED: AppRoleCoverage = {
  role: "implementer",
  slug: "minsky-ai",
  installationId: 125403046,
  settingsUrl: "https://github.com/settings/installations/125403046",
  status: { state: "not-covered", repo: UNGRANTED_REPO, coveredCount: 1 },
};

const UNKNOWN: AppRoleCoverage = {
  role: "implementer",
  slug: "minsky-ai",
  status: { state: "unknown", reason: "503 Service Unavailable" },
};

/** A repository that records creates and hands back whatever ask the test wants. */
function fakeRepo(opts: { existing?: Ask[]; routingTarget?: string }): {
  repo: AskRepository;
  created: string[];
} {
  const created: string[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let n = 0;
  return {
    created,
    repo: {
      listByState: async () => opts.existing ?? [],
      create: async (params: Record<string, unknown>) => {
        n += 1;
        created.push(String(params.title));
        const row = { id: `ask-${n}`, routingTarget: "operator", ...params };
        rows.set(row.id, row);
        return row as unknown as Ask;
      },
      // The real create path routes the ask and then persists the outcome; the
      // returned row is what the caller reads `routingTarget` off, so the fake
      // has to honour that rather than stopping at `create`.
      persistRouteOutcome: async (id: string, write: Record<string, unknown>) => {
        const row = { ...(rows.get(id) ?? { id }), ...write };
        if (opts.routingTarget) row.routingTarget = opts.routingTarget;
        rows.set(id, row);
        return row as unknown as Ask;
      },
    } as unknown as AskRepository,
  };
}

function openGrantAsk(repo: string, role: string): Ask {
  return {
    id: "existing",
    kind: "authorization.approve",
    state: "suspended",
    createdAt: new Date("2026-08-27T00:00:00Z"),
    metadata: { [APP_GRANT_REQUEST_METADATA_KEY]: { repo, role, slug: "minsky-ai" } },
  } as unknown as Ask;
}

describe("fileAppGrantRequests (mt#4693)", () => {
  test("files nothing when persistence is unavailable, rather than throwing", async () => {
    // `setup` is the command that CONFIGURES the database, and an operator can
    // decline that step — so this degrades to the printed message.
    expect(await fileAppGrantRequests([UNCOVERED], null)).toEqual({ filed: [], policyClosed: [] });
  });

  test("a failed probe files NOTHING — `unknown` is not a missing grant", async () => {
    const { repo, created } = fakeRepo({});
    const outcome = await fileAppGrantRequests([UNKNOWN], repo);

    expect(outcome).toEqual({ filed: [], policyClosed: [] });
    expect(created).toEqual([]);
  });

  test("does not file a second request when one is already open (idempotency)", async () => {
    const { repo, created } = fakeRepo({
      existing: [openGrantAsk(UNGRANTED_REPO, "implementer")],
    });

    expect(await fileAppGrantRequests([UNCOVERED], repo)).toEqual({
      filed: [],
      policyClosed: [],
    });
    expect(created).toEqual([]);
  });

  test("an open request for the OTHER role does not suppress this one", async () => {
    const { repo, created } = fakeRepo({
      existing: [openGrantAsk(UNGRANTED_REPO, "reviewer")],
    });

    expect((await fileAppGrantRequests([UNCOVERED], repo)).filed).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  test("a policy-closed ask is NOT counted as filed", async () => {
    // The router can auto-resolve `authorization.approve` in-policy (mt#3233).
    // Because this resolves by coverage presence, that yields a request which
    // never resolves while the row reads as settled — reporting it as filed
    // would tell the operator a request exists that nobody will ever answer.
    const { repo } = fakeRepo({ routingTarget: "policy" });

    const outcome = await fileAppGrantRequests([UNCOVERED], repo);

    // Not filed...
    expect(outcome.filed).toEqual([]);
    // ...and REPORTED, so the caller can say so in the operator's own output.
    // Silently returning an empty list is what R2 flagged: setup would look
    // successful while no actionable request existed.
    expect(outcome.policyClosed).toHaveLength(1);
    expect(outcome.policyClosed[0]?.slug).toBe("minsky-ai");
  });
});

describe("renderCoverageLines (mt#4693, PR #3418 R2)", () => {
  test("a POLICY-CLOSED request is stated in the operator's own output", () => {
    // The finding this exists for: logging a warning and returning an empty
    // filed-list left `setup` looking successful while no actionable request
    // existed. The operator has to be told, where they are already reading.
    const lines = renderCoverageLines([UNCOVERED], {
      filed: [],
      policyClosed: [UNCOVERED],
    });
    const text = lines.join("\n");

    expect(text).toContain("COULD NOT file a grant request");
    expect(text).toContain("minsky-ai");
    expect(text).toContain("never resolve");
    // ...and it tells them what to do instead.
    expect(text).toContain("https://github.com/settings/installations/125403046");
    expect(text).toContain("re-run");
  });

  test("degrades to prose guidance when no settings link is available", () => {
    const noLink = { ...UNCOVERED, settingsUrl: undefined };
    const text = renderCoverageLines([noLink], { filed: [], policyClosed: [noLink] }).join("\n");

    expect(text).toContain("COULD NOT file a grant request");
    expect(text).not.toContain("https://");
    expect(text).toContain("Repository access");
  });

  test("a successfully filed request says so, and says there is nothing to confirm", () => {
    const text = renderCoverageLines([UNCOVERED], {
      filed: ["ask-1"],
      policyClosed: [],
    }).join("\n");

    expect(text).toContain("Tracked as an open request");
    expect(text).toContain("nothing to confirm");
    expect(text).not.toContain("COULD NOT");
  });

  test("nothing reportable produces no lines at all — the common path stays quiet", () => {
    expect(renderCoverageLines([], { filed: [], policyClosed: [] })).toEqual([]);
  });
});
