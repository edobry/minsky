/**
 * GitHubAppTokenProvider
 *
 * Implements TokenProvider for GitHub App authentication. Signs JWTs with
 * the app's RSA private key, exchanges them for installation access tokens,
 * and caches those tokens until they are close to expiry.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenProvider } from "./token-provider";

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

export class GitHubAppTokenProvider implements TokenProvider {
  private readonly appId: number;
  private readonly privateKeyFile: string | undefined;
  private readonly privateKey: string | undefined;
  private readonly installationId: number;
  private readonly userToken: string;
  private readonly privateKeyLoader: () => string;

  private cachedToken: CachedInstallationToken | null = null;
  private cachedAppInfo: GitHubAppInfo | null = null;
  private privateKeyCache: string | null = null;

  constructor(config: GitHubAppConfig) {
    this.appId = config.appId;
    this.privateKeyFile = config.privateKeyFile;
    this.privateKey = config.privateKey;
    this.installationId = config.installationId;
    this.userToken = config.userToken;
    this.privateKeyLoader = config.privateKeyLoader ?? (() => this.resolvePrivateKey());
  }

  // ---------------------------------------------------------------------------
  // TokenProvider implementation
  // ---------------------------------------------------------------------------

  async getServiceToken(repo?: string): Promise<string> {
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

  async getUserToken(): Promise<string> {
    return this.userToken;
  }

  async getServiceIdentity(): Promise<{ login: string; type: "app" | "user" } | null> {
    if (this.cachedAppInfo) {
      return this.cachedAppInfo;
    }

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
    this.cachedAppInfo = {
      login: `${data.slug}[bot]`,
      type: "app",
    };
    return this.cachedAppInfo;
  }

  isServiceAccountConfigured(): boolean {
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
    const signature = sign.sign(this.privateKeyLoader(), "base64url");

    return `${signingInput}.${signature}`;
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
