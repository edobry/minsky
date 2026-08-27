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
import { createTimeoutFetch } from "../github/octokit-timeout";

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
  /**
   * Test seam: override the bounded fetch used for JWT -> installation-token
   * exchange and app-info lookups. Defaults to `createTimeoutFetch()` (mt#2677
   * — a 30s wall-clock bound; see that module's doc comment for why an
   * unbounded `fetch` here is a real production hang, not just theoretical).
   */
  fetchImpl?: typeof fetch;
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
  /** Test seam: see `AppCredentials.fetchImpl`. Threaded to the implementer App's client. */
  fetchImpl?: typeof fetch;
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

/** Live App metadata needed for permission-drift detection (mt#3218). */
export interface GitHubAppPermissions {
  slug: string;
  permissions: Record<string, string>;
}

/** Which repositories a GitHub App installation actually covers (mt#4680). */
export interface InstallationCoverage {
  /** Every `owner/repo` this installation can currently access, lowercased. */
  repositories: string[];
  /**
   * `"all"` when the installation was granted every repository the account
   * owns — in which case `repositories` is still enumerated, but a repo absent
   * from it is a repo the account does not own rather than one left ungranted.
   */
  selection: "all" | "selected";
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
  /**
   * Bounded fetch (mt#2677): every network call this client makes (JWT ->
   * installation-token exchange, app-info lookup) goes through this instead
   * of the raw global `fetch`, so a stalled GitHub call rejects after
   * `GITHUB_REQUEST_TIMEOUT_MS` instead of hanging forever. This is the same
   * `createTimeoutFetch()` wrapper `createOctokit()` already applies to every
   * Octokit-issued request (mt#2245/mt#2270) — this class was the one caller
   * still making raw unbounded `fetch` calls.
   */
  private readonly boundedFetch: typeof fetch;

  private cachedToken: CachedInstallationToken | null = null;
  private privateKeyCache: string | null = null;

  constructor(creds: AppCredentials) {
    this.appId = creds.appId;
    this.installationId = creds.installationId;
    this.privateKeyFile = creds.privateKeyFile;
    this.privateKey = creds.privateKey;
    this.privateKeyLoaderFn = creds.privateKeyLoader ?? (() => this.resolvePrivateKey());
    this.boundedFetch = creds.fetchImpl ?? createTimeoutFetch();
  }

  async getToken(repo?: string): Promise<string> {
    // If a specific repo scope is requested, always fetch a fresh scoped token
    // (we don't cache per-repo tokens — only the unscoped installation token).
    if (repo) {
      const { token } = await this.fetchInstallationToken(repo);
      return token;
    }

    if (this.isTokenValid()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.cachedToken!.token;
    }

    const { token, expiresAt } = await this.fetchInstallationToken();
    this.cachedToken = { token, expiresAt };
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
    const response = await this.boundedFetch(`${GITHUB_API_BASE}/app`, {
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

  /**
   * Fetches the App's slug and LIVE permission set via `GET /app` — the same
   * read `getAppInfo` uses, plus the `permissions` field GitHub also returns.
   * Used for permission-drift detection (mt#3218): `GET /app` is the one
   * App-registration endpoint that actually exists and works, so it is the
   * only way to answer "does this App actually have the permission the code
   * needs" without waiting for a live call to fail with a 403 first.
   */
  async getAppPermissions(): Promise<GitHubAppPermissions> {
    const jwt = this.generateJwt();
    const response = await this.boundedFetch(`${GITHUB_API_BASE}/app`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub App info: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { slug: string; permissions?: Record<string, string> };
    return { slug: data.slug, permissions: data.permissions ?? {} };
  }

  /**
   * Enumerate the repositories this installation actually covers (mt#4680).
   *
   * Uses `GET /installation/repositories` authenticated with the INSTALLATION
   * token this provider already mints — deliberately NOT
   * `GET /user/installations/{id}/repositories`, which needs a user access
   * token Minsky does not hold and returns 403 for the configured PAT.
   *
   * That distinction is the whole point: an auth requirement measured on one
   * endpoint does not transfer to its sibling. Four separate claims that this
   * check required operator action (web UI, user-to-server OAuth, a `read:user`
   * scope, a classic PAT) were each falsified; this endpoint answers it with
   * credentials already in hand.
   *
   * Why callers want it: without a coverage check, a missing grant first
   * surfaces as a bare 404 from `pulls.create`, which is indistinguishable
   * from "the repository does not exist" and arrives only after the branch has
   * been pushed.
   */
  async getInstallationCoverage(): Promise<InstallationCoverage> {
    const token = await this.getToken();
    const repositories: string[] = [];
    let selection: "all" | "selected" = "selected";

    // Paginate explicitly rather than trusting a single page: an installation
    // granted many repositories would otherwise be silently truncated, and a
    // truncated list reads exactly like a missing grant.
    for (let page = 1; ; page++) {
      const response = await this.boundedFetch(
        `${GITHUB_API_BASE}/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `Failed to list installation repositories: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as {
        total_count?: number;
        repository_selection?: string;
        repositories?: Array<{ full_name?: string }>;
      };
      if (data.repository_selection === "all") selection = "all";

      const batch = data.repositories ?? [];
      for (const r of batch) {
        if (r.full_name) repositories.push(r.full_name.toLowerCase());
      }
      if (batch.length < 100) break;
    }

    return { repositories, selection };
  }

  private async fetchInstallationToken(repo?: string): Promise<{ token: string; expiresAt: Date }> {
    const jwt = this.generateJwt();

    const body: Record<string, unknown> = {};
    if (repo) {
      // repo may be "owner/repo" or just "repo" — GitHub expects just the repo name
      const repoName = repo.includes("/") ? repo.split("/")[1] : repo;
      body.repositories = [repoName];
    }

    const response = await this.boundedFetch(
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

    const data = (await response.json()) as { token: string; expires_at?: string };
    // Honour GitHub's actual expiry timestamp when present; fall back to a
    // 1-hour assumption only if the field is missing or unparsable. Skew + the
    // REFRESH_THRESHOLD_MS check together ensure we don't ride a token to
    // its absolute deadline.
    const expiresAt = parseExpiresAt(data.expires_at) ?? new Date(Date.now() + 60 * 60 * 1000);
    return { token: data.token, expiresAt };
  }
}

/**
 * Parses GitHub's `expires_at` ISO 8601 timestamp. Returns null if the input
 * is missing or unparseable (callers fall back to a default).
 */
function parseExpiresAt(raw: string | undefined): Date | null {
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
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

  /**
   * Per-role identity cache. Keyed by role to avoid conflating implementer
   * and reviewer App identities when both are in use.
   */
  private cachedIdentityByRole: Partial<Record<TokenRole, GitHubAppInfo>> = {};

  constructor(config: GitHubAppConfig) {
    this.userToken = config.userToken;

    this.implementerClient = new SingleAppClient({
      appId: config.appId,
      installationId: config.installationId,
      privateKeyFile: config.privateKeyFile,
      privateKey: config.privateKey,
      privateKeyLoader: config.privateKeyLoader,
      fetchImpl: config.fetchImpl,
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

  async getServiceIdentity(
    role?: TokenRole
  ): Promise<{ login: string; type: "app" | "user" } | null> {
    const resolvedRole: TokenRole =
      role === "reviewer" && this.reviewerClient !== null ? "reviewer" : "implementer";

    const cached = this.cachedIdentityByRole[resolvedRole];
    if (cached) return cached;

    const client = this.clientForRole(resolvedRole);
    const info = await client.getAppInfo();
    this.cachedIdentityByRole[resolvedRole] = info;
    return info;
  }

  isServiceAccountConfigured(): boolean {
    return true;
  }

  /**
   * Fetches the LIVE slug + permission set for the App backing `role`
   * (mt#3218 permission-drift detection). Defaults to the implementer App,
   * matching `clientForRole`'s existing default/fallback behavior.
   */
  async getAppPermissions(role?: TokenRole): Promise<GitHubAppPermissions> {
    return this.clientForRole(role).getAppPermissions();
  }

  /**
   * Repository coverage for `role`'s installation (mt#4680). Defaults to the
   * implementer App, matching `getAppPermissions`'s behavior above.
   */
  async getInstallationCoverage(role?: TokenRole): Promise<InstallationCoverage> {
    return this.clientForRole(role).getInstallationCoverage();
  }

  /**
   * Does `role`'s installation cover `ownerRepo` (an `owner/repo` string)?
   *
   * Comparison is case-insensitive because GitHub treats owner and repo names
   * that way, while echoing back whatever casing the caller used — so a
   * case-sensitive check would report a covered repo as ungranted.
   *
   * **Re-fetches on every call, deliberately.** Coverage changes the moment an
   * operator grants a repository, so a cache would answer "not covered" after
   * the grant that was made specifically to fix it. Callers checking several
   * repositories should call `getInstallationCoverage()` once and test against
   * its list instead.
   */
  async coversRepository(ownerRepo: string, role?: TokenRole): Promise<boolean> {
    const coverage = await this.getInstallationCoverage(role);
    return coverage.repositories.includes(ownerRepo.toLowerCase());
  }

  /**
   * Strict per-role configuration check. Distinct from `isServiceAccountConfigured()`
   * (which only reports the primary App's presence) and from `getToken("reviewer")`
   * (which silently falls back to implementer when reviewer is absent).
   *
   * - `"implementer"` → always true (this provider is only constructed when
   *   the implementer App is configured).
   * - `"reviewer"`    → true iff a reviewer App was configured (i.e., the
   *   reviewer client was instantiated in the constructor).
   */
  isRoleConfigured(role: TokenRole): boolean {
    if (role === "reviewer") return this.reviewerClient !== null;
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
