/**
 * Output tools for the reviewer model.
 *
 * Defines the seven structured output tools the reviewer model uses to compose
 * a PR review. Each tool corresponds to one kind of review artifact:
 *   - submit_finding: a discrete review finding with severity and location
 *   - submit_inline_comment: a targeted inline comment on a specific line
 *   - submit_spec_verification: a verification result for one spec criterion
 *   - submit_documentation_impact: documentation-impact assessment (mt#2053)
 *   - submit_adoption_sweep: adoption sweep result per new public export (mt#2059)
 *   - submit_thread_resolve: resolve an existing review thread (mt#1345)
 *   - conclude_review: the final review conclusion (approve / request-changes / comment)
 *
 * This module is schema-only — no provider wiring, no composition logic. It is
 * consumed by the output-parsing layer (mt#1399) and the composition layer
 * (mt#1401).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas and inferred TypeScript types
// ---------------------------------------------------------------------------

/**
 * Args for the `submit_finding` tool.
 *
 * A finding is a discrete review observation tied to a specific file and line.
 * Use `severity` to signal how urgently the issue must be addressed.
 */
export const SubmitFindingArgsSchema = z.object({
  /**
   * How urgently this finding must be addressed:
   *   "BLOCKING"     — must be fixed before the PR can merge
   *   "NON-BLOCKING" — nit, observation, or suggestion; does not block merge
   *   "PRE-EXISTING" — issue that was already present before this PR; surfaced
   *                    for awareness but not attributed to this change
   */
  severity: z.enum(["BLOCKING", "NON-BLOCKING", "PRE-EXISTING"]),

  /** Path to the file the finding refers to, relative to the repository root. */
  file: z.string().min(1),

  /**
   * Line number in the file where the finding applies (1-based). Use the line
   * as it appears in the diff; for additions use the new-file line number.
   */
  line: z.number().int().positive(),

  /**
   * Last line of a multi-line finding range (1-based, inclusive). Omit for
   * single-line findings.
   */
  lineEnd: z.number().int().positive().optional(),

  /**
   * Which side of the diff the finding applies to:
   *   "LEFT"  — the old/base version of the file (deletion context)
   *   "RIGHT" — the new/head version of the file (addition context)
   * Omit for findings that are not diff-position-specific.
   */
  side: z.enum(["LEFT", "RIGHT"]).optional(),

  /** One-sentence summary of the finding. */
  summary: z.string().min(1),

  /** Full explanation of the finding, including rationale and suggested fix. */
  details: z.string().min(1),
});

export type SubmitFindingArgs = z.infer<typeof SubmitFindingArgsSchema>;

/**
 * Upper bound on findings carried in one batched call (mt#4979).
 *
 * Same reasoning as {@link MAX_BATCHED_SPEC_VERIFICATIONS} — an unbounded array
 * is a denial-of-context vector — but deliberately SMALLER, because a finding
 * carries two free-text fields (`summary` and `details`, the latter holding
 * rationale plus a suggested fix) where a verification carries one short
 * evidence string. A review with more than 20 distinct findings is already
 * past the point where the batch is the problem.
 */
export const MAX_BATCHED_FINDINGS = 20;

/**
 * Args for the batched `submit_findings` tool (mt#4979).
 *
 * The singular tool requires one call per finding. That is a cost in the main
 * loop, and a hard CEILING on the mt#2926 post-loop forced-findings pass: that
 * pass pins `tool_choice` to a single function, which returns exactly one call,
 * so a conclusion naming several blocking issues recovered only the first.
 * Measured 3/3 on live gpt-5 (`scripts/smoke-forced-findings.ts`): every
 * attempt returned one finding for a two-defect conclusion.
 *
 * This tool carries all of them in ONE call. Deliberately a separate tool
 * rather than a widened `submit_finding` schema, exactly as mt#3545 chose for
 * spec verifications: `parseToolCallExpanded` expands a batch into N singular
 * `submit_finding` entries, so `compose-review`, `review-provenance`, the
 * mt#2863 resolution-note guard and mt#2926's `forceFindings` append loop all
 * keep matching the shape they already handle. The ceiling lifts; the blast
 * radius is nil.
 */
export const SubmitFindingsArgsSchema = z.object({
  /** One entry per distinct issue, in the order they should be reported. */
  findings: z.array(SubmitFindingArgsSchema).min(1).max(MAX_BATCHED_FINDINGS),
});

export type SubmitFindingsArgs = z.infer<typeof SubmitFindingsArgsSchema>;

/**
 * Args for the `submit_inline_comment` tool.
 *
 * An inline comment is a targeted annotation on a specific line, typically
 * used for non-blocking observations, questions, or minor suggestions that do
 * not warrant a full finding entry.
 */
export const SubmitInlineCommentArgsSchema = z.object({
  /** Path to the file, relative to the repository root. */
  file: z.string().min(1),

  /** Line number in the file (1-based). */
  line: z.number().int().positive(),

  /** Comment body. Markdown is supported. */
  body: z.string().min(1),

  /**
   * Which side of the diff the line refers to:
   *   "RIGHT" — the new/head version of the file (an added or context line)
   *   "LEFT"  — the old/base version of the file (a removed line)
   * Omit for the common case (defaults to RIGHT). Mirrors `submit_finding`'s
   * `side`. Threaded through to anchor pre-validation (mt#2350): a LEFT-side
   * comment that cannot be resolved against the diff is demoted to the review
   * body rather than 422'ing the whole review.
   */
  side: z.enum(["LEFT", "RIGHT"]).optional(),

  /**
   * When replying to an existing review-thread comment, set this to the parent
   * comment's database ID. Obtain from `reviewThreads[].comments[].databaseId`
   * (the numeric REST id) in the context provided by the worker.
   *
   * When present, GitHub anchors the reply to the parent thread — the `file`
   * and `line` fields on this comment are ignored by the GitHub API.
   *
   * Use this instead of opening a new top-level thread when the finding was
   * already raised in a prior review round and still applies.
   */
  inReplyTo: z.number().int().positive().optional(),
});

export type SubmitInlineCommentArgs = z.infer<typeof SubmitInlineCommentArgsSchema>;

/**
 * Args for the `submit_thread_resolve` tool.
 *
 * Requests that the worker resolve a review thread. Use when the diff has
 * addressed the original finding or when the finding is no longer relevant.
 */
export const SubmitThreadResolveArgsSchema = z.object({
  /**
   * GraphQL node ID of the `PullRequestReviewThread` to resolve.
   * Obtain from `reviewThreads[].id` in the context provided by the worker.
   */
  threadId: z.string().min(1),

  /**
   * Short justification for the resolution (e.g., "fix verified — see commit
   * abc123", "outdated — function was deleted"). Kept in the worker's log and
   * may be surfaced as a reply comment before resolution.
   */
  reason: z.string().min(1).max(280),
});

export type SubmitThreadResolveArgs = z.infer<typeof SubmitThreadResolveArgsSchema>;

/**
 * Args for the `submit_spec_verification` tool.
 *
 * Records whether a single success criterion from the task spec was satisfied
 * by the changes under review. Submit one call per criterion.
 *
 * Also used for recovery-layer carve-out entries (a `### Does NOT cover` or
 * `## Does NOT cover` section, per `work-completion.mdc §Recovery layer spec
 * discipline`) — one call per carve-out entry, per the prompt instruction in
 * `prompt.ts` (mt#3217). The schema is identical; `criterion` carries the
 * carve-out's text and `status`/`evidence` follow the same Met/Not Met/N/A
 * contract.
 */
export const SubmitSpecVerificationArgsSchema = z.object({
  /** The exact text of the success criterion being evaluated. */
  criterion: z.string().min(1),

  /**
   * Verification result:
   *   "Met"          — the PR satisfies this criterion
   *   "Not Met"      — the PR does not satisfy this criterion
   *   "N/A"          — the criterion does not apply to this PR (e.g., out of scope)
   *   "Unverifiable" — the criterion's artifact lives outside this diff (e.g. it
   *                    names another task's spec, `mt#NNNN`, or a `mem#N` /
   *                    `ask#N` / `ws#N` short id) AND that artifact could not be
   *                    fetched (missing, ambiguous, service disabled, or a
   *                    transport error) — see the "## Referenced Task Specs" or
   *                    "## Referenced Memories, Asks & Workspaces" section for
   *                    the fetch status. Distinct from "Not Met": the criterion
   *                    was NOT read, so its truth is unknown, not false. Never
   *                    report "Met" in this case, and never omit the criterion
   *                    (mt#3919, extended to short ids by mt#3964).
   */
  status: z.enum(["Met", "Not Met", "N/A", "Unverifiable"]),

  /**
   * Evidence supporting the verdict. Reference specific file paths, line
   * numbers, or code snippets that demonstrate whether the criterion is met.
   */
  evidence: z.string().min(1),
});

export type SubmitSpecVerificationArgs = z.infer<typeof SubmitSpecVerificationArgsSchema>;

/**
 * Upper bound on criteria carried in one batched call (mt#3545).
 *
 * A spec with more entries than this is pathological, and an unbounded array is
 * a denial-of-context vector: the model could emit one call whose args dwarf the
 * diff. Specs in this repo run well under 20 combined criteria + carve-outs.
 */
export const MAX_BATCHED_SPEC_VERIFICATIONS = 50;

/**
 * Args for the batched `submit_spec_verifications` tool (mt#3545).
 *
 * The singular tool requires one call per criterion. A spec with 4 success
 * criteria plus 3 carve-outs therefore costs 7 serial emissions inside a
 * 10-round tool budget whose last round is already text-only — which is a large
 * part of why the model never reaches `conclude_review` in-loop (mt#3526).
 *
 * This tool carries all of them in ONE call. It is deliberately a separate tool
 * rather than a widened `submit_spec_verification` schema: `parseToolCallExpanded`
 * expands a batch into N singular `ReviewToolCall` entries, so `compose-review`,
 * `review-provenance`, and `severity-recovery` keep matching on exactly the shape
 * they already handle. The round saving is real; the blast radius is nil.
 */
export const SubmitSpecVerificationsArgsSchema = z.object({
  /** One entry per success criterion (or carve-out entry), in spec order. */
  verifications: z
    .array(SubmitSpecVerificationArgsSchema)
    .min(1)
    .max(MAX_BATCHED_SPEC_VERIFICATIONS),
});

export type SubmitSpecVerificationsArgs = z.infer<typeof SubmitSpecVerificationsArgsSchema>;

/**
 * Args for the `submit_documentation_impact` tool.
 *
 * Records whether the PR's changes affect any project documentation. Submit
 * exactly one call per review (or zero if the PR is purely internal — e.g., a
 * tests-only or internal-refactor PR where documentation impact does not
 * apply). Mirrors the three outcomes for the reviewer bot's documentation impact
 * assessment:
 *   - "no-update-needed"      — bugfix, internal refactor, cosmetic; docs do not change.
 *   - "updated-in-pr"         — the PR includes documentation updates alongside the code.
 *   - "blocking-needs-update" — the PR affects documented behavior but does NOT update
 *                               the docs. This is a blocking concern (the docs and code
 *                               drift apart on merge); the reviewer should also emit a
 *                               `submit_finding` with severity BLOCKING for the same issue.
 *
 * The reviewer service composes a `## Documentation impact` section in the
 * GitHub review body from this call so the merge gate can verify
 * documentation impact was explicitly assessed.
 */
export const SubmitDocumentationImpactArgsSchema = z.object({
  /**
   * The PR's documentation-impact classification. See the schema-level
   * comment above for the meaning of each value.
   */
  kind: z.enum(["no-update-needed", "updated-in-pr", "blocking-needs-update"]),

  /**
   * Justification for the verdict. Reference the specific docs (or absence
   * thereof) that drove the call. Examples:
   *   - "Pure internal refactor — no user-facing or documented behavior changed."
   *   - "Updated docs/configuration-guide.md to describe the new MINSKY_FOO env var."
   *   - "Adds a new MCP tool but does not update docs/architecture.md tool inventory."
   */
  evidence: z.string().min(1),

  /**
   * Optional list of documentation file paths affected (or required to be
   * updated). For `updated-in-pr`, list the docs the PR updated. For
   * `blocking-needs-update`, list the docs that need updating. Omit for
   * `no-update-needed`.
   */
  affectedDocs: z.array(z.string().min(1)).optional(),
});

export type SubmitDocumentationImpactArgs = z.infer<typeof SubmitDocumentationImpactArgsSchema>;

/**
 * Args for the `submit_adoption_sweep` tool.
 *
 * Records the adoption-sweep result for one new public export introduced by
 * this PR. Submit one call per new public export (function, class, type, CLI
 * command, MCP tool, hook). When the PR introduces more than 10 new exports,
 * emit a single cost-bounded call with `kind: "capability"` to avoid
 * exhausting the tool-call budget on mechanical enumeration.
 */
export const SubmitAdoptionSweepArgsSchema = z.object({
  /**
   * The fully-qualified name of the new export being swept.
   * Examples: "Reviewer.runReview", "tasks_orchestrate", "/declare-framework",
   * "submit_adoption_sweep". For cost-bounded calls, use the form
   * "<N> new exports (cost-bounding rule)".
   */
  symbol: z.string().min(1),

  /**
   * The kind of export being swept. Used as a rendering discriminator:
   *   "function"    — a new exported function
   *   "class"       — a new exported class
   *   "type"        — a new exported type or interface
   *   "cli-command" — a new CLI subcommand
   *   "mcp-tool"    — a new MCP tool
   *   "hook"        — a new hook entry point
   *   "capability"  — catchall for cost-bounded summary calls (>10 new exports)
   */
  kind: z.enum(["function", "class", "type", "cli-command", "mcp-tool", "hook", "capability"]),

  /**
   * List of callsites / consumers found in the codebase. Each entry is a short
   * description of the consumer (e.g., "src/foo.ts:42 — passes value via …").
   * Empty when no consumers are found.
   */
  consumersFound: z.array(z.string()).default([]),

  /**
   * Adoption classification:
   *   "Adopted"           — consumers were found; the export is in use.
   *   "Missing consumers" — no consumers were found; the export has no wiring.
   */
  classification: z.enum(["Adopted", "Missing consumers"]),

  /**
   * Optional free-form rationale. Use to explain why consumers are missing
   * (e.g., "wiring planned in mt#XXXX") or to note that spec-required wiring
   * is absent (which would also warrant a BLOCKING submit_finding call).
   */
  notes: z.string().optional(),
});

export type SubmitAdoptionSweepArgs = z.infer<typeof SubmitAdoptionSweepArgsSchema>;

/**
 * Args for the `conclude_review` tool.
 *
 * Signals the end of the review and provides a top-level summary. This tool
 * must be called exactly once, after all findings and spec verifications have
 * been submitted.
 */
export const ConcludeReviewArgsSchema = z.object({
  /**
   * The review conclusion:
   *   "APPROVE"          — no blocking issues; PR is ready to merge
   *   "REQUEST_CHANGES"  — one or more blocking issues must be addressed first
   *   "COMMENT"          — observations only, no BLOCKING finding submitted
   *                        (the model should write this ONLY when it is the
   *                        same App identity as the PR author — GitHub blocks
   *                        self-approval)
   *
   * IMPORTANT (mt#3202 / ask#6013): a model-written COMMENT conclusion with
   * zero BLOCKING `submit_finding` calls is reconciled to APPROVE downstream
   * — it does NOT hold the review back. A genuine reservation must be
   * expressed as an actual BLOCKING finding (or a REQUEST_CHANGES verdict);
   * describing a concern only in this `summary` field while emitting COMMENT
   * will not block merge.
   *
   * NOTE: a posted review can ALSO show event COMMENT for a reason the model
   * never wrote — `recovery-compose.ts`'s Step 3 (mt#1496) / Step 3d (mt#2836)
   * demote a REQUEST_CHANGES conclusion to COMMENT server-side when a later
   * structural pass determines the BLOCKING finding backing it no longer
   * applies. That service-demoted COMMENT is a distinct mechanism and does
   * NOT auto-promote to APPROVE, unlike the model-written case above.
   */
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),

  /**
   * High-level summary of the review outcome (2–5 sentences). Describe the
   * overall quality of the change, highlight the most significant findings,
   * and state whether the PR can proceed.
   */
  summary: z.string().min(1),
});

export type ConcludeReviewArgs = z.infer<typeof ConcludeReviewArgsSchema>;

// ---------------------------------------------------------------------------
// OpenAI-compatible tool definitions
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible tool definition shape used for function calling.
 * Parameters use JSON Schema draft-07 compatible objects.
 */
export interface OutputToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

/**
 * The six output tools registered with the model for structured review
 * composition. Mirrors the style of REVIEWER_TOOL_DEFINITIONS in providers.ts.
 */
export const OUTPUT_TOOL_DEFINITIONS: OutputToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "submit_finding",
      description:
        "Submit a discrete review finding tied to a specific file and line. " +
        "Call this once per distinct issue found in the diff. " +
        "severity: 'BLOCKING' for issues that must be fixed before merge (e.g., logic errors, " +
        "security vulnerabilities, broken contracts); 'NON-BLOCKING' for nits, style observations, " +
        "or suggestions that do not block merge; 'PRE-EXISTING' for issues that were already " +
        "present before this PR and are not introduced by this change. " +
        "side: 'RIGHT' for new lines added by the PR, 'LEFT' for removed lines in context.",
      parameters: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["BLOCKING", "NON-BLOCKING", "PRE-EXISTING"],
            description:
              "Issue severity. BLOCKING = must fix before merge; " +
              "NON-BLOCKING = nit/observation, does not block; " +
              "PRE-EXISTING = existed before this PR.",
          },
          file: {
            type: "string",
            minLength: 1,
            description: "File path relative to the repository root (e.g. src/domain/session.ts).",
          },
          line: {
            type: "integer",
            minimum: 1,
            description: "1-based line number where the finding applies.",
          },
          lineEnd: {
            type: "integer",
            minimum: 1,
            description:
              "Last line of a multi-line finding range (1-based, inclusive). Omit for single-line findings.",
          },
          side: {
            type: "string",
            enum: ["LEFT", "RIGHT"],
            description:
              "Diff side: RIGHT for additions (new file), LEFT for deletions (old file). Omit when not diff-position-specific.",
          },
          summary: {
            type: "string",
            minLength: 1,
            description: "One-sentence summary of the finding.",
          },
          details: {
            type: "string",
            minLength: 1,
            description: "Full explanation with rationale and suggested fix.",
          },
        },
        required: ["severity", "file", "line", "summary", "details"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_findings",
      description:
        "PREFERRED over submit_finding: record ALL findings in a SINGLE call. Pass one entry " +
        "per distinct issue. Each entry takes the same severity/file/line/summary/details " +
        "fields as the singular tool and is validated identically. Use this instead of " +
        "emitting the singular tool repeatedly — it leaves you more of your tool budget for " +
        "verification and for concluding the review.",
      parameters: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BATCHED_FINDINGS,
            description: "One entry per distinct issue found in the diff.",
            items: {
              type: "object",
              properties: {
                severity: {
                  type: "string",
                  enum: ["BLOCKING", "NON-BLOCKING", "PRE-EXISTING"],
                  description:
                    "Issue severity. BLOCKING = must fix before merge; " +
                    "NON-BLOCKING = nit/observation, does not block; " +
                    "PRE-EXISTING = existed before this PR.",
                },
                file: {
                  type: "string",
                  minLength: 1,
                  description:
                    "File path relative to the repository root (e.g. src/domain/session.ts).",
                },
                line: {
                  type: "integer",
                  minimum: 1,
                  description: "1-based line number where the finding applies.",
                },
                lineEnd: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "Last line of a multi-line finding range (1-based, inclusive). Omit for single-line findings.",
                },
                side: {
                  type: "string",
                  enum: ["LEFT", "RIGHT"],
                  description:
                    "Diff side: RIGHT for additions (new file), LEFT for deletions (old file). Omit when not diff-position-specific.",
                },
                summary: {
                  type: "string",
                  minLength: 1,
                  description: "One-sentence summary of the finding.",
                },
                details: {
                  type: "string",
                  minLength: 1,
                  description: "Full explanation with rationale and suggested fix.",
                },
              },
              required: ["severity", "file", "line", "summary", "details"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_inline_comment",
      description:
        "Submit a targeted inline comment on a specific line. Use for minor observations, " +
        "questions, or suggestions that do not warrant a full finding entry. " +
        "For issues that block merge, use submit_finding with severity BLOCKING instead. " +
        "When replying to an existing review thread from a prior round, set inReplyTo to the " +
        "parent comment's numeric ID (from reviewThreads[].comments[].databaseId in context). " +
        "Using inReplyTo keeps the conversation incremental rather than opening duplicate threads.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            minLength: 1,
            description: "File path relative to the repository root.",
          },
          line: {
            type: "integer",
            minimum: 1,
            description: "1-based line number to attach the comment to.",
          },
          body: {
            type: "string",
            minLength: 1,
            description: "Comment body. Markdown is supported.",
          },
          side: {
            type: "string",
            enum: ["LEFT", "RIGHT"],
            description:
              "Diff side: RIGHT for an added or context line (new file), LEFT for a removed " +
              "line (old file). Omit for the common case (defaults to RIGHT).",
          },
          inReplyTo: {
            type: "integer",
            minimum: 1,
            description:
              "If replying to an existing review-thread comment, the parent comment's numeric " +
              "database ID. From `reviewThreads[].comments[].databaseId` in context. When set, file " +
              "and line are ignored by GitHub — the reply anchors to the parent thread.",
          },
        },
        required: ["file", "line", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_thread_resolve",
      description:
        "Resolve a review thread. Use when the diff has addressed the original finding OR " +
        "the finding is no longer relevant. " +
        "Do NOT resolve threads where the first comment's author is human (not the reviewer bot). " +
        "Call this after verifying the fix in the diff — not speculatively.",
      parameters: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            minLength: 1,
            description:
              "GraphQL node ID of the PullRequestReviewThread to resolve. " +
              "From `reviewThreads[].id` in context.",
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: 280,
            description:
              "Short justification: 'fix verified — see <evidence>' for addressed findings, " +
              "or 'outdated — <one-line reason>' when the concern is no longer relevant.",
          },
        },
        required: ["threadId", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_spec_verification",
      description:
        "Record the verification result for one success criterion from the task spec. " +
        "Call this once per criterion listed in the spec's 'Success Criteria' section. " +
        "status: 'Met' if the PR satisfies the criterion; 'Not Met' if it does not; " +
        "'N/A' if the criterion does not apply to this PR; 'Unverifiable' if the criterion's " +
        "artifact lives outside this diff (e.g. it names another task's spec, mt#NNNN, or a " +
        "mem#N / ask#N / ws#N short id) and that artifact could not be fetched — see the " +
        "'Referenced Task Specs' or 'Referenced Memories, Asks & Workspaces' section for fetch " +
        "status and content when one is provided. " +
        "evidence must reference specific file paths or code to justify the verdict. " +
        "When status is 'Not Met', the evidence field must explain what was deferred and why, " +
        "and indicate that the spec needs updating or follow-up tasks need filing. " +
        "When status is 'Unverifiable', evidence must name the fetch failure (from the " +
        "Referenced Task Specs or Referenced Memories, Asks & Workspaces section) — never guess " +
        "'Not Met' for a criterion you could not read, and never report 'Met' for one either. " +
        "Do NOT also emit a submit_finding with severity BLOCKING for an Unverifiable " +
        "criterion — inability to fetch the referenced artifact is not evidence the criterion " +
        "is unmet.",
      parameters: {
        type: "object",
        properties: {
          criterion: {
            type: "string",
            minLength: 1,
            description: "The exact text of the success criterion being evaluated.",
          },
          status: {
            type: "string",
            enum: ["Met", "Not Met", "N/A", "Unverifiable"],
            description:
              "Verification result: Met, Not Met, N/A (criterion does not apply to this PR), " +
              "or Unverifiable (the criterion's artifact — e.g. another task's spec, or a " +
              "mem#N / ask#N / ws#N short id — could not be fetched; distinct from Not Met, " +
              "which means the artifact WAS read and does not carry the change).",
          },
          evidence: {
            type: "string",
            minLength: 1,
            description:
              "Evidence supporting the verdict. Reference file paths, line numbers, or code snippets.",
          },
        },
        required: ["criterion", "status", "evidence"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_spec_verifications",
      description:
        "PREFERRED over submit_spec_verification: record ALL success-criteria verdicts in a " +
        "SINGLE call. Pass one entry per criterion in the spec's 'Success Criteria' section " +
        "(plus one per '### Does NOT cover' carve-out entry, if present), in spec order. " +
        "Each entry takes the same criterion/status/evidence fields as the singular tool and " +
        "is validated identically. Use this instead of emitting the singular tool repeatedly — " +
        "it leaves you more of your tool budget for verification and for concluding the review.",
      parameters: {
        type: "object",
        properties: {
          verifications: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BATCHED_SPEC_VERIFICATIONS,
            description: "One entry per success criterion or carve-out entry, in spec order.",
            items: {
              type: "object",
              properties: {
                criterion: {
                  type: "string",
                  minLength: 1,
                  description: "The exact text of the success criterion being evaluated.",
                },
                status: {
                  type: "string",
                  enum: ["Met", "Not Met", "N/A", "Unverifiable"],
                  description:
                    "Verification result: Met, Not Met, N/A (criterion does not apply to this PR), " +
                    "or Unverifiable (the criterion's artifact — e.g. another task's spec, or a " +
                    "mem#N / ask#N / ws#N short id — could not be fetched; distinct from Not Met, " +
                    "which means the artifact WAS read and does not carry the change).",
                },
                evidence: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Evidence supporting the verdict. Reference file paths, line numbers, or code snippets.",
                },
              },
              required: ["criterion", "status", "evidence"],
              additionalProperties: false,
            },
          },
        },
        required: ["verifications"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_documentation_impact",
      description:
        "Record whether the PR's changes affect any project documentation. " +
        "Call this exactly once per review — every review MUST include this call. " +
        "kind: 'no-update-needed' for bugfix/internal-refactor/cosmetic PRs that do not " +
        "change documented behavior; 'updated-in-pr' when the PR ships documentation " +
        "updates alongside the code; 'blocking-needs-update' when the PR affects " +
        "documented behavior but does NOT update the docs (the reviewer should also " +
        "emit a submit_finding with severity BLOCKING for the same issue). " +
        "'affects documented behavior' covers TWO cases, not one: the PR ADDS surface the " +
        "docs omit, AND the PR CHANGES or REMOVES behavior that existing doc prose still " +
        "asserts. The second leaves a doc that is not silent but WRONG, and is the case " +
        "reviews habitually miss — check it by reading the doc that covers the changed " +
        "behavior, not by searching the docs for identifiers the diff adds. " +
        "evidence must justify the verdict and reference specific docs when applicable; when " +
        "the verdict rests on invalidated prose, quote the specific sentence the diff " +
        "falsifies. Do not claim existing docs 'remain accurate' unless you read them — say " +
        "which you checked and which you did not. " +
        "affectedDocs is optional but recommended for 'updated-in-pr' and " +
        "'blocking-needs-update' — list the affected documentation file paths.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["no-update-needed", "updated-in-pr", "blocking-needs-update"],
            description:
              "Documentation-impact classification: no-update-needed, updated-in-pr, or blocking-needs-update.",
          },
          evidence: {
            type: "string",
            minLength: 1,
            description:
              "Justification for the verdict. Reference specific docs (or absence thereof).",
          },
          affectedDocs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description:
              "Optional list of documentation file paths affected by the PR. List docs updated for 'updated-in-pr'; list docs that need updating for 'blocking-needs-update'. Only list docs that actually reference the changed symbols, routes, or behavior — which INCLUDES a doc whose existing prose describes the OLD behavior this PR changes, even if it never mentions a single identifier the diff adds; its prose being false is the reason it needs updating. What remains forbidden is topic-area speculation: a doc is not affected merely because it covers the same general area.",
          },
        },
        required: ["kind", "evidence"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_adoption_sweep",
      description:
        "Record the adoption-sweep result for one new public export introduced by this PR. " +
        "Call this once per new public export (function, class, type, CLI command, MCP tool, hook). " +
        "A 'new public export' is any symbol added to the public API surface: exported functions, " +
        "classes, types, CLI subcommands, MCP tools, or hooks that callers outside the module can use. " +
        "For each symbol, search the codebase for existing consumers (callsites, imports, registrations). " +
        "classification: 'Adopted' when consumers are found; 'Missing consumers' when none are found. " +
        "When the PR introduces more than 10 new public exports, emit a SINGLE call with " +
        "kind: 'capability', symbol: '<N> new exports (cost-bounding rule)', classification: 'Missing consumers', " +
        "and a notes field recommending a follow-up adoption task. Do NOT emit N individual calls. " +
        "When a spec criterion requires specific consumer wiring (e.g., 'the tool must be registered in X'), " +
        "a missing-consumer finding for that symbol is BLOCKING — also emit a submit_finding with " +
        "severity BLOCKING for the same issue.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            minLength: 1,
            description:
              "Fully-qualified name of the new export (e.g. 'Reviewer.runReview', 'tasks_orchestrate', " +
              "'/declare-framework', 'submit_adoption_sweep'). For cost-bounded calls: '<N> new exports (cost-bounding rule)'.",
          },
          kind: {
            type: "string",
            enum: ["function", "class", "type", "cli-command", "mcp-tool", "hook", "capability"],
            description:
              "Kind of export: function, class, type, cli-command, mcp-tool, hook, " +
              "or capability (catchall for cost-bounded summary calls with >10 new exports).",
          },
          consumersFound: {
            type: "array",
            items: { type: "string" },
            default: [],
            description:
              "List of callsites / consumers found in the codebase. Each entry is a short description " +
              "(e.g. 'src/foo.ts:42 — passes value via …'). Empty array when no consumers are found.",
          },
          classification: {
            type: "string",
            enum: ["Adopted", "Missing consumers"],
            description:
              "Adoption classification: 'Adopted' when consumers found; 'Missing consumers' when none found.",
          },
          notes: {
            type: "string",
            description:
              "Optional free-form rationale (e.g. 'wiring planned in mt#XXXX' or 'spec requires this to be registered in Y').",
          },
        },
        required: ["symbol", "kind", "consumersFound", "classification"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "conclude_review",
      description:
        "Signal the end of the review and provide a top-level summary. " +
        "Call this exactly once, after all submit_finding and submit_spec_verification calls. " +
        "event: 'APPROVE' when no blocking issues exist and the PR is ready to merge; " +
        "'REQUEST_CHANGES' when one or more blocking findings must be addressed before merge; " +
        "'COMMENT' only when you are the same App identity as the PR author (self-approval is " +
        "blocked by GitHub) — that is the only case where YOU should write COMMENT. A COMMENT " +
        "YOU write with zero BLOCKING submit_finding calls is reconciled to APPROVE and does NOT " +
        "hold the review back — express any genuine reservation as an actual BLOCKING finding, " +
        "not as prose in this call's summary. (Separately, a posted review can show COMMENT for a " +
        "reason you never wrote: the service demotes a REQUEST_CHANGES verdict to COMMENT when a " +
        "later pass invalidates its BLOCKING finding — that service-demoted COMMENT does not " +
        "auto-promote to APPROVE.)",
      parameters: {
        type: "object",
        properties: {
          event: {
            type: "string",
            enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
            description:
              "Review conclusion: APPROVE (ready to merge, or zero BLOCKING findings — the two are " +
              "treated identically), REQUEST_CHANGES (one or more BLOCKING findings), or COMMENT " +
              "(write this only for the self-review case; a COMMENT you write with zero BLOCKING " +
              "findings is reconciled to APPROVE). A service-demoted COMMENT — one you did not " +
              "write, produced when a downstream pass invalidates a REQUEST_CHANGES verdict's " +
              "BLOCKING finding — does not auto-promote.",
          },
          summary: {
            type: "string",
            minLength: 1,
            description:
              "2-5 sentence summary of the review. Describe overall quality, highlight key findings, and state whether the PR can proceed.",
          },
        },
        required: ["event", "summary"],
        additionalProperties: false,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Discriminated union and runtime parser
// ---------------------------------------------------------------------------

/**
 * A parsed, validated output tool call from the reviewer model.
 *
 * This discriminated union represents exactly one structured call emitted by
 * the model. The `name` field identifies the tool; `args` carries the
 * validated, typed arguments.
 */
export type ReviewToolCall =
  | { name: "submit_finding"; args: SubmitFindingArgs }
  | { name: "submit_inline_comment"; args: SubmitInlineCommentArgs }
  | { name: "submit_spec_verification"; args: SubmitSpecVerificationArgs }
  | { name: "submit_documentation_impact"; args: SubmitDocumentationImpactArgs }
  | { name: "submit_adoption_sweep"; args: SubmitAdoptionSweepArgs }
  | { name: "conclude_review"; args: ConcludeReviewArgs }
  | { name: "submit_thread_resolve"; args: SubmitThreadResolveArgs };

/** Schema registry for runtime dispatch. */
const TOOL_SCHEMAS = {
  submit_finding: SubmitFindingArgsSchema,
  submit_inline_comment: SubmitInlineCommentArgsSchema,
  submit_spec_verification: SubmitSpecVerificationArgsSchema,
  submit_documentation_impact: SubmitDocumentationImpactArgsSchema,
  submit_adoption_sweep: SubmitAdoptionSweepArgsSchema,
  conclude_review: ConcludeReviewArgsSchema,
  submit_thread_resolve: SubmitThreadResolveArgsSchema,
} as const;

type ToolName = keyof typeof TOOL_SCHEMAS;

function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name);
}

/**
 * Parse and validate a raw model tool call into a typed `ReviewToolCall`.
 *
 * @param name     - The tool name emitted by the model (e.g. "submit_finding").
 * @param argsJson - The raw JSON string of arguments from the model.
 * @returns The discriminated-union tool call with validated args.
 * @throws If `name` is not one of the six known output tools.
 * @throws If `argsJson` is not valid JSON.
 * @throws If the parsed args fail zod validation for the named tool.
 */
export function parseToolCall(name: string, argsJson: string): ReviewToolCall {
  if (!isToolName(name)) {
    const known = Object.keys(TOOL_SCHEMAS).join(", ");
    throw new Error(`Unknown output tool name: "${name}". Known tools are: ${known}`);
  }

  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(argsJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse argsJson for tool "${name}" as JSON: ${message}`);
  }

  const schema = TOOL_SCHEMAS[name];
  const result = schema.safeParse(rawArgs);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid args for tool "${name}":\n${issues}`);
  }

  // Each branch narrows name and args together so TypeScript can verify the
  // discriminated union is well-formed.
  switch (name) {
    case "submit_finding":
      return { name, args: result.data as SubmitFindingArgs };
    case "submit_inline_comment":
      return { name, args: result.data as SubmitInlineCommentArgs };
    case "submit_spec_verification":
      return { name, args: result.data as SubmitSpecVerificationArgs };
    case "submit_documentation_impact":
      return { name, args: result.data as SubmitDocumentationImpactArgs };
    case "submit_adoption_sweep":
      return { name, args: result.data as SubmitAdoptionSweepArgs };
    case "conclude_review":
      return { name, args: result.data as ConcludeReviewArgs };
    case "submit_thread_resolve":
      return { name, args: result.data as SubmitThreadResolveArgs };
  }
}

/** Tool name for the batched spec-verification form (mt#3545). */
export const BATCHED_SPEC_VERIFICATION_TOOL = "submit_spec_verifications";

/** Name of the batched findings tool (mt#4979). */
export const BATCHED_FINDINGS_TOOL = "submit_findings";

/**
 * The batch tools and how each expands into singular `ReviewToolCall`s.
 *
 * A registry rather than a chain of `if`s so adding a third batch tool is one
 * entry, and so the set is enumerable — `providers.ts` needs to know which
 * names are batch tools without duplicating the list, and the census test in
 * `output-tools.test.ts` asserts every entry here is a REGISTERED tool
 * definition (a batch tool the model is never offered is dead code, and a
 * definition with no expansion would reach `parseToolCall` and throw on the
 * batch shape).
 */
export type BatchExpansionResult =
  | { success: true; calls: ReviewToolCall[] }
  | { success: false; error: z.ZodError };

/**
 * Each entry validates the batch args and expands them in ONE closure, so the
 * schema and its expansion cannot drift apart and neither needs a widened
 * parameter type — the pairing is what a `{ schema, expand }` record could not
 * express without erasing the arg type.
 */
export type BatchExpander = (rawArgs: unknown) => BatchExpansionResult;

export const BATCHED_TOOL_EXPANSIONS: Record<string, BatchExpander> = {
  [BATCHED_SPEC_VERIFICATION_TOOL]: (rawArgs) => {
    const result = SubmitSpecVerificationsArgsSchema.safeParse(rawArgs);
    if (!result.success) return { success: false, error: result.error };
    return {
      success: true,
      calls: result.data.verifications.map((args) => ({
        name: "submit_spec_verification" as const,
        args,
      })),
    };
  },
  [BATCHED_FINDINGS_TOOL]: (rawArgs) => {
    const result = SubmitFindingsArgsSchema.safeParse(rawArgs);
    if (!result.success) return { success: false, error: result.error };
    return {
      success: true,
      calls: result.data.findings.map((args) => ({ name: "submit_finding" as const, args })),
    };
  },
};

/**
 * Parse a raw model tool call into ONE OR MORE typed `ReviewToolCall`s (mt#3545).
 *
 * Identical to `parseToolCall` for every tool except the batched
 * `submit_spec_verifications`, which is EXPANDED here into N singular
 * `submit_spec_verification` calls. The batched form deliberately never appears
 * in the `ReviewToolCall` union: every downstream consumer — `compose-review`'s
 * gate parsing, `review-provenance`, `severity-recovery` — keeps matching the
 * singular shape it already handles, so batching costs the model one round
 * instead of N without touching the guard stack.
 *
 * Validation is per-entry by construction: the array element schema IS
 * `SubmitSpecVerificationArgsSchema`, so a malformed entry fails the whole call
 * with a path-qualified zod issue rather than being silently accepted.
 *
 * @throws on unknown tool name, unparseable JSON, or failed validation — same
 *   contract as `parseToolCall`, so the caller's error handling is unchanged.
 */
export function parseToolCallExpanded(name: string, argsJson: string): ReviewToolCall[] {
  // mt#4979 generalised this from a single batch tool to a set. There are now
  // two (`submit_spec_verifications`, `submit_findings`) and the expansion is
  // identical in shape for both: validate the batch schema, then map each entry
  // to a singular ReviewToolCall so every downstream consumer keeps matching
  // the shape it already handles.
  const expand = BATCHED_TOOL_EXPANSIONS[name];
  if (expand === undefined) {
    return [parseToolCall(name, argsJson)];
  }

  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(argsJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse argsJson for tool "${name}" as JSON: ${message}`);
  }

  const result = expand(rawArgs);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid args for tool "${name}":\n${issues}`);
  }

  return result.calls;
}
