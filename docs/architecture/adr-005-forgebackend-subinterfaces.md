# ADR-005: ForgeBackend Sub-Interfaces for Multi-Provider PR/CI/Review Operations

## Status

**ACCEPTED** — Documented 2026-04-22. Builds on [ADR-003](./adr-003-project-level-repository-backend.md).

## Context

### Evolution from ADR-003

ADR-003 established that repository backend type is a project-level property set once at `minsky init`. It assumed three backends: GitHub, GitLab (planned), and local. The original `RepositoryBackend` interface carried all PR, CI, and review operations as flat methods alongside the git operations (clone, branch, push, pull).

### Problems that Emerged

As the backend layer accumulated features, three problems surfaced:

1. **Flat method explosion.** `RepositoryBackend` grew to seven PR/review methods mixed with eight git methods: `createPullRequest`, `updatePullRequest`, `mergePullRequest`, `approvePullRequest`, `getPullRequestApprovalStatus`, `getPullRequestDetails`, `getPullRequestDiff` — plus `clone`, `branch`, `push`, `pull`, etc. The interface was hard to scan and impossible to document cohesively.

2. **LOCAL/REMOTE backends were dead weight.** The LOCAL backend simulated PRs via a "prepared merge commit" workflow that no actual user used. REMOTE fell back to the same simulation. Both paths carried substantial complexity (~3,700 lines across `local.ts`, `local-pr-operations.ts`, `local-pr-approval.ts`, `remote.ts`, `prepared-merge-commit-workflow.ts`, etc.) that existed only to satisfy the abstraction. Research confirmed the target audience was overwhelmingly on GitHub; GitLab/Bitbucket users needed real forge implementations, not a degraded local simulation.

3. **CI checks bypassed the abstraction entirely.** `getCheckRunsForRef` in `github-pr-checks.ts` was a free function called directly from `session/commands/pr-checks-subcommand.ts`, which constructed its own Octokit. Nothing in `RepositoryBackend` represented CI status as a capability, so the only forge that had it was indistinguishable at the type level from one that didn't.

4. **Provider-specific semantics couldn't be typed.** The flat interface gave GitHub, GitLab, and Bitbucket the same surface despite having fundamentally different review and CI models (see [Mapping](#mapping-to-concrete-forges) below).

## Decision

We reorganize the forge-capability portion of `RepositoryBackend` into **three capability sub-interfaces** accessed via readonly properties, introduce a `ForgeBackend` type extending `RepositoryBackend` with a `forgeType` discriminant, and remove the LOCAL/REMOTE backends entirely.

### Sub-interface Shape

```typescript
interface PullRequestOperations {
  create(options: CreatePROptions): Promise<PRInfo>;
  update(options: UpdatePROptions): Promise<PRInfo>;
  merge(prIdentifier: string | number, session?: string): Promise<MergeInfo>;
  get(options: { prIdentifier?: string | number; session?: string }): Promise<PRDetails>;
  getDiff(options: { prIdentifier?: string | number; session?: string }): Promise<PRDiff>;
}

interface CIStatusOperations {
  getChecksForRef(headSha: string): Promise<ChecksResult>;
  getChecksForPR(prNumber: number): Promise<ChecksResult>;
}

interface ReviewOperations {
  approve(prIdentifier: string | number, reviewComment?: string): Promise<ApprovalInfo>;
  getApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus>;
  submitReview?(
    prIdentifier: string | number,
    options: {
      body: string;
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      comments?: InlineComment[];
    }
  ): Promise<{ reviewId: number; htmlUrl: string }>;
}
```

### ForgeBackend Type

```typescript
export type ForgeType = "github" | "gitlab" | "bitbucket";

export interface ForgeBackend extends RepositoryBackend {
  readonly forgeType: ForgeType;
  readonly pr: PullRequestOperations;
  readonly ci: CIStatusOperations;
  readonly review: ReviewOperations;
}
```

### Call-Site Pattern

Before:

```typescript
await backend.createPullRequest(title, body, sourceBranch, baseBranch, session, draft);
await backend.approvePullRequest(prNumber, comment);
const checks = await getCheckRunsForRef(gh, sha, octokit); // free function, bypassed backend
```

After:

```typescript
await backend.pr.create({ title, body, sourceBranch, baseBranch, session, draft });
await backend.review.approve(prNumber, comment);
const checks = await backend.ci.getChecksForPR(prNumber);
```

### Why `submitReview` is Optional

The core `ReviewOperations` methods (`approve`, `getApprovalStatus`) are universal across forges. `submitReview` — which posts arbitrary-event reviews (APPROVE/COMMENT/REQUEST_CHANGES) with line-level comments — has forge-specific nuances (GitHub reviews vs GitLab approval rules vs Bitbucket's simpler approve/unapprove). Marking it optional lets backends ship without this capability and evolve it independently. The `/review-pr` skill falls back to the GitHub MCP server's review endpoint when the backend doesn't implement `submitReview`.

## Consequences

### Benefits

- **Capability discovery via property existence.** A caller who needs CI status checks `backend.ci`. A caller who needs review submission checks `backend.review.submitReview`. This is strictly better than runtime `typeof backend.createPullRequest === "function"` checks.

- **Cohesive per-capability documentation.** Each sub-interface is small enough to document in one place, with consistent semantics across its methods. `RepositoryBackend` itself is now focused on git operations.

- **Cleaner test surface.** Test mocks for PR operations don't need to stub out every CI and review method. The sub-interfaces are natural seams for partial mocks.

- **Room for forge-specific extension.** Each sub-interface can grow independently. `PullRequestOperations` may get `list()` and `getByBranch()` when needed by specific call sites without perturbing CI or review.

- **Dead code removal.** The LOCAL/REMOTE removal that enabled this refactor dropped ~6,300 lines of production code (prepared-merge-commit workflow, local PR approval, legacy backend factories, etc.). The surface is dramatically smaller.

### Trade-offs

- **Slight call-site verbosity.** `backend.pr.create()` is four characters longer than `backend.createPR()` would be. This is a small cost for the structural clarity; in practice, call sites become more readable because the capability is named explicitly.

- **Migration cost for existing callers.** 20 call sites had to be migrated from positional args on flat methods to options objects on sub-interface methods. This was a one-time cost absorbed in the mt#838 campaign.

- **Static factory ergonomics.** The static `ConflictDetectionService.smartSessionUpdate` style (instance methods invoked through static helpers) doesn't carry over cleanly to sub-interfaces. Where needed, static entry points were updated to accept optional `deps` explicitly for testability.

### Negated Alternatives

- **Keep flat methods.** Rejected: the interface was already at 15 methods and growing. Adding CI and review submission without grouping would push it past the point where it can be reasoned about as a whole.

- **Use inheritance (`GitHubBackend extends ForgeBackend extends RepositoryBackend`).** Rejected in favor of composition via sub-interface properties. Inheritance forces every forge to implement every capability; composition lets forges opt into capabilities they actually support, which maps more honestly to the reality that GitLab pipelines and GitHub Checks are not the same thing.

- **Keep LOCAL/REMOTE as degraded-mode backends.** Rejected: the "prepared merge commit" simulation was overcomplicated, unused in practice, and actively blocked cleaning up the abstraction. See mt#880 for the removal rationale.

## Mapping to Concrete Forges

The sub-interfaces are designed to be implementable across the three major forges while acknowledging that some capabilities require forge-specific data models:

| Sub-interface | GitHub                                                             | GitLab (planned)                                        | Bitbucket (planned)                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------ |
| `pr`          | Pull Request API (`octokit.rest.pulls.*`)                          | Merge Request API (`@gitbeaker/rest` `MergeRequests.*`) | Pull Request API                     |
| `ci`          | Checks API + combined status                                       | Pipelines + Jobs                                        | Build statuses                       |
| `review`      | Review objects (APPROVE/REQUEST_CHANGES/COMMENT with line threads) | Approval rules + individual approvals                   | Approve/unapprove toggles + comments |

The `ci` and `review` abstractions intentionally smooth over the data-model differences on the **read side** (pass/fail counts, approval state booleans). Write-side differences — re-running failed pipelines, configuring approval rules — are deliberately NOT in the abstraction; they belong in forge-specific APIs when needed.

## Implementation PRs

- **[#569](https://github.com/edobry/minsky/pull/569)** (mt#880) — Remove LOCAL/REMOTE repository backends (~5,700 lines deleted)
- **[#582](https://github.com/edobry/minsky/pull/582)** (mt#881) — Remove dead prepared-merge-commit code from GitService
- **[#594](https://github.com/edobry/minsky/pull/594)** (mt#882) — Introduce ForgeBackend with PR, CI, and Review sub-interfaces
- **[#597](https://github.com/edobry/minsky/pull/597)** (mt#883) — Extend config schema for multi-forge extensibility (`gitlab`, `bitbucket` enum values and config sections)
- **[#628](https://github.com/edobry/minsky/pull/628)** (mt#847) — Add `submitReview` to ReviewOperations for bot-identity PR reviews

## References

- [ADR-003: Project-Level Repository Backend Configuration](./adr-003-project-level-repository-backend.md) — predecessor decision
- [docs/architecture.md §8](../architecture.md) — current architecture overview
- `src/domain/repository/index.ts` — interface definitions
- `src/domain/repository/github.ts` — GitHub implementation
- `src/domain/repository/github-pr-review.ts` — submitReview implementation (mt#847)
