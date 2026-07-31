/**
 * Lifecycle orchestrator tests (mt#1426).
 *
 * The lifecycle module wires real ConfigWriter + provider plugins. To keep
 * tests fast and offline:
 *   - global fetch is stubbed to control validate/test outcomes
 *   - HOME is redirected to a temp dir so config.yaml writes are isolated
 *
 * Each test cleans up its temp dir and restores HOME.
 *
 * NOTE on `custom/no-real-fs-in-tests`: this test DELIBERATELY exercises
 * real fs operations because the feature under test IS the file write
 * behavior — chmod 0600, YAML content shape, atomic backup, sibling
 * metadata file. A mock-fs would only verify the mock, not the actual
 * chmod / yaml-stringify pipeline. Same pattern as
 * `src/hooks/hook-permission-check.test.ts` and
 * `src/mcp/disconnect-tracker.test.ts`.
 */
/* eslint-disable custom/no-real-fs-in-tests -- mt#1426: testing real fs write semantics (mode 0600, yaml content, sibling metadata) is the point */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";

import { addCredential, listCredentials, recheckCredential, removeCredential } from "./lifecycle";
import {
  listInvalidations,
  __setCredentialInvalidationPersistenceProviderForTests,
} from "./invalidations";

let tempHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;
let originalFetch: typeof fetch;

interface FetchResult {
  status: number;
  body?: unknown;
  statusText?: string;
}

function setFetchSequence(results: readonly FetchResult[]): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = mock(async () => {
    const idx = counter.calls;
    counter.calls += 1;
    const r = results[idx];
    if (!r) throw new Error(`no fetch result configured for call ${idx}`);
    return new Response(r.body ? JSON.stringify(r.body) : "", {
      status: r.status,
      statusText: r.statusText ?? "",
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return counter;
}

/**
 * A hermetic provider list for `listCredentials()` calls in this file
 * (mt#2729). Maps the REAL registry (so the id set stays authoritative — no
 * hardcoded provider list to drift) but replaces telegram's `isConfigured`
 * with a fast stub. Without this, `listCredentials()` calls telegram's real
 * `isConfiguredInPulumi()`, which shells out via `Bun.spawnSync(["pulumi",
 * ...])` with no timeout — a real, un-mockable-via-fetch-stub subprocess call
 * that hangs to the 15s bun-test ceiling in CI (no `pulumi` on PATH /
 * network-blocked). Dependency injection, not `mock.module()` (banned —
 * `eslint-rules/no-global-module-mocks.js`).
 */
async function hermeticProviders() {
  const { listCredentialProviders } = await import("./providers");
  return listCredentialProviders().map((p) =>
    p.id === "telegram" ? { ...p, isConfigured: async () => false } : p
  );
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "minsky-cred-test-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CONFIG_HOME"];
  process.env["HOME"] = tempHome;
  process.env["XDG_CONFIG_HOME"] = join(tempHome, ".config");
  originalFetch = globalThis.fetch;
  // mt#2978: recheckCredential/addCredential can call notifyCredentialInvalidated
  // on a 401, whose best-effort emitPgNotify() path would otherwise construct
  // + initialize a real PersistenceService on every call. Return null so
  // emitPgNotify no-ops without ever touching the real persistence layer.
  __setCredentialInvalidationPersistenceProviderForTests(async () => null);
});

afterEach(async () => {
  __setCredentialInvalidationPersistenceProviderForTests(null);
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("addCredential", () => {
  it("supabase: validate -> store -> test happy path", async () => {
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);

    const result = await addCredential("supabase", "sbp_test_value");

    expect(result.validate.ok).toBe(true);
    expect(result.stored?.configFilePath).toMatch(/config\.yaml$/);
    expect(result.test?.ok).toBe(true);

    const configFile = result.stored?.configFilePath ?? "";
    expect(configFile).not.toBe("");
    expect(existsSync(configFile)).toBe(true);
    const parsed = parseYaml(readFileSync(configFile, "utf8") as string) as {
      supabase?: { accessToken?: string };
    };
    expect(parsed.supabase?.accessToken).toBe("sbp_test_value");
  });

  it("supabase: file mode is set to 0600 after write", async () => {
    setFetchSequence([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);
    const result = await addCredential("supabase", "sbp_x");
    expect(result.validate.ok).toBe(true);
    const storedPath = result.stored?.configFilePath;
    expect(storedPath).toBeDefined();
    const mode = statSync(storedPath as string).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does not persist when validate fails (401)", async () => {
    setFetchSequence([{ status: 401, statusText: "Unauthorized" }]);

    const result = await addCredential("supabase", "sbp_bad");
    expect(result.validate.ok).toBe(false);
    expect(result.validate.unauthorized).toBe(true);
    expect(result.stored).toBeUndefined();
    expect(result.test).toBeUndefined();

    // No config file written
    const configFile = join(tempHome, ".config", "minsky", "config.yaml");
    expect(existsSync(configFile)).toBe(false);
  });

  it("github: scope-gap is reported but credential is still stored", async () => {
    setFetchSequence([
      // validate(/user) — succeeds
      { status: 200, body: { login: "octocat" } },
      // test step 1: /user — succeeds
      { status: 200, body: { login: "octocat" } },
      // test step 2: /user/repos — 403 (scope gap)
      { status: 403, statusText: "Forbidden" },
    ]);

    const result = await addCredential("github", "ghp_scoped");
    expect(result.validate.ok).toBe(true);
    expect(result.stored).toBeDefined();
    expect(result.test?.ok).toBe(true);
    expect(result.test?.scopeGap).toBe(true);
  });

  it("rejects unknown providers", async () => {
    await expect(addCredential("nonexistent", "value")).rejects.toThrow(
      /Unknown credential provider/
    );
  });
});

describe("listCredentials", () => {
  it("returns one entry per known provider, marking configured providers", async () => {
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    await addCredential("supabase", "sbp_test");

    const listing = await listCredentials(await hermeticProviders());
    const ids = listing.map((c) => c.provider).sort();
    // Derive from the registry so this cannot go stale when providers are
    // added (it had drifted: hardcoded 3 ids while the registry held 5 —
    // already failing on main before mt#2419 added telegram). Compare against
    // the AVAILABILITY-GATED list: environment-specific providers (telegram)
    // may legitimately be absent in some environments.
    const { listCredentialProviders } = await import("./providers");
    expect(ids).toEqual(
      listCredentialProviders()
        .map((p) => p.id)
        .sort()
    );
    expect(ids).toContain("supabase");

    const supabaseEntry = listing.find((c) => c.provider === "supabase");
    expect(supabaseEntry?.configured).toBe(true);
    expect(supabaseEntry?.lastValidatedAt).toBeTruthy();

    const githubEntry = listing.find((c) => c.provider === "github");
    expect(githubEntry?.configured).toBe(false);
    expect(githubEntry?.lastValidatedAt).toBeUndefined();
  });

  it("never includes the token value in any listing field", async () => {
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    const tokenValue = "sbp_super_secret_dont_leak_me";
    await addCredential("supabase", tokenValue);

    const listing = await listCredentials(await hermeticProviders());
    const json = JSON.stringify(listing);
    expect(json.includes(tokenValue)).toBe(false);
  });
});

describe("removeCredential", () => {
  it("removes the config value and metadata", async () => {
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    await addCredential("supabase", "sbp_test");

    const before = await listCredentials(await hermeticProviders());
    expect(before.find((c) => c.provider === "supabase")?.configured).toBe(true);

    await removeCredential("supabase");

    const after = await listCredentials(await hermeticProviders());
    expect(after.find((c) => c.provider === "supabase")?.configured).toBe(false);
    expect(after.find((c) => c.provider === "supabase")?.lastValidatedAt).toBeUndefined();
  });
});

describe("recheckCredential", () => {
  it("returns configured=false when no credential is stored", async () => {
    const result = await recheckCredential("supabase");
    expect(result.configured).toBe(false);
    expect(result.test).toBeUndefined();
  });

  it("records invalidation when the stored token now returns 401", async () => {
    // First add a credential successfully.
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    await addCredential("supabase", "sbp_test");

    // Now the token has been revoked: recheck hits 401.
    setFetchSequence([{ status: 401, statusText: "Unauthorized" }]);
    const result = await recheckCredential("supabase");

    expect(result.configured).toBe(true);
    expect(result.invalidated).toBe(true);
    expect(result.test?.unauthorized).toBe(true);

    const invalidations = await listInvalidations();
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.provider).toBe("supabase");
  });

  it("clears prior invalidation on successful recheck", async () => {
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    await addCredential("supabase", "sbp_test");

    // Force a prior invalidation entry.
    setFetchSequence([{ status: 401, statusText: "Unauthorized" }]);
    await recheckCredential("supabase");
    expect((await listInvalidations()).length).toBe(1);

    // Now the token works again — recheck should clear the invalidation.
    setFetchSequence([{ status: 200, body: [{ id: "p1" }] }]);
    const result = await recheckCredential("supabase");
    expect(result.test?.ok).toBe(true);
    expect((await listInvalidations()).length).toBe(0);
  });

  it("addCredential clears any prior invalidation when validate+test succeed", async () => {
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    await addCredential("supabase", "sbp_test");

    // Manually trigger an invalidation.
    setFetchSequence([{ status: 401, statusText: "Unauthorized" }]);
    await recheckCredential("supabase");
    expect((await listInvalidations()).length).toBe(1);

    // Re-add (operator pasted a fresh token).
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    await addCredential("supabase", "sbp_new_token");

    expect((await listInvalidations()).length).toBe(0);
  });

  it("removeCredential also clears the invalidation entry", async () => {
    setFetchSequence([
      { status: 200, body: [{ id: "p1" }] },
      { status: 200, body: [{ id: "p1" }] },
    ]);
    await addCredential("supabase", "sbp_test");
    setFetchSequence([{ status: 401, statusText: "Unauthorized" }]);
    await recheckCredential("supabase");
    expect((await listInvalidations()).length).toBe(1);

    await removeCredential("supabase");
    expect((await listInvalidations()).length).toBe(0);
  });
});
