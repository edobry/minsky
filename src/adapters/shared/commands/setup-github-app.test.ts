/**
 * Tests for the `setup.github-app` shared command adapter.
 *
 * Hermetic: injects mock provisionGithubApp + provisioner factories so no
 * filesystem, browser, or GitHub API is touched.
 *
 * @see mt#1087
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { setupTestMocks } from "../../../utils/test-utils/mocking";
import { sharedCommandRegistry } from "../command-registry";
import {
  registerSetupGithubAppCommand,
  DEFAULT_PERMISSIONS,
  type SetupGithubAppDeps,
} from "./setup-github-app";
import {
  BrowserCancelledError,
  REQUIRED_APP_PERMISSIONS,
  type AppCredentials,
  type AppProvisioner,
  type CredentialStore,
} from "@minsky/domain/setup/github-app";
import { ValidationError } from "@minsky/domain/errors/index";

setupTestMocks();

const SAMPLE_CREDS: AppCredentials = {
  appId: 12345,
  slug: "test-app",
  clientId: "Iv1.abc",
  clientSecret: "secret",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  htmlUrl: "https://github.com/apps/test-app",
  installationId: 98765,
};

interface RegisterAndExecuteResult {
  result: unknown;
  provisionCalls: { name: string; force?: boolean; via: "manifest" | "wizard" }[];
  storeOutputDirs: string[];
  specs: Array<{ permissions: Record<string, string>; events: string[] }>;
}

function setupCommand(
  overrides: Partial<SetupGithubAppDeps> = {},
  scenario: { existsResult?: boolean; provisionResult?: AppCredentials | Error } = {}
): RegisterAndExecuteResult {
  const provisionCalls: RegisterAndExecuteResult["provisionCalls"] = [];
  const storeOutputDirs: string[] = [];
  const specs: RegisterAndExecuteResult["specs"] = [];

  let lastVia: "manifest" | "wizard" = "manifest";

  const fakeStore: CredentialStore = {
    exists: mock(() => Promise.resolve(scenario.existsResult ?? false)),
    read: mock(() => Promise.resolve(SAMPLE_CREDS)),
    write: mock(() => Promise.resolve(undefined)),
  };

  const fakeProvisioner: AppProvisioner = {
    provision: mock(() => {
      const r = scenario.provisionResult ?? SAMPLE_CREDS;
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    }),
  };

  const provisionMock: SetupGithubAppDeps["provisionGithubApp"] = async (opts) => {
    provisionCalls.push({ name: opts.name, force: opts.force, via: lastVia });
    specs.push({ permissions: opts.spec.permissions, events: opts.spec.events });
    if (scenario.existsResult && !opts.force) {
      return { status: "already-exists", credentials: SAMPLE_CREDS };
    }
    const credsOrErr = scenario.provisionResult ?? SAMPLE_CREDS;
    if (credsOrErr instanceof Error) throw credsOrErr;
    return { status: "created", credentials: credsOrErr };
  };

  const deps: SetupGithubAppDeps = {
    provisionGithubApp: provisionMock,
    makeStore: (outputDir) => {
      storeOutputDirs.push(outputDir);
      return fakeStore;
    },
    makeProvisioner: (via, _port) => {
      lastVia = via;
      return fakeProvisioner;
    },
    ...overrides,
  };

  registerSetupGithubAppCommand(deps);

  return { result: undefined, provisionCalls, storeOutputDirs, specs };
}

async function runCommand(params: Record<string, unknown>): Promise<unknown> {
  const cmd = sharedCommandRegistry.getCommand("setup.github-app");
  if (!cmd) throw new Error("setup.github-app command not registered");
  return cmd.execute(params, {});
}

beforeEach(() => {
  // Each test re-registers the command with its own deps. The registry
  // overwrites by id, so this is safe.
});

describe("setup.github-app adapter", () => {
  test("malformed permissions string → ValidationError", async () => {
    setupCommand();
    await expect(
      runCommand({
        name: "test-app",
        repo: "owner/repo",
        permissions: "not-a-valid-pair",
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("invalid repo (no slash) → ValidationError", async () => {
    setupCommand();
    await expect(
      runCommand({
        name: "test-app",
        repo: "no-slash",
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("invalid via → ValidationError", async () => {
    setupCommand();
    await expect(
      runCommand({
        name: "test-app",
        repo: "owner/repo",
        via: "invalid-mode",
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("happy path returns success with credentials subset", async () => {
    setupCommand();
    const result = (await runCommand({
      name: "test-app",
      repo: "owner/repo",
    })) as { success: boolean; message: string; credentials?: { appId: number } };

    expect(result.success).toBe(true);
    expect(result.message).toContain("test-app");
    expect(result.credentials?.appId).toBe(SAMPLE_CREDS.appId);
  });

  test("idempotent re-run: existing creds return already-exists message referencing --force", async () => {
    setupCommand({}, { existsResult: true });
    const result = (await runCommand({
      name: "test-app",
      repo: "owner/repo",
    })) as { success: boolean; message: string };

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/already exists/i);
    expect(result.message).toMatch(/--force/);
  });

  test("via=wizard selects wizard provisioner", async () => {
    const captured = setupCommand();
    await runCommand({
      name: "test-app",
      repo: "owner/repo",
      via: "wizard",
    });
    expect(captured.provisionCalls[0]?.via).toBe("wizard");
  });

  test("default via=manifest selects manifest provisioner", async () => {
    const captured = setupCommand();
    await runCommand({
      name: "test-app",
      repo: "owner/repo",
    });
    expect(captured.provisionCalls[0]?.via).toBe("manifest");
  });

  test("force=true forwarded to provisionGithubApp options", async () => {
    const captured = setupCommand();
    await runCommand({
      name: "test-app",
      repo: "owner/repo",
      force: true,
    });
    expect(captured.provisionCalls[0]?.force).toBe(true);
  });

  test("BrowserCancelledError from orchestrator → success:false (no throw)", async () => {
    setupCommand({}, { provisionResult: new BrowserCancelledError("user cancelled") });
    const result = (await runCommand({
      name: "test-app",
      repo: "owner/repo",
    })) as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toBe("user cancelled");
  });

  test("default permissions (no --permissions) include contents:write (mt#3218)", async () => {
    // The manifest-flow default previously granted contents:read, which never
    // matched session_commit's App-token push requirement (mt#1477) — the
    // upstream cause of the mt#3210 incident. A fresh App must be created
    // with contents:write so a first App-token push succeeds without falling
    // back to keychain credentials.
    const captured = setupCommand();
    await runCommand({
      name: "test-app",
      repo: "owner/repo",
    });
    expect(captured.specs[0]?.permissions.contents).toBe("write");
    expect(captured.specs[0]?.permissions.pull_requests).toBe("write");
  });

  test("outputDir with ~ is expanded to homedir", async () => {
    const captured = setupCommand();
    await runCommand({
      name: "test-app",
      repo: "owner/repo",
      outputDir: "~/test-config-dir",
    });
    expect(captured.storeOutputDirs[0]).not.toMatch(/^~/);
    expect(captured.storeOutputDirs[0]).toMatch(/test-config-dir$/);
  });

  test("a freshly created App is granted workflows:write (mt#3264)", async () => {
    // Without it, the new App cannot push any change under `.github/workflows/**`
    // — GitHub rejects the push server-side — which is mt#3264's originating
    // incident reproduced from scratch on every newly provisioned App.
    const captured = setupCommand();
    await runCommand({ name: "test-app", repo: "owner/repo" });

    expect(captured.specs[0]?.permissions.workflows).toBe("write");
  });
});

/**
 * mt#3264: `DEFAULT_PERMISSIONS` (what a FRESH App is created with) and
 * `REQUIRED_APP_PERMISSIONS` (what an EXISTING App is checked against) are
 * documented as "kept in lockstep" in permission-drift.ts's own doc comment.
 * Nothing asserted it, and they had diverged: the drift check could not see
 * `workflows`/`actions` at all, so `config.doctor` reported "permissions match"
 * on an App missing the permission mt#3264 exists to be about.
 */
describe("DEFAULT_PERMISSIONS ↔ REQUIRED_APP_PERMISSIONS lockstep", () => {
  const parsed = new Map<string, string>();
  for (const entry of DEFAULT_PERMISSIONS.split(",")) {
    const [scope, level] = entry.split(":");
    if (scope && level) parsed.set(scope, level);
  }

  test("DEFAULT_PERMISSIONS parses to a non-empty scope:level map", () => {
    // Guards the two tests below: if the string's shape ever changed, the loop
    // above would yield an empty map and both would pass vacuously.
    expect(parsed.size).toBe(DEFAULT_PERMISSIONS.split(",").length);
    expect(parsed.size).toBeGreaterThan(0);
  });

  test("every checked permission is one a fresh App is actually created with", () => {
    const missingFromDefaults = REQUIRED_APP_PERMISSIONS.filter(
      (required) => !parsed.has(required.scope)
    ).map((required) => required.scope);

    // A scope here means config.doctor would flag drift on an App that our own
    // creation path never asked for — a permanent false failure out of the box.
    expect(missingFromDefaults).toEqual([]);
  });

  test("every permission a fresh App is granted is one the drift check verifies", () => {
    // This is the direction that actually failed. Both `workflows:write` and
    // `actions:write` are held by the live App (read from `GET /app` 2026-08-19,
    // and `actions:write` was already present in the 2026-07-25 probe recorded in
    // mem#721) while appearing in NEITHER constant — granted out-of-band, depended
    // on by shipped code, and verified by nothing. A scope here is a grant that
    // could be revoked with the drift check staying silent.
    const checkedScopes = new Set(REQUIRED_APP_PERMISSIONS.map((required) => required.scope));
    const unverifiedGrants = [...parsed.keys()].filter((scope) => !checkedScopes.has(scope));

    expect(unverifiedGrants).toEqual([]);
  });

  test("each fresh-App grant is at least the level the drift check requires", () => {
    const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
    const underGranted = REQUIRED_APP_PERMISSIONS.filter((required) => {
      const granted = parsed.get(required.scope);
      return (granted ? (rank[granted] ?? 0) : 0) < (rank[required.level] ?? 0);
    }).map((required) => required.scope);

    expect(underGranted).toEqual([]);
  });
});
