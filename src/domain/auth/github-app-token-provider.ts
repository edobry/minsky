/**
 * GitHubAppTokenProvider
 *
 * Implements TokenProvider for GitHub App authentication. Signs JWTs with
 * the app's RSA private key, exchanges them for installation access tokens,
 * and caches those tokens until they are close to expiry.
 *
 * Dual-App routing: when `reviewerConfig` is supplied, `getToken("reviewer")`
 * uses the reviewer App's credentials; `getToken("implementer")` always uses
 * the implementer (primary) App. When `reviewerConfig` is absent both roles
 * fall back to the single implementer App (no regression).
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenProvider, TokenRole } from "./token-provider";

/** Per-App credentials used by SingleAppClient. */
export interface AppCredentials {
  appId: number;
  installationId: number;
  /** Path to the PEM private key file. At least one of privateKey or privateKeyFile must be set. */
  privateKeyFile?: string;
  /** Raw PEM content (e.g., from MINSKY_GITHUB_APP_PRIVATE_KEY env var). Takes precedence over privateKeyFile. */
  privateKey?: string;
  /** Optional override for loading the private key — used in tests to avoid real file I/O. */
  privateKeyLoader?: () => string;
}

/** Top-level constructor config for GitHubAppTokenProvider. */
export interface GitHubAppConfig {
  appId: number;
  /** Path to the PEM private key file. At least one of privateKey or privateKeyFile must be set. */
  privateKeyFile?: string;
  /** Raw PEM content (e.g., from MINSKY_GITHUB_APP_PRIVATE_KEY env var). Takes precedence over privateKeyFile. */
  privateKey?: string;
  installationId: number;
  userToken: string;
  /** Optional override for loading the private key — used in tests to avoid real file I/O. */
  privateKeyLoader?: () => string;
  /**
   * Reviewer App credentials. When present, `getToken("reviewer")` uses this
   * App's credentials instead of the implementer App.
   */
  reviewerConfig?: AppCredentials;
}

interface CachedInstallationToken {
  token: string;
  expiresAt: Date;
}

interface GitHubAppInfo {
  login: string;
  type: "app" | "user";
}

const GITHUB_API_BASE = "https://api.github.com";

/** Tokens expire after 1 hour; refresh when fewer than 5 minutes remain. */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// SingleAppClient — handles JWT generation + token fetching for ONE App.
// GitHubAppTokenProvider owns two of these: one for the implementer App,
// and one for the reviewer App (when configured).
// ---------------------------------------------------------------------------

class SingleAppClient {
  private readonly appId: number;
  private readonly installationId: number;
  private readonly privateKeyFile: string | undefined;
  private readonly privateKey: string | undefined;
  private readonly privateKeyLoaderFn: () => string;

  private cachedToken: CachedInstallationToken | null = null;
  private privateKeyCache: string | null = null;

  constructor(creds: AppCredentials) {
    this.appId = creds.appId;
    this.installationId = creds.installationId;
    this.privateKeyFile = creds.privateKeyFile;
    this.privateKey = creds.privateKey;
    this.privateKeyLoaderFn = creds.privateKeyLoader ?? (() => this.resolvePrivateKey());
  }

  async getToken(repo?: string): Promise<string> {
    // If a specific repo scope is requested, always fetch a fresh scoped token
    // (we don't cache per-repo tokens — only the unscoped installation token).
    if (repo) {
      return this.fetchInstallationToken(repo);
    }

    if (this.isTokenValid()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.cachedToken!.token;
    }

    const token = await this.fetchInstallationToken();
    this.cachedToken = {
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    };
    return token;
  }

  /** Expose the cached token for test introspection. */
  get _cachedToken(): CachedInstallationToken | null {
    return this.cachedToken;
  }

  /** Overwrite the cached token — used in tests to simulate near-expiry. */
  set _cachedToken(value: CachedInstallationToken | null) {
    this.cachedToken = value;
  }

  private isTokenValid(): boolean {
    if (!this.cachedToken) return false;
    const timeUntilExpiry = this.cachedToken.expiresAt.getTime() - Date.now();
    return timeUntilExpiry > REFRESH_THRESHOLD_MS;
  }

  /**
   * Resolves the private key with precedence: privateKey (inline) > privateKeyFile > error.
   * Normalizes single-line `\n`-escaped PEM form (Railway-style) to real newlines.
   */
  private resolvePrivateKey(): string {
    if (this.privateKeyCache) return this.privateKeyCache;

    if (this.privateKey) {
      // Normalize Railway-style single-line form: literal \n → real newlines
      this.privateKeyCache = this.privateKey.replace(/\\n/g, "\n");
      return this.privateKeyCache;
    }

    if (this.privateKeyFile) {
      this.privateKeyCache = this.loadPrivateKeyFromFile();
      return this.privateKeyCache;
    }

    throw new Error(
      "GitHub App private key is not configured: set MINSKY_GITHUB_APP_PRIVATE_KEY (env var) or github.serviceAccount.privateKeyFile (config file)"
    );
  }

  private loadPrivateKeyFromFile(): string {
    if (!this.privateKeyFile) {
      throw new Error(
        "GitHub App private key is not configured: set MINSKY_GITHUB_APP_PRIVATE_KEY (env var) or github.serviceAccount.privateKeyFile (config file)"
      );
    }

    const resolvedPath = this.privateKeyFile.startsWith("~/")
      ? join(homedir(), this.privateKeyFile.slice(2))
      : this.privateKeyFile;

    return readFileSync(resolvedPath, "utf8") as string;
  }

  /**
   * Generates a signed JWT for GitHub App authentication.
   * The JWT is valid for 10 minutes; GitHub accepts up to 10 minutes.
   */
  generateJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // issued 60s in the past to account for clock skew
      exp: now + 9 * 60, // expires in 9 minutes
      iss: this.appId,
    };

    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signingInput = `${header}.${body}`;

    const sign = createSign("RSA-SHA256");
    sign.update(signingInput);
    const signature = sign.sign(this.privateKeyLoaderFn(), "base64url");

    return `${signingInput}.${signature}`;
  }

  async getAppInfo(): Promise<GitHubAppInfo> {
    const jwt = this.generateJwt();
    const response = await fetch(`${GITHUB_API_BASE}/app`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub App info: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { slug: string };
    return {
      login: `${data.slug}[bot]`,
      type: "app",
    };
  }

  private async fetchInstallationToken(repo?: string): Promise<string> {
    const jwt = this.generateJwt();

    const body: Record<string, unknown> = {};
    if (repo) {
      // repo may be "owner/repo" or just "repo" — GitHub expects just the repo name
      const repoName = repo.includes("/") ? repo.split("/")[1] : repo;
      body.repositories = [repoName];
    }

    const response = await fetch(
      `${GITHUB_API_BASE}/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to create GitHub App installation token: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { token: string };
    return data.token;
  }
}

// ---------------------------------------------------------------------------
// GitHubAppTokenProvider — public API; owns two SingleAppClient instances.
// ---------------------------------------------------------------------------

export class GitHubAppTokenProvider implements TokenProvider {
  private readonly userToken: string;

  /** Client for the implementer App (minsky-ai). Always present. */
  private readonly implementerClient: SingleAppClient;

  /**
   * Client for the reviewer App (minsky-reviewer). Present only when
   * `github.reviewer.serviceAccount` is configured; null otherwise.
   */
  private readonly reviewerClient: SingleAppClient | null;

  private cachedAppInfo: GitHubAppInfo | null = null;

  constructor(config: GitHubAppConfig) {
    this.userToken = config.userToken;

    this.implementerClient = new SingleAppClient({
      appId: config.appId,
      installationId: config.installationId,
      privateKeyFile: config.privateKeyFile,
      privateKey: config.privateKey,
      privateKeyLoader: config.privateKeyLoader,
    });

    this.reviewerClient = config.reviewerConfig ? new SingleAppClient(config.reviewerConfig) : null;
  }

  // ---------------------------------------------------------------------------
  // TokenProvider implementation
  // ---------------------------------------------------------------------------

  /**
   * Role-keyed token accessor.
   *
   * - "implementer" (or undefined) → implementer App
   * - "reviewer" with reviewer App configured → reviewer App
   * - "reviewer" without reviewer App configured → implementer App (graceful fallback)
   */
  async getToken(role?: TokenRole, repo?: string): Promise<string> {
    const client = this.clientForRole(role);
    return client.getToken(repo);
  }

  /**
   * @deprecated Prefer `getToken(role?, repo?)`. Defaults to implementer role.
   */
  async getServiceToken(repo?: string): Promise<string> {
    return this.implementerClient.getToken(repo);
  }

  async getUserToken(): Promise<string> {
    return this.userToken;
  }

  async getServiceIdentity(): Promise<{ login: string; type: "app" | "user" } | null> {
    if (this.cachedAppInfo) {
      return this.cachedAppInfo;
    }

    this.cachedAppInfo = await this.implementerClient.getAppInfo();
    return this.cachedAppInfo;
  }

  isServiceAccountConfigured(): boolean {
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pass-through helpers for backward-compatible tests that call these directly.
  // ---------------------------------------------------------------------------

  /**
   * Generates a JWT for the implementer App.
   * @deprecated Tests should use the implementerClient directly. This shim is
   *   retained for backward-compatibility with existing tests.
   */
  generateJwt(): string {
    return this.implementerClient.generateJwt();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private clientForRole(role?: TokenRole): SingleAppClient {
    if (role === "reviewer" && this.reviewerClient !== null) {
      return this.reviewerClient;
    }
    // "implementer", undefined, or "reviewer" with no reviewer App configured
    return this.implementerClient;
  }
}
