# Reviewer Harness Scripts — Auth & Rate Limits

## GitHub API Authentication

Harness scripts (`services/reviewer/scripts/`) use the `OCTOKIT_AUTH` env var
for GitHub API authentication. When not set, they fall back to `GITHUB_TOKEN`
(typically `$(gh auth token)`).

### Why a separate token?

The user's PAT has a 5000 requests/hour rate limit shared across all `gh` CLI
usage, agent activity, and harness measurement runs. A single corpus enumeration
can consume 30-100+ calls; concurrent agent work pushes the fleet past the limit.

Setting `OCTOKIT_AUTH` to a GitHub App installation token isolates the harness's
rate-limit budget from the user's interactive work.

### Config fallback (mt#3547, extended mt#4620)

Scripts that call `resolveGitHubTokenWithConfig()` (in `scripts/harness-config-auth.ts`) check
`OCTOKIT_AUTH` then `GITHUB_TOKEN` as above, but — unlike the env-only `resolveGitHubToken()` in
`scripts/harness-auth.ts` — fall back to Minsky's own configuration (`github.token`) when neither
env var is set. This matters on a developer machine or an agent session where the token lives in
Minsky's config store rather than as an exported shell variable; an env-only harness reports "no
GitHub token" there even when `minsky config credentials list` (or a live GitHub call) would
succeed. `OCTOKIT_AUTH` still wins when present — it exists specifically to point harness traffic
at a separate App installation token for rate-limit isolation, a deliberate override of whatever
the config holds.

The same env-first-then-config fallback applies to the reviewer/eval scripts' MODEL provider
keys (`OPENAI_API_KEY` / `GOOGLE_AI_API_KEY` / `ANTHROPIC_API_KEY`, resolved via
`resolveProviderApiKeyWithConfig()` in the same file, falling back to
`ai.providers.<provider>.apiKey`) — used by `scripts/paired-eval-runner.ts` and
`scripts/run-judge-pass.ts`. A whitespace-only env var is treated as unset rather than as a real
key, so it cannot silently mask a valid config-stored credential.

### Setup

**Option A: Reuse the reviewer App token (simplest)**

The reviewer service already has a GitHub App (`MINSKY_REVIEWER_APP_ID`). Generate
an installation token via the GitHub API using the App's JWT. See
[GitHub Docs: Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
for the JWT generation steps, then:

```bash
export OCTOKIT_AUTH=$(gh api \
  -H "Authorization: Bearer <your-jwt>" \
  /app/installations/<installation-id>/access_tokens \
  --jq '.token')
```

**Option B: Use a separate fine-grained PAT**

Create a fine-grained PAT at https://github.com/settings/tokens with:

- Repository access: this repo only
- Permissions: Contents (read), Pull requests (read), Metadata (read)

```bash
export OCTOKIT_AUTH=<your-fine-grained-pat>
```

### Usage

```bash
# With dedicated token (rate-limit isolated)
OCTOKIT_AUTH=<token> bun services/reviewer/scripts/measure-calibration.ts --mode=trivial --dry-run

# Default fallback (user's PAT via gh auth)
GITHUB_TOKEN=$(gh auth token) bun services/reviewer/scripts/replay-severity.ts --dry-run
```

### Verifying rate-limit isolation

```bash
# Check user PAT usage before/after a harness run
gh api rate_limit --jq '.rate | "\(.used)/\(.limit) (resets \(.reset | todate))"'

# Run with OCTOKIT_AUTH
OCTOKIT_AUTH=<token> bun services/reviewer/scripts/measure-calibration.ts --mode=trivial --dry-run

# Check again — user PAT used count should not have changed
gh api rate_limit --jq '.rate | "\(.used)/\(.limit) (resets \(.reset | todate))"'
```
