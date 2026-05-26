/**
 * Tests for provisionGithubApp orchestrator.
 *
 * @see mt#1087
 */

import { describe, test, expect, mock } from "bun:test";
import { setupTestMocks } from "../../../../../src/utils/test-utils/mocking";
import { provisionGithubApp } from "./provision";
import type { CredentialStore } from "./credential-store";
import type { AppProvisioner } from "./provisioner";
import type { AppManifestSpec, AppCredentials } from "./types";

setupTestMocks();

const SAMPLE_SPEC: AppManifestSpec = {
  name: "my-app",
  repo: "owner/repo",
  owner: "owner",
  permissions: { pull_requests: "write" },
  events: [],
  inactive: false,
};

const SAMPLE_CREDS: AppCredentials = {
  appId: 1,
  slug: "my-app",
  clientId: "Iv1.abc",
  clientSecret: "secret",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  htmlUrl: "https://github.com/apps/my-app",
  installationId: 42,
};

interface MockedStore extends CredentialStore {
  exists: ReturnType<typeof mock>;
  read: ReturnType<typeof mock>;
  write: ReturnType<typeof mock>;
}

interface MockedProvisioner extends AppProvisioner {
  provision: ReturnType<typeof mock>;
}

function makeStore(existsResult: boolean, readResult: AppCredentials | null): MockedStore {
  return {
    exists: mock(() => Promise.resolve(existsResult)),
    read: mock(() => Promise.resolve(readResult)),
    write: mock(() => Promise.resolve(undefined)),
  };
}

function makeProvisioner(result: AppCredentials | Error): MockedProvisioner {
  return {
    provision:
      result instanceof Error
        ? mock(() => Promise.reject(result))
        : mock(() => Promise.resolve(result)),
  };
}

describe("provisionGithubApp", () => {
  test("force=false + exists=true short-circuits and returns already-exists without calling provisioner", async () => {
    const store = makeStore(true, SAMPLE_CREDS);
    const provisioner = makeProvisioner(SAMPLE_CREDS);

    const result = await provisionGithubApp({
      name: "my-app",
      spec: SAMPLE_SPEC,
      store,
      provisioner,
      force: false,
    });

    expect(result.status).toBe("already-exists");
    expect(result.credentials).toBe(SAMPLE_CREDS);
    expect(provisioner.provision.mock.calls).toHaveLength(0);
  });

  test("force=true calls provisioner even when credentials exist", async () => {
    const store = makeStore(true, SAMPLE_CREDS);
    const newCreds: AppCredentials = { ...SAMPLE_CREDS, appId: 999 };
    const provisioner = makeProvisioner(newCreds);

    const result = await provisionGithubApp({
      name: "my-app",
      spec: SAMPLE_SPEC,
      store,
      provisioner,
      force: true,
    });

    expect(result.status).toBe("created");
    expect(result.credentials.appId).toBe(999);
    expect(provisioner.provision.mock.calls).toHaveLength(1);
  });

  test("force=false + exists=false calls provisioner", async () => {
    const store = makeStore(false, null);
    const provisioner = makeProvisioner(SAMPLE_CREDS);

    const result = await provisionGithubApp({
      name: "my-app",
      spec: SAMPLE_SPEC,
      store,
      provisioner,
      force: false,
    });

    expect(result.status).toBe("created");
    expect(result.credentials).toBe(SAMPLE_CREDS);
    expect(provisioner.provision.mock.calls).toHaveLength(1);
    expect(store.write.mock.calls).toHaveLength(1);
  });

  test("provisioner errors propagate unchanged", async () => {
    const store = makeStore(false, null);
    const boom = new Error("provisioner exploded");
    const provisioner = makeProvisioner(boom);

    await expect(
      provisionGithubApp({
        name: "my-app",
        spec: SAMPLE_SPEC,
        store,
        provisioner,
      })
    ).rejects.toBe(boom);
  });

  test("default force=false: does not call provisioner when creds exist", async () => {
    const store = makeStore(true, SAMPLE_CREDS);
    const provisioner = makeProvisioner(SAMPLE_CREDS);

    await provisionGithubApp({ name: "my-app", spec: SAMPLE_SPEC, store, provisioner });

    expect(provisioner.provision.mock.calls).toHaveLength(0);
  });
});
