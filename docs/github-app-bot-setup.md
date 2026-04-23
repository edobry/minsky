# GitHub App Bot Identity Setup

## Overview

Minsky supports a GitHub App service account (`minsky-ai[bot]`) for automated operations such as PR review submission. Using a bot identity rather than your personal access token provides several advantages:

- **Stale approval dismissal**: GitHub can be configured to dismiss pull request approvals when code changes; reviews from a bot identity are unaffected, keeping human approvals valid after bot activity.
- **Clear attribution**: Automated comments, reviews, and merges are visibly attributed to the bot, not to a human user.
- **Hosted service model**: A future hosted Minsky service can install a single central App across customer repositories without requiring access to any user's personal token.

### TokenProvider Architecture

Minsky uses a `TokenProvider` interface to abstract GitHub API token acquisition. Two implementations exist:

- **`FallbackTokenProvider`** — uses your personal access token for both user and service operations. This is the default when no service account is configured.
- **`GitHubAppTokenProvider`** — authenticates as a GitHub App installation for service operations (posting reviews, creating/merging PRs) while still using your personal token for user-attributed operations.

When `github.serviceAccount` is present in the Minsky configuration, `createTokenProvider` automatically selects `GitHubAppTokenProvider`.

## Prerequisites

- A GitHub account with **owner** access to the target repository (required to create and install a GitHub App)
- Minsky configured and working for the target repository with the `github` backend

## 1. Create the GitHub App

You can create and install the App either via the **automated script** (recommended) or through the GitHub UI. The script covers sections 1–3 (create App, generate key, install on repo, fetch installation ID) in a single browser-driven flow and saves all credentials to `~/.config/minsky/` with correct permissions.

### Automated: `scripts/create-github-app.ts`

Run the script with the App name, target repo, and optional permission/event overrides. It starts a local HTTP server, opens your browser to GitHub's "Create App from manifest" page with the manifest pre-filled, captures the redirect, exchanges the code for credentials, and saves them.

Canonical invocations:

```bash
# Implementer App (code author, PR creator):
bun scripts/create-github-app.ts \
  --name minsky-ai \
  --repo <your-owner>/<your-repo>

# Reviewer App (Chinese-wall adversarial reviewer, mt#1073):
bun scripts/create-github-app.ts \
  --name minsky-reviewer \
  --repo <your-owner>/<your-repo> \
  --permissions pull_requests:write,contents:read,metadata:read \
  --events pull_request
```

The script writes:

- `~/.config/minsky/<name>.pem` (private key, `0600`)
- `~/.config/minsky/<name>.json` (App ID, slug, client ID, installation ID, creation timestamp)

Flags:

- `--name <name>` — required. Also used as file prefix under `~/.config/minsky/`.
- `--repo <owner/repo>` — required. Owner is matched against the install account during installation lookup.
- `--permissions <k:v,...>` — optional. Default: `pull_requests:write,contents:read,metadata:read`.
- `--events <e1,e2,...>` — optional. Default: none.
- `--port <n>` — optional. Default: `9847`.
- `--help` / `-h` — print usage.

After the script exits, skip to §4 (configure Minsky). Sections 2 and 3 are automated; section 1 steps below are only needed if you prefer the UI path.

### Manual: GitHub UI

1. Visit [https://github.com/settings/apps/new](https://github.com/settings/apps/new)

2. Fill in the basic information:

   - **GitHub App name**: `minsky` (or a unique name for private deployments — app names are globally unique on github.com)
   - **Homepage URL**: your repository URL (e.g., `https://github.com/you/yourrepo`)

3. **Webhook**: Uncheck "Active" unless you want GitHub to send events to a server. For local Minsky usage, no webhook is needed.

4. Set **Repository permissions**:
   | Permission | Access level |
   |---|---|
   | Pull requests | Read & write |
   | Contents | Read-only |
   | Metadata | Read-only (auto-included) |

5. **Where can this GitHub App be installed?**

   - Choose "Only on this account" for personal use or a single-organization deployment.
   - Choose "Any account" if you plan to offer this as a hosted service.

6. Click **Create GitHub App**.

7. On the App settings page that appears, note the **App ID** (shown near the top of the page).

8. Scroll to the **Private keys** section, click **Generate a private key**, and download the `.pem` file.

## 2. Install the App

1. From the App settings page, click **Install App** in the left sidebar.
2. Choose the account (your personal account or an organization) where the target repository lives.
3. Select **Only select repositories** and choose the specific repositories you want the bot to access. Minimal scope is recommended.
4. Click **Install**.
5. After installation, look at the browser URL. It will be:
   ```
   https://github.com/settings/installations/<INSTALLATION-ID>
   ```
   Note the numeric **Installation ID** from the URL.

## 3. Store Credentials

Move the downloaded private key to a secure location and restrict its permissions:

```bash
mkdir -p ~/.config/minsky
mv ~/Downloads/<app-slug>.*.private-key.pem ~/.config/minsky/minsky-app.pem
chmod 600 ~/.config/minsky/minsky-app.pem
```

Never commit the `.pem` file to version control.

## 4. Configure Minsky

You can supply the GitHub App credentials via a config file or environment variables. Environment variables take precedence.

**If you used the automated path (`scripts/create-github-app.ts`):** the script wrote credentials to `~/.config/minsky/<name>.pem` (private key) and `~/.config/minsky/<name>.json` (metadata including `appId`, `installationId`, and `privateKeyFile`). Paste the `appId`, `installationId`, and `privateKeyFile` values from the JSON into the examples below — they are filled in for you.

**If you used the manual UI path:** substitute the App ID, installation ID from section 2, and the private-key path you chose in section 3.

### Option A: Config File

Add the `serviceAccount` block under `github` in `~/.config/minsky/config.yaml`:

```yaml
github:
  token: <your-personal-access-token>
  serviceAccount:
    type: github-app
    appId: <YOUR-APP-ID>
    privateKeyFile: /Users/you/.config/minsky/<name>.pem # where <name> matches --name (e.g., minsky-ai, minsky-reviewer)
    installationId: <YOUR-INSTALLATION-ID>
```

`token` is your existing personal access token (unchanged). The `serviceAccount` block adds the bot identity on top of it.

### Option B: Environment Variables (local, file-backed key)

```bash
export MINSKY_APP_ID=<YOUR-APP-ID>
export MINSKY_APP_PRIVATE_KEY_FILE=~/.config/minsky/<name>.pem  # where <name> matches --name
export MINSKY_APP_INSTALLATION_ID=<YOUR-INSTALLATION-ID>
```

Add these to your shell profile (`.zshrc`, `.bashrc`, etc.) to persist across sessions.

When using environment variables, the `type: github-app` discriminant is inferred automatically — you do not need to set a separate env var for it.

### Option C: Hosted / Containerized Deploy (inline PEM via env var)

When running Minsky in a container or hosted environment (Railway, Docker, CI runners) there is no persistent filesystem to hold `~/.config/minsky/<name>.pem`. Instead of staging the key into the image at build time (which leaks it into every layer), pass the PEM content directly via `MINSKY_GITHUB_APP_PRIVATE_KEY`:

```bash
# Preferred — the shell preserves real newlines end-to-end:
railway variables --set MINSKY_GITHUB_APP_PRIVATE_KEY="$(cat ~/.config/minsky/<name>.pem)"
railway variables --set MINSKY_APP_ID=<YOUR-APP-ID>
railway variables --set MINSKY_APP_INSTALLATION_ID=<YOUR-INSTALLATION-ID>
```

**Gotcha — Railway web UI flattens multi-line values.** If you paste the PEM into Railway's dashboard, Railway stores it as a single line with literal `\n` escape sequences instead of real newlines. Minsky's `GitHubAppTokenProvider` auto-normalizes the `\n`-escaped form back to real newlines before signing, so both shapes work. The CLI `$(cat ...)` form above avoids the flattening entirely and is less error-prone.

**Precedence.** When both `privateKey` (inline) and `privateKeyFile` (path) are set, inline content wins. This lets you run the same image locally and in a container without reconfiguration — the container-only env var takes over when present, and your local file-path config is ignored.

**Security note.** The PEM value is never logged, never surfaced in error messages, and the process never writes it back to disk. Treat the env var as you would a private key file — scope it to the single service that needs it and rotate if it leaks.

See `docs/deploy-minsky-railway.md` for the full Railway deploy walkthrough that uses this env var.

## 5. Verify Configuration

Check that the service account fields appear in the resolved configuration:

```bash
minsky config show | grep -A4 serviceAccount
```

Expected output:

```
serviceAccount:
  type: github-app
  appId: 123456
  privateKeyFile: /Users/you/.config/minsky/minsky-app.pem
  installationId: 78901234
```

Then verify that the token provider can authenticate and report the bot identity with the following script:

```ts
// verify-bot.ts
import { createTokenProvider } from "./src/domain/auth/index.ts";
import type { GitHubConfig } from "./src/domain/configuration/schemas/github.ts";

const config: GitHubConfig = {
  serviceAccount: {
    type: "github-app",
    appId: Number(process.env.MINSKY_APP_ID),
    privateKeyFile: process.env.MINSKY_APP_PRIVATE_KEY_FILE!,
    installationId: Number(process.env.MINSKY_APP_INSTALLATION_ID),
  },
};

const provider = createTokenProvider(config, process.env.GITHUB_TOKEN!);

const identity = await provider.getServiceIdentity();
console.log("Service identity:", identity);
// Expected: { login: "minsky[bot]", type: "app" }

const token = await provider.getServiceToken();
console.log(
  "Installation token acquired:",
  token.startsWith("ghs_") ? "yes (ghs_ prefix)" : token.slice(0, 10)
);
```

Run with:

```bash
bun run verify-bot.ts
```

## 6. How It Works

When `github.serviceAccount` is present in the resolved configuration:

1. **Factory selection**: `createTokenProvider` instantiates `GitHubAppTokenProvider` instead of `FallbackTokenProvider`.

2. **JWT generation**: For each GitHub API call that needs a service token, `GitHubAppTokenProvider.generateJwt()` creates a short-lived RS256 JWT signed with the private key. The JWT is issued 60 seconds in the past (to tolerate clock skew) and expires after 9 minutes.

3. **Installation token exchange**: The JWT is sent to `POST /app/installations/{installationId}/access_tokens`. GitHub returns a short-lived installation access token (`ghs_...`) valid for 1 hour. Optionally, a specific repository can be scoped by passing the repo name in the request body.

4. **Token caching**: The installation token is cached in memory. Tokens are considered expired when fewer than 5 minutes remain, triggering a silent refresh before the next API call.

5. **Routing**: All GitHub API operations performed by Minsky's `RepositoryBackend` (create PR, merge PR, post reviews) call `TokenProvider.getServiceToken()`, so they authenticate as `minsky-ai[bot]` (or whatever slug you gave the App).

6. **Review submission**: The `/review-pr` skill's `mcp__minsky__session_pr_review_submit` MCP tool routes through this pipeline, so review comments appear as authored by the bot.

## 7. Troubleshooting

**"Failed to fetch GitHub App info: 401"**

The private key does not match the App ID, or the key has been revoked. Check:

- The `appId` in your config matches the App ID on the GitHub App settings page.
- The `.pem` file is the one generated for this App (not a different App's key).
- The key has not been deleted from the App settings page.

**"Failed to create GitHub App installation token: 404" or "No installation found"**

The App is not installed on the account that owns the target repository. Return to [Install the App](#2-install-the-app) and verify the installation covers the correct account and repository.

**Reviews still posting as the user, not the bot**

Run `minsky config show` and verify `serviceAccount` appears in the output. If it is missing:

- Check for YAML syntax errors in `~/.config/minsky/config.yaml` (indentation must be consistent).
- If using env vars, verify `MINSKY_APP_ID`, `MINSKY_APP_INSTALLATION_ID`, and **one** of `MINSKY_APP_PRIVATE_KEY_FILE` (local) or `MINSKY_GITHUB_APP_PRIVATE_KEY` (hosted, inline PEM) are all exported (`echo $MINSKY_APP_ID` should return a value). If neither key variable is set, Minsky raises `"GitHub App private key is not configured: set MINSKY_GITHUB_APP_PRIVATE_KEY (env var) or github.serviceAccount.privateKeyFile (config file)"`.

**"Installation token expired" or stale token errors**

`GitHubAppTokenProvider` automatically refreshes tokens 5 minutes before the 1-hour expiry. If you still see expired token errors, check that your system clock is accurate — a clock skew of more than a few minutes can cause JWT validation failures on GitHub's side.

**Private key file not found**

The `privateKeyFile` path is expanded with `~/` support. Verify the path is correct and the file has not been moved. Check permissions with `ls -la ~/.config/minsky/minsky-app.pem` — it should show `-rw-------`.

## 8. Replication for Private Deployments

GitHub App names are globally unique on github.com. Each deployment (individual developer, team, or hosted instance) needs its own GitHub App with a unique name.

To set up a private deployment:

1. Each deployment operator creates their own App at [https://github.com/settings/apps/new](https://github.com/settings/apps/new) with a unique name (e.g., `minsky-yourorg`).
2. Configure the same permissions as listed in [Create the GitHub App](#1-create-the-github-app): pull requests (read & write), contents (read-only).
3. Install the App on the repositories the deployment will manage.
4. Provide the App ID, private key file path, and installation ID to Minsky via the config file or environment variables described in [Configure Minsky](#4-configure-minsky).

For a future hosted Minsky service, a single central App would be registered once and installed on customer repositories via GitHub's standard App installation flow — customers would authorize the App through the GitHub UI, and Minsky would receive the installation ID as part of the onboarding process.
