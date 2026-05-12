/**
 * Output tools for the reviewer model.
 *
 * Defines the four structured output tools the reviewer model uses to compose
 * a PR review. Each tool corresponds to one kind of review artifact:
 *   - submit_finding: a discrete review finding with severity and location
 *   - submit_inline_comment: a targeted inline comment on a specific line
 *   - submit_spec_verification: a verification result for one spec criterion
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
 */
export const SubmitSpecVerificationArgsSchema = z.object({
  /** The exact text of the success criterion being evaluated. */
  criterion: z.string().min(1),

  /**
   * Verification result:
   *   "Met"     — the PR satisfies this criterion
   *   "Not Met" — the PR does not satisfy this criterion
   *   "N/A"     — the criterion does not apply to this PR (e.g., out of scope)
   */
  status: z.enum(["Met", "Not Met", "N/A"]),

  /**
   * Evidence supporting the verdict. Reference specific file paths, line
   * numbers, or code snippets that demonstrate whether the criterion is met.
   */
  evidence: z.string().min(1),
});

export type SubmitSpecVerificationArgs = z.infer<typeof SubmitSpecVerificationArgsSchema>;

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
   *   "COMMENT"          — observations only; no explicit approve or block
   *                        (use when the reviewer cannot make a merge decision)
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
 * The four output tools registered with the model for structured review
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
        "'N/A' if the criterion does not apply to this PR. " +
        "evidence must reference specific file paths or code to justify the verdict.",
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
            enum: ["Met", "Not Met", "N/A"],
            description:
              "Verification result: Met, Not Met, or N/A (criterion does not apply to this PR).",
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
      name: "conclude_review",
      description:
        "Signal the end of the review and provide a top-level summary. " +
        "Call this exactly once, after all submit_finding and submit_spec_verification calls. " +
        "event: 'APPROVE' when no blocking issues exist and the PR is ready to merge; " +
        "'REQUEST_CHANGES' when one or more blocking findings must be addressed before merge; " +
        "'COMMENT' when providing observations only, without an explicit approve or block decision.",
      parameters: {
        type: "object",
        properties: {
          event: {
            type: "string",
            enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
            description:
              "Review conclusion: APPROVE (ready to merge), REQUEST_CHANGES (blocking issues found), or COMMENT (observations only).",
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
  | { name: "conclude_review"; args: ConcludeReviewArgs }
  | { name: "submit_thread_resolve"; args: SubmitThreadResolveArgs };

/** Schema registry for runtime dispatch. */
const TOOL_SCHEMAS = {
  submit_finding: SubmitFindingArgsSchema,
  submit_inline_comment: SubmitInlineCommentArgsSchema,
  submit_spec_verification: SubmitSpecVerificationArgsSchema,
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
 * @throws If `name` is not one of the five known output tools.
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
    case "conclude_review":
      return { name, args: result.data as ConcludeReviewArgs };
    case "submit_thread_resolve":
      return { name, args: result.data as SubmitThreadResolveArgs };
  }
}
