/**
 * Unit tests for github-branch-protection.ts (mt#1957).
 *
 * Covers field mapping from GitHub API's nested-object shape (with the
 * `{enabled: bool}` envelope on most fields) to our flat BranchProtection
 * interface, plus the input-mapping in setBranchProtection.
 */

import { describe, expect, test, mock } from "bun:test";
import {
  getBranchProtection,
  setBranchProtection,
  type BranchProtection,
} from "./github-branch-protection";
import { MinskyError } from "../errors/index";

const TEST_GH = {
  owner: "test-owner",
  repo: "test-repo",
  getToken: async () => "test-token",
};

const METHOD_GET = "getBranchProtection";
const METHOD_UPDATE = "updateBranchProtection";

/**
 * Build a raw GitHub-API-shaped branch-protection response. Fields use the
 * `{enabled: bool}` envelope where the live API does.
 */
function rawProtection(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    required_status_checks: {
      strict: true,
      contexts: ["build", "Prevent Placeholder Tests"],
    },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
      require_last_push_approval: false,
    },
    restrictions: null,
    required_signatures: { enabled: false },
    required_linear_history: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
    ...overrides,
  };
}

function buildMockOctokit(opts: { protection?: Record<string, unknown> } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const protection = opts.protection ?? rawProtection();

  return {
    rest: {
      repos: {
        getBranchProtection: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: METHOD_GET, params });
          return { data: protection };
        }),
        updateBranchProtection: mock(async (params: Record<string, unknown>) => {
          calls.push({ method: METHOD_UPDATE, params });
          return { data: protection };
        }),
      },
    },
    calls,
  };
}

describe(METHOD_GET, () => {
  test("maps nested {enabled} envelopes to flat boolean fields", async () => {
    const oct = buildMockOctokit({
      protection: rawProtection({ enforce_admins: { enabled: true } }),
    });
    const result: BranchProtection = await getBranchProtection(
      TEST_GH,
      "main",
      oct as unknown as Parameters<typeof getBranchProtection>[2]
    );
    expect(result.enforce_admins).toBe(true);
    expect(result.required_signatures).toBe(false);
    expect(result.required_linear_history).toBe(false);
  });

  test("preserves required_status_checks contexts list", async () => {
    const oct = buildMockOctokit();
    const result = await getBranchProtection(
      TEST_GH,
      "main",
      oct as unknown as Parameters<typeof getBranchProtection>[2]
    );
    expect(result.required_status_checks).toMatchObject({
      strict: true,
      contexts: ["build", "Prevent Placeholder Tests"],
    });
  });

  test("maps restrictions: null to null (no restrictions)", async () => {
    const oct = buildMockOctokit();
    const result = await getBranchProtection(
      TEST_GH,
      "main",
      oct as unknown as Parameters<typeof getBranchProtection>[2]
    );
    expect(result.restrictions).toBeNull();
  });

  test("maps populated restrictions: extracts logins/slugs", async () => {
    const oct = buildMockOctokit({
      protection: rawProtection({
        restrictions: {
          users: [{ login: "alice" }, { login: "bob" }],
          teams: [{ slug: "core" }],
          apps: [{ slug: "minsky-ai" }],
        },
      }),
    });
    const result = await getBranchProtection(
      TEST_GH,
      "main",
      oct as unknown as Parameters<typeof getBranchProtection>[2]
    );
    expect(result.restrictions).toEqual({
      users: ["alice", "bob"],
      teams: ["core"],
      apps: ["minsky-ai"],
    });
  });

  test("throws MinskyError when branch is empty", async () => {
    const oct = buildMockOctokit();
    await expect(
      getBranchProtection(TEST_GH, "", oct as unknown as Parameters<typeof getBranchProtection>[2])
    ).rejects.toThrow(MinskyError);
  });

  test("calls API with the correct owner/repo/branch", async () => {
    const oct = buildMockOctokit();
    await getBranchProtection(
      TEST_GH,
      "develop",
      oct as unknown as Parameters<typeof getBranchProtection>[2]
    );
    expect(oct.calls[0]?.params).toMatchObject({
      owner: "test-owner",
      repo: "test-repo",
      branch: "develop",
    });
  });
});

describe("setBranchProtection", () => {
  test("forwards required_status_checks shape to updateBranchProtection", async () => {
    const oct = buildMockOctokit();
    await setBranchProtection(
      TEST_GH,
      "main",
      {
        required_status_checks: { strict: true, contexts: ["build"] },
        enforce_admins: true,
      },
      oct as unknown as Parameters<typeof setBranchProtection>[3]
    );
    const updateCall = oct.calls.find((c) => c.method === METHOD_UPDATE);
    expect(updateCall?.params).toMatchObject({
      branch: "main",
      required_status_checks: { strict: true, contexts: ["build"] },
      enforce_admins: true,
    });
  });

  test("nullable fields are passed as null when not provided", async () => {
    const oct = buildMockOctokit();
    await setBranchProtection(
      TEST_GH,
      "main",
      { enforce_admins: false },
      oct as unknown as Parameters<typeof setBranchProtection>[3]
    );
    const updateCall = oct.calls.find((c) => c.method === METHOD_UPDATE);
    expect(updateCall?.params.required_status_checks).toBeNull();
    expect(updateCall?.params.required_pull_request_reviews).toBeNull();
    expect(updateCall?.params.restrictions).toBeNull();
  });

  test("re-fetches state after update (returns canonical post-update view)", async () => {
    const oct = buildMockOctokit();
    await setBranchProtection(
      TEST_GH,
      "main",
      { enforce_admins: true },
      oct as unknown as Parameters<typeof setBranchProtection>[3]
    );
    // First the update, then a get for the canonical state
    expect(oct.calls.map((c) => c.method)).toEqual([METHOD_UPDATE, METHOD_GET]);
  });

  test("throws MinskyError when branch is empty", async () => {
    const oct = buildMockOctokit();
    await expect(
      setBranchProtection(
        TEST_GH,
        "",
        { enforce_admins: false },
        oct as unknown as Parameters<typeof setBranchProtection>[3]
      )
    ).rejects.toThrow(MinskyError);
  });
});
