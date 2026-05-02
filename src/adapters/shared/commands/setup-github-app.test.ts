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
import { registerSetupGithubAppCommand, type SetupGithubAppDeps } from "./setup-github-app";
import {
  BrowserCancelledError,
  type AppCredentials,
  type AppProvisioner,
  type CredentialStore,
} from "../../../domain/setup/github-app";
import { ValidationError } from "../../../errors/index";

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
}

function setupCommand(
  overrides: Partial<SetupGithubAppDeps> = {},
  scenario: { existsResult?: boolean; provisionResult?: AppCredentials | Error } = {}
): RegisterAndExecuteResult {
  const provisionCalls: RegisterAndExecuteResult["provisionCalls"] = [];
  const storeOutputDirs: string[] = [];

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

  return { result: undefined, provisionCalls, storeOutputDirs };
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
});
