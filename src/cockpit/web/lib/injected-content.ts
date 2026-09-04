/**
 * Injected-content detector (mt#2791; coverage widened mt#3322).
 *
 * Harness-injected content — slash-command wrappers, local-command output,
 * skill-body preambles, and `<system-reminder>` blocks — would otherwise
 * render as full-weight USER prose in the cockpit conversation view: a
 * `/plan-task` invocation injects the entire skill body (~20 screens of
 * Markdown) before any real work appears, and a bare `/model` injects three
 * separate turns of raw XML, burying the conversation's real signal.
 *
 * `splitInjectedContent` classifies one user turn's raw text into an ordered
 * list of {@link TextSegment}s — genuine operator PROSE, and INJECTED spans
 * labeled by origin — so the renderer (`ConversationView.tsx`) can collapse
 * the injected spans behind a muted, expandable header while leaving prose
 * untouched. Pure, dependency-free apart from the shared tag inventory and
 * the ANSI stripper.
 *
 * Detection is deliberately conservative — anchored patterns, not
 * substring-anywhere matching:
 *   - The command wrapper, local-command blocks, and the skill-body preamble
 *     ("Base directory for this skill:") are anchored to the START of the
 *     turn's remaining text only — that mirrors how the harness actually
 *     injects them. Genuine prose that happens to mention either mid-sentence
 *     is NOT matched: the anchor is turn-start, not "found anywhere."
 *   - `<system-reminder>...</system-reminder>` blocks are matched WHEREVER
 *     they appear in the remaining text — the harness can interleave several
 *     reminders with real content in one turn — but the tag itself is a
 *     highly distinctive token vanishingly unlikely to appear in
 *     operator-authored prose, so a non-anchored match stays conservative in
 *     practice.
 *
 * **Why the wrapper match is order-tolerant (mt#3322).** The original
 * implementation encoded the wrapper as a FIXED sequence beginning with
 * `<command-message>`. The harness emits both orderings, and the far more
 * common one leads with `<command-name>` — so the anchored pattern silently
 * failed on it and the raw XML fell through to the prose path. Measured over
 * the local transcript corpus before the fix: of 134 turn-start command
 * wrappers, 124 led with `command-name` and NONE of those were detected; all
 * 118 `local-command-stdout` and 125 `local-command-caveat` turns were
 * likewise undetected. This module now consumes wrapper blocks in whatever
 * order they arrive, from the shared inventory in
 * `@minsky/shared/harness-markup`.
 *
 * Unrecognized content is untouched: when nothing matches, `splitInjectedContent`
 * returns a single `{ type: "prose", text }` segment carrying the ORIGINAL
 * string verbatim — the "renders exactly as today" success criterion. ANSI
 * stripping is applied ONLY to injected-span content, never to prose, so that
 * verbatim guarantee is unaffected. A turn that mixes an injected prefix with
 * genuine prose (e.g. a slash-command wrapper followed by operator-typed
 * continuation text) splits into an injected segment plus a separate prose
 * segment — the injected span collapses, the prose does not.
 *
 * **Bash-mode turns (mt#4058).** A `!`-prefixed command the operator types in
 * the prompt is recorded as two `user` turns — `<bash-input>` carrying what
 * they typed, then `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`
 * carrying the captured terminal output. Neither was in the tag inventory, so
 * both fell to the verbatim-prose path and rendered as raw XML under the
 * operator's own label — the output turn especially, which contains none of
 * their words. The output pair arrives CONCATENATED in one turn with one half
 * routinely empty, which is why the turn-start loop consumes repeatedly and
 * why an empty block is consumed WITHOUT emitting a span.
 *
 * @see mt#2791 — this module
 * @see mt#3322 — order-tolerant wrapper matching, local-command kinds, ANSI stripping
 * @see mt#4058 — the bash-mode family and empty-block suppression
 * @see packages/shared/src/harness-markup.ts — the shared tag inventory
 * @see packages/domain/src/transcripts/text-snippet.ts (mt#2784) — sibling detector
 *   for the conversation-LABEL surface (discards harness markup entirely rather
 *   than preserving it for an expandable view); it consumes the same inventory.
 * @see src/cockpit/web/widgets/ConversationView.tsx — the consumer
 */
import {
  BASH_MODE_TAGS,
  COMMAND_WRAPPER_TAGS,
  FORK_BOILERPLATE_TAGS,
  LOCAL_COMMAND_TAGS,
  TASK_NOTIFICATION_TAGS,
  tagBlockSource,
  tagOpenSource,
} from "@minsky/shared/harness-markup";
import { INTERRUPTION_NOTICE_PREFIX } from "@minsky/shared/minsky-notices";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { stripAnsi } from "@minsky/shared/strip-ansi";

/** Origin classification for one injected span. */
export type InjectedContentKind =
  | "command"
  | "skill-body"
  | "system-reminder"
  | "local-command-output"
  | "local-command-caveat"
  | "bash-command"
  | "bash-output"
  | "bash-error"
  | "task-notification"
  | "fork-boilerplate"
  | "session-notice";

/** Defensive bound on how many wrapper blocks one turn-start run may consume.
 * The harness emits at most four (`command-name` / `command-message` /
 * `command-args` / `skill-format`); the cap keeps a pathological input from
 * driving an unbounded scan. Every iteration consumes at least one character,
 * so this is a belt-and-braces limit, not a termination requirement.
 */
const MAX_WRAPPER_BLOCKS = 8;

// The skill-body preamble, anchored to whatever remains after the (optional)
// wrapper run. Kept separate from the wrapper match so a bare preamble with no
// wrapper still matches — the pre-mt#3322 behavior.
const SKILL_PREAMBLE_RE = /^\s*Base directory for this skill:\s*(\S+)/i;

// NOT anchored — matched wherever it appears (see module docblock). Built
// fresh per call in splitSystemReminderBlocks (global-flagged regexes carry
// mutable `lastIndex` state across `.exec()` calls; a shared module-level
// instance would leak state between the many turns this runs over per render).
function systemReminderRegex(): RegExp {
  return new RegExp(tagBlockSource("system-reminder", true), "gi");
}

// Boundary marker for a multi-skill-concatenated turn: once a skill-body span
// is detected, its content stops at the NEXT recognized turn-start anchor
// rather than swallowing the rest of the turn. Deliberately narrower than the
// full wrapper inventory — only the two tags that actually LEAD a wrapper run
// (plus `<system-reminder>`) are boundaries, so a skill body mentioning
// `<command-args>` in prose is not cut short.
const NEXT_BOUNDARY_RE = new RegExp(
  `(?:${tagOpenSource("command-name")}|${tagOpenSource("command-message")}|${tagOpenSource("system-reminder")})`,
  "i"
);

/**
 * A `<task-notification>` block's envelope, taken apart (mt#4419).
 *
 * A backgrounded MCP call's notification IS that call's deferred tool result:
 * the harness wraps the tool's entire JSON payload in `<result>` and hands it
 * back as a turn. Carrying the pieces on the span lets the renderer put that
 * payload through the same JSON tree an INLINE tool result already gets,
 * instead of printing several thousand characters of raw XML and JSON.
 *
 * **Every field is parsed from the RAW body, before entity decoding, and only
 * the extracted leaves are decoded** — see {@link parseTaskNotification} for
 * why the order is load-bearing rather than incidental.
 */
export interface TaskNotificationParts {
  /** The harness's background-task id, e.g. `kef11dmwa`. */
  taskId: string | null;
  /** `completed`, `failed`, … */
  status: string | null;
  /** The harness's own one-line sentence. */
  summary: string | null;
  /**
   * Bare tool name recovered from the summary (`session_commit`), or null when
   * the summary names none. Bare is the form `ToolPayload`'s per-tool registry
   * is keyed on, so this is what the renderer passes as `toolName`.
   */
  toolName: string | null;
  /** Inner text of `<result>` — the tool's payload, entity-decoded. */
  result: string | null;
  /**
   * Everything in the body the four tags above did NOT account for, decoded;
   * null when they accounted for all of it.
   *
   * This is what keeps mt#2791's demote-never-drop contract true once the
   * renderer stops printing the body verbatim: a notification shape this parse
   * does not model — the `<output-file>` variant, a `<tool-use-id>`, anything
   * the harness adds later — still reaches the reader rather than vanishing
   * because a structured view had no slot for it.
   */
  remainder: string | null;
}

/** One detected injected span: a muted collapsed header + its full content. */
export interface InjectedSpan {
  kind: InjectedContentKind;
  /** One-line muted header label, e.g. "command: /model". */
  label: string;
  /** Full content of the span, rendered on expand (harness wrapper tags stripped). */
  content: string;
  /**
   * Structured parts, for the kinds that have them (today: `task-notification`).
   * Absent for every other kind, and absent when the parse found nothing usable —
   * the renderer falls back to rendering `content` as prose, which is what every
   * kind did before mt#4419.
   */
  notification?: TaskNotificationParts;
}

/** One segment of a turn's text after injected-content classification. */
export type TextSegment =
  | { type: "prose"; text: string }
  | { type: "injected"; span: InjectedSpan };

/**
 * The generic noun for each injected kind — the vocabulary of harness origins,
 * in ONE place (mt#3374).
 *
 * Two surfaces name these: the collapsed span's own header (built below, which
 * appends the specific command or skill name where it has one), and the turn's
 * origin label (`./turn-origin.ts`, which wants the bare noun). PR #2442 R1
 * caught them drifting — a caveat span read `harness caveat` while its turn
 * header read `command caveat`, two names for one thing. Deriving both from
 * here is what makes that drift impossible rather than merely fixed.
 */
export const INJECTED_KIND_NOUN: Record<InjectedContentKind, string> = {
  command: "command",
  "skill-body": "skill body",
  "system-reminder": "system reminder",
  "local-command-output": "command output",
  "local-command-caveat": "harness caveat",
  // mt#4058. The operator TYPED the bash command, so "bash command" names an
  // origin the way "command" already does for a slash invocation — the turn is
  // theirs, but its content is a command rather than prose. Its OUTPUT is not
  // theirs at all, and gets the same noun the slash-command path uses.
  "bash-command": "bash command",
  "bash-output": "command output",
  "bash-error": "command error",
  "task-notification": "task notification",
  // mt#4072. "harness caveat", the SAME noun `local-command-caveat` carries,
  // because it is the same thing: boilerplate the HARNESS addressed to the
  // model. Deliberately not a new word — the precedent already names this
  // class, and the naming criterion asked for the precedent rather than
  // vocabulary. Contrast `session-notice` below, which is separate precisely
  // because that text is MINSKY's own rather than the harness's.
  "fork-boilerplate": "harness caveat",
  // NOT "harness notice" (mt#3396): this text is MINSKY's own
  // (`INTERRUPTION_NOTICE_TEXT`), not the harness's. Naming it "harness" would
  // layer a second misattribution on top of the one this task removes — the
  // whole point is that a notice Minsky wrote must not be presented as someone
  // else's words, whether that someone is the operator or the harness.
  "session-notice": "session notice",
};

/**
 * Per-tag presentation for a whole-block tag at turn start.
 *
 * Covers the local-command pair and, since mt#3396, `task-notification` — one
 * table and one matcher rather than a parallel path per tag family, because
 * they are the same shape (a paired tag whose entire block leads the turn) and
 * a second code path is how the two tag lists this module consumes drifted
 * apart in the first place.
 */
interface TurnStartTagPresentation {
  kind: InjectedContentKind;
  /**
   * The collapsed header's label: a fixed noun, or one derived from the
   * block's own body. The derived form exists so a bash invocation names the
   * command in its header the way `command: /model` already does — collapsing
   * a turn is only acceptable when the header says what was collapsed.
   */
  label: string | ((body: string, parts?: TaskNotificationParts) => string);
  /**
   * Decode HTML entities in the block's body before it is rendered (mt#4417).
   *
   * Opt-in per tag rather than applied to every block, because it is only
   * correct where the harness is known to escape: a body that legitimately
   * contains the literal text `&lt;` would otherwise be silently rewritten.
   */
  decodeEntities?: boolean;
  /**
   * Take the block's RAW body apart into structured parts, carried on the span
   * for the renderer (mt#4419). Optional: a tag whose body is unstructured text
   * declares none, and its span carries none.
   *
   * The parts are computed ONCE, here, and handed to `label` as its second
   * argument — so a label derived from the same structure does not re-parse.
   */
  parts?: (body: string) => TaskNotificationParts;
}

/**
 * Header label for a bash invocation: the command itself, bounded.
 *
 * Truncates from the HEAD — `safeTruncate`'s `side` defaults to `"tail"`, which
 * keeps the LAST `maxLen` code units, so a long command would render its
 * trailing arguments with the program name dropped (`bash: …--since='x'`).
 * The whole point of the header is to say which command was collapsed, and the
 * word that answers that is the first one. PR #2935 R1.
 */
function bashCommandLabel(body: string): string {
  const firstLine = body.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return INJECTED_KIND_NOUN["bash-command"];
  const shown = safeTruncate(firstLine, BASH_LABEL_MAX_CHARS, "head");
  // An ellipsis only when something was actually dropped, so a header that
  // fits is not made to look cut off.
  return `bash: ${shown}${shown.length < firstLine.length ? "…" : ""}`;
}

/** Keeps a long one-liner from pushing the rest of the header off the row. */
const BASH_LABEL_MAX_CHARS = 72;

/** Same job as {@link BASH_LABEL_MAX_CHARS}, for the notification summary row. */
const TASK_NOTIFICATION_LABEL_MAX_CHARS = 72;

/** First `<tag>…</tag>` body in `body`, trimmed; `null` when absent or empty. */
function firstTagText(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(body);
  const text = match?.[1]?.trim();
  return text !== undefined && text.length > 0 ? text : null;
}

/** The envelope elements {@link parseTaskNotification} models. */
const TASK_NOTIFICATION_PART_TAGS = ["task-id", "status", "summary", "result"] as const;

/**
 * The tool name a summary names, bare: `MCP task kef11dmw
 * (minsky/session_commit) completed.` → `session_commit`.
 *
 * BARE is the form that matters, and it is not an aesthetic choice —
 * `ToolPayload` looks its per-tool registry up as
 * `TOOL_RESULT_RENDERERS[parseToolName(toolName).name]`, and `parseToolName`
 * only knows the harness's `mcp__server__tool` form. It does not know this
 * `server/tool` slash form, so a name handed over unsplit would never match a
 * registered renderer and would fail silently — the generic tree renders either
 * way, which is exactly the kind of miss nothing downstream reports.
 *
 * **The `server/tool` slash form is REQUIRED, not merely accepted (PR #3245 R1).**
 * An earlier version took any parenthetical that looked like an identifier,
 * which a summary containing an ordinary aside — a version, a note — could
 * satisfy. The failure mode of a wrong match is worse than the failure mode of
 * no match: a wrong name silently invokes some OTHER tool's renderer on this
 * payload, while no name falls through to the generic tree, which is a perfectly
 * good rendering. Requiring the slash is what makes the match evidence that this
 * really is the harness's `MCP task … (server/tool) …` shape rather than prose
 * that happens to have brackets in it.
 */
function toolNameFromSummary(summary: string): string | null {
  const parenthesized = /\(([^)]*)\)/.exec(summary)?.[1]?.trim();
  if (parenthesized === undefined) return null;
  const [server, ...rest] = parenthesized.split("/");
  const bare = rest.join("/").trim();
  if (server === undefined || server.trim().length === 0 || rest.length !== 1) return null;
  return /^[A-Za-z0-9_.-]+$/.test(bare) ? bare : null;
}

/**
 * Take a `<task-notification>` body apart into {@link TaskNotificationParts} (mt#4419).
 *
 * **`body` must be the RAW block, before entity decoding — this is the same
 * ordering constraint PR #3239 R1 established for the label, and for the same
 * reason.** Decoding manufactures tags: a `<result>` payload carrying the
 * literal text `&lt;summary&gt;…&lt;/summary&gt;` — how a commit message
 * quoting an XML tag arrives — decodes into a REAL `<summary>` element that
 * `firstTagText` cannot tell from the envelope's own. Structure is read here,
 * where the envelope's tags are the only real ones; each extracted leaf is
 * decoded afterward, individually.
 *
 * `remainder` is what makes this parse safe to render structurally: whatever
 * the four modelled tags did not consume is carried out rather than dropped, so
 * an unmodelled shape (the `<output-file>` variant, a `<tool-use-id>`, a tag the
 * harness adds next month) still reaches the reader.
 */
function parseTaskNotification(body: string): TaskNotificationParts {
  const summaryRaw = firstTagText(body, "summary");
  const summary = summaryRaw === null ? null : decodeHarnessEntities(summaryRaw);
  const resultRaw = firstTagText(body, "result");
  const statusRaw = firstTagText(body, "status");
  const taskIdRaw = firstTagText(body, "task-id");

  // NOT global, deliberately (PR #3245 R1 non-blocking). The reviewer read the
  // missing `g` as an oversight that lets a REPEATED modelled tag leak into the
  // remainder. It does — and that leak is the correct behaviour, because
  // `firstTagText` surfaces only the FIRST occurrence of each. Strip exactly the
  // one occurrence that was surfaced, and a duplicate `<status>` still reaches
  // the reader through the remainder; strip globally, and it is surfaced nowhere
  // and removed everywhere, which is a silent drop of the kind mt#2791 exists to
  // prevent. The two halves have to agree on the count, and `firstTagText` is
  // the one that sets it.
  const remainderRaw = TASK_NOTIFICATION_PART_TAGS.reduce(
    (rest, tag) => rest.replace(new RegExp(tagBlockSource(tag), "i"), ""),
    body
  ).trim();

  return {
    taskId: taskIdRaw === null ? null : decodeHarnessEntities(taskIdRaw),
    status: statusRaw === null ? null : decodeHarnessEntities(statusRaw),
    summary,
    toolName: summary === null ? null : toolNameFromSummary(summary),
    result: resultRaw === null ? null : decodeHarnessEntities(resultRaw),
    remainder: remainderRaw.length > 0 ? decodeHarnessEntities(remainderRaw) : null,
  };
}

/**
 * Header label for a background-task completion notice (mt#4417).
 *
 * The harness writes a one-line `<summary>` into every notification — "MCP task
 * kef11dmw (minsky/session_commit) completed." — and then, for an MCP task, a
 * `<result>` element carrying the tool's ENTIRE JSON payload. Labelling the row
 * with the fixed noun put the useless half in the header and the several-thousand
 * character half behind the disclosure, so the only way to learn WHICH task
 * finished was to open a wall of JSON. The summary is what the reader wants and
 * the harness has already written it.
 *
 * **`body` is the UNDECODED block (PR #3239 R1).** Entity decoding must not run
 * before this function, because it manufactures tags: a `<result>` payload
 * carrying the literal text `&lt;summary&gt;…&lt;/summary&gt;` — which is how a
 * commit message quoting an XML tag arrives — decodes into a REAL `<summary>`
 * element that `firstTagText` cannot tell from the envelope's own. Structure is
 * read from the raw body, where the envelope's tags are the only real ones; only
 * the extracted leaf text is decoded, below.
 */
function taskNotificationLabel(body: string, parts?: TaskNotificationParts): string {
  // `parts` is what the presentation table supplies; the fallback parse keeps
  // this function correct on its own, for a caller that has only the body.
  const { summary, status } = parts ?? parseTaskNotification(body);
  if (summary === null) return INJECTED_KIND_NOUN["task-notification"];

  // The harness's summary usually ends in the status word ("… completed."), so
  // naming it again would only lengthen the row. Append it when the summary does
  // NOT already carry it — which is precisely the case a reader most needs to
  // see, a task that ended some other way.
  //
  // Both are already decoded: `parseTaskNotification` reads structure from the
  // raw body and decodes only the leaves it extracts.
  const headline =
    status !== null && !summary.toLowerCase().includes(status.toLowerCase())
      ? `${summary} (${status})`
      : summary;

  // Truncate from the HEAD for the same reason `bashCommandLabel` does: the
  // words that identify the task come first.
  const shown = safeTruncate(headline, TASK_NOTIFICATION_LABEL_MAX_CHARS, "head");
  const noun = INJECTED_KIND_NOUN["task-notification"];
  return `${noun}: ${shown}${shown.length < headline.length ? "…" : ""}`;
}

/**
 * The HTML entities the harness escapes into a notification body: five
 * characters, six mappings — the apostrophe arrives as either `&apos;` or
 * the numeric `&#39;` (PR #3239 R2).
 *
 * The notification envelope is XML-shaped, so the harness escapes `<` and its
 * siblings before embedding a tool result inside it. Nothing on our side
 * reverses that: verified for the mt#4417 report's own commit, whose message in
 * git reads `` `<repoPath>/.git` `` while the stored turn carries
 * `&lt;repoPath&gt;` — and a grep across `packages/domain/src/transcripts` and
 * this directory finds no HTML-escaping of our own, so the entity is introduced
 * upstream of storage and arrives here already encoded.
 *
 * ORDER MATTERS, and `&amp;` must stay last: decoding it first would turn a
 * literal `&amp;lt;` into `<` rather than the `&lt;` the source actually encoded.
 */
const HARNESS_ENTITY_DECODINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&#0*39;/g, "'"],
  [/&amp;/g, "&"],
];

function decodeHarnessEntities(text: string): string {
  return HARNESS_ENTITY_DECODINGS.reduce((acc, [re, char]) => acc.replace(re, char), text);
}

const TURN_START_TAG_PRESENTATION: Record<string, TurnStartTagPresentation> = {
  "local-command-stdout": {
    kind: "local-command-output",
    label: INJECTED_KIND_NOUN["local-command-output"],
  },
  "local-command-caveat": {
    kind: "local-command-caveat",
    label: INJECTED_KIND_NOUN["local-command-caveat"],
  },
  // mt#4058 — the `!`-prefixed bash-mode family. Both output halves arrive in
  // ONE turn, so the turn-start loop in `splitInjectedContent` consumes them
  // as two consecutive blocks; each is listed here independently.
  "bash-input": { kind: "bash-command", label: bashCommandLabel },
  "bash-stdout": { kind: "bash-output", label: INJECTED_KIND_NOUN["bash-output"] },
  "bash-stderr": { kind: "bash-error", label: INJECTED_KIND_NOUN["bash-error"] },
  "task-notification": {
    kind: "task-notification",
    label: taskNotificationLabel,
    decodeEntities: true,
    parts: parseTaskNotification,
  },
  // mt#4072 — the worker-fork preamble. A plain block with a static label: it
  // has no structured envelope to take apart (unlike `task-notification`) and
  // no operator-typed content to surface (unlike `bash-input`), so the header
  // is the whole presentation and the 947 characters behind it stay collapsed.
  "fork-boilerplate": {
    kind: "fork-boilerplate",
    label: INJECTED_KIND_NOUN["fork-boilerplate"],
  },
};

function skillNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0);
  return segments[segments.length - 1] || path;
}

function findNextBoundary(text: string, fromIndex: number): number {
  const tail = text.slice(fromIndex);
  const match = NEXT_BOUNDARY_RE.exec(tail);
  return match ? fromIndex + match.index : text.length;
}

interface PrefixMatch {
  consumedLength: number;
  /**
   * The span to render, or `undefined` when the block was consumed but has
   * nothing worth showing (mt#4058). Consuming without emitting is the point:
   * an empty `<bash-stdout></bash-stdout>` must not fall through to the prose
   * path as raw tags, and must not render a collapsed header with nothing
   * behind it either.
   */
  span?: InjectedSpan;
}

// Turn-start matchers, compiled ONCE at module load rather than per call
// (PR #2403 R1, non-blocking): `splitInjectedContent` runs over every user
// turn on every render, and the wrapper scan loops over all four tags per
// block consumed. These are safe to share because none carries the `g` flag —
// only global-flagged regexes hold mutable `lastIndex` state between calls
// (which is why `systemReminderRegex()` above is still built per call).
const WRAPPER_BLOCK_MATCHERS: ReadonlyArray<{ tag: string; re: RegExp }> = COMMAND_WRAPPER_TAGS.map(
  (tag) => ({ tag, re: new RegExp(`^${tagBlockSource(tag, true)}`, "i") })
);

const TURN_START_TAG_MATCHERS: ReadonlyArray<{ tag: string; re: RegExp }> = [
  ...LOCAL_COMMAND_TAGS,
  ...BASH_MODE_TAGS,
  ...TASK_NOTIFICATION_TAGS,
  // mt#4072. Turn-START is the right list for this one: measured 15 of 15, the
  // block opens the turn and the parent's directive follows it, so matching
  // here consumes exactly the boilerplate and leaves the directive to the prose
  // path. A whole-turn matcher would have eaten the directive with it.
  ...FORK_BOILERPLATE_TAGS,
].map((tag) => ({ tag, re: new RegExp(`^\\s*${tagBlockSource(tag, true)}`, "i") }));

/** One wrapper block matched at the head of `text`, whichever tag it is. */
function matchOneWrapperBlock(text: string): { tag: string; body: string; length: number } | null {
  for (const { tag, re } of WRAPPER_BLOCK_MATCHERS) {
    const match = re.exec(text);
    if (match) return { tag, body: (match[1] ?? "").trim(), length: match[0].length };
  }
  return null;
}

interface WrapperRun {
  consumed: number;
  /** First-seen body per wrapper tag, e.g. `command-name` -> "/model". */
  parts: Map<string, string>;
}

/**
 * Consume a run of consecutive command-wrapper blocks at the head of `text`,
 * in ANY order (see module docblock). Returns null when the text does not
 * start with one.
 */
function consumeWrapperRun(text: string): WrapperRun | null {
  const parts = new Map<string, string>();
  let consumed = 0;

  for (let i = 0; i < MAX_WRAPPER_BLOCKS; i++) {
    const rest = text.slice(consumed);
    const leadingWhitespace = /^\s*/.exec(rest)?.[0].length ?? 0;
    const block = matchOneWrapperBlock(rest.slice(leadingWhitespace));
    if (!block) break;
    // First occurrence wins — a duplicated tag in one run is malformed input,
    // and preferring the first keeps the label stable.
    if (!parts.has(block.tag)) parts.set(block.tag, block.body);
    consumed += leadingWhitespace + block.length;
  }

  return consumed > 0 ? { consumed, parts } : null;
}

/**
 * A whole-block harness tag at turn start — `<local-command-stdout>`,
 * `<local-command-caveat>`, or `<task-notification>`.
 */
function matchTurnStartTagBlock(text: string): PrefixMatch | null {
  for (const { tag, re } of TURN_START_TAG_MATCHERS) {
    const match = re.exec(text);
    if (!match) continue;
    const presentation = TURN_START_TAG_PRESENTATION[tag];
    if (!presentation) continue;
    // Terminal control bytes are captured verbatim by the harness; strip
    // them so they don't reach the DOM as replacement glyphs.
    const stripped = stripAnsi((match[1] ?? "").trim());
    // Decoding happens AFTER the label is derived, never before (PR #3239 R1).
    // Decoding first would let an escaped `&lt;summary&gt;` inside a tool
    // result's JSON become a real `<summary>` tag, which the label's own
    // extraction would then read as the envelope's — so a payload could name
    // the row. The label reads `stripped`; only the RENDERED body is decoded.
    const content = presentation.decodeEntities ? decodeHarnessEntities(stripped) : stripped;
    // An empty block is consumed and dropped, never rendered (mt#4058). The
    // bash pair routinely carries one empty half — a `<bash-stdout></bash-stdout>`
    // beside real stderr, or the reverse — and a collapsed header over nothing
    // is noise the reader has to open to discover is empty.
    if (content.length === 0) return { consumedLength: match[0].length };
    // Parsed from `stripped` for the same reason the label is — see below, and
    // `parseTaskNotification`'s docblock. Computed once and shared with the
    // label so the body is taken apart a single time per span.
    const parts = presentation.parts?.(stripped);
    return {
      consumedLength: match[0].length,
      span: {
        kind: presentation.kind,
        // Derived from `stripped`, NOT `content` (PR #3239 R1). Decoding runs
        // before this point and can manufacture tags out of escaped text inside
        // the block's own payload, which a tag-reading label function would then
        // mistake for the envelope's. Every label function reads structure, so
        // all of them get the raw body; the ones on undecoded tags see no
        // difference, since `content === stripped` there.
        label:
          typeof presentation.label === "function"
            ? presentation.label(stripped, parts)
            : presentation.label,
        content,
        ...(parts !== undefined ? { notification: parts } : {}),
      },
    };
  }
  return null;
}

function matchTurnStartInjection(text: string): PrefixMatch | null {
  const run = consumeWrapperRun(text);
  const afterWrapper = run ? text.slice(run.consumed) : text;

  // A skill invocation is a wrapper run FOLLOWED BY the "Base directory..."
  // preamble; a bare slash command is the wrapper run alone. Checking the
  // preamble after consuming the run (rather than encoding both in one
  // pattern) is what lets the run stay order-tolerant.
  const skill = SKILL_PREAMBLE_RE.exec(afterWrapper);
  if (skill) {
    const preambleEnd = (run?.consumed ?? 0) + skill[0].length;
    const end = findNextBoundary(text, preambleEnd);
    return {
      consumedLength: end,
      span: {
        kind: "skill-body",
        label: `skill body: ${skillNameFromPath(skill[1] ?? "")}`,
        // Body only — the raw wrapper tags and the "Base directory..." line
        // are stripped from the expand view, matching the "expanding shows
        // the full Markdown" acceptance criterion rather than raw XML.
        content: stripAnsi(text.slice(preambleEnd, end).trim()),
      },
    };
  }

  if (run) {
    const name = run.parts.get("command-name") || run.parts.get("command-message") || "unknown";
    return {
      consumedLength: run.consumed,
      span: {
        kind: "command",
        label: `command: ${name}`,
        // Not a truncation: `run.consumed` is the exact end offset of the
        // wrapper run, summed from regex match lengths whose boundaries are
        // ASCII tag delimiters (`<`/`>`/`/`). It can never land mid-character,
        // so there is no surrogate pair to split.
        // eslint-disable-next-line custom/no-unsafe-string-truncation
        content: stripAnsi(text.slice(0, run.consumed).trim()),
      },
    };
  }

  const notice = matchSessionNotice(text);
  if (notice) return notice;

  return matchTurnStartTagBlock(text);
}

/**
 * Minsky's own resume-interruption notice, delivered through the input channel
 * and therefore recorded as a `user` turn (mt#3396).
 *
 * Anchored at turn start against the shared prefix constant, so operator prose
 * that quotes the notice mid-sentence is not matched — the same conservatism
 * the tag detectors above apply.
 *
 * **Bounded to the notice's own line, NOT the whole turn** (PR #2515 R1). The
 * notice is a single line — `INTERRUPTION_NOTICE_TEXT` is concatenated string
 * literals with no newline — and it is sent as its own input
 * (`sendDrivenSessionInput(record, INTERRUPTION_NOTICE_TEXT)` in
 * `driven-session-host.ts`), so in practice the turn IS the notice.
 *
 * The first cut consumed `text.length` on that reasoning, which made the
 * detector's correctness depend on an ASSUMPTION about the sender rather than
 * on the text in front of it: any trailing operator prose would have been
 * swallowed into the span and the whole turn relabeled harness-origin —
 * violating the prose-wins rule (SC5) for the one case that rule most needs to
 * hold, since the operator's words would vanish under Minsky's label. Bounding
 * to the line makes SC5 true by construction and costs nothing when the
 * assumption holds.
 */
function matchSessionNotice(text: string): PrefixMatch | null {
  if (!text.trimStart().startsWith(INTERRUPTION_NOTICE_PREFIX)) return null;
  // Search from where the notice actually STARTS, not from index 0 (PR #2515
  // R2). The guard above tests `trimStart()`, so a turn with leading whitespace
  // still matches — but scanning the raw text for the first `\n` would then
  // find the LEADING newline and yield `consumedLength === 0`, a zero-length
  // span that consumes nothing and silently disables detection for that turn.
  const noticeStart = text.length - text.trimStart().length;
  const newline = text.indexOf("\n", noticeStart);
  const consumedLength = newline === -1 ? text.length : newline;
  return {
    consumedLength,
    span: {
      kind: "session-notice",
      label: INJECTED_KIND_NOUN["session-notice"],
      // Not a truncation hazard: the cut is at a `\n` (or the end of the
      // string), never mid-character, so no surrogate pair can be split.
      // eslint-disable-next-line custom/no-unsafe-string-truncation
      content: stripAnsi(text.slice(0, consumedLength).trim()),
    },
  };
}

/**
 * Split `text` on `<system-reminder>` blocks wherever they occur, preserving
 * any surrounding prose as separate segments. Returns a single verbatim
 * `{ type: "prose", text }` segment when no reminder block is present — the
 * "renders exactly as today" fallback for the fully-unrecognized case.
 */
function splitSystemReminderBlocks(text: string): TextSegment[] {
  const re = systemReminderRegex();
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push(m);
    // A tag-pair match always consumes at least the tag markers, so this
    // can't zero-length-loop in practice — kept as a cheap safety net.
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (matches.length === 0) return [{ type: "prose", text }];

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      const prose = text.slice(cursor, match.index);
      if (prose.trim().length > 0) segments.push({ type: "prose", text: prose });
    }
    segments.push({
      type: "injected",
      span: {
        kind: "system-reminder",
        label: "system reminder",
        content: stripAnsi((match[1] ?? "").trim()),
      },
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ type: "prose", text: text.slice(cursor) });
  }
  return segments;
}

/**
 * Classify one user turn's raw text into an ordered list of prose/injected
 * segments. See module docblock for the detection rules and the "renders
 * exactly as today" fallback for unrecognized content.
 */
export function splitInjectedContent(text: string): TextSegment[] {
  if (!text) return [];

  const prefixSegments: TextSegment[] = [];
  let rest = text;
  let consumedAny = false;
  while (rest.length > 0) {
    const prefix = matchTurnStartInjection(rest);
    if (!prefix || prefix.consumedLength <= 0) break;
    // `consumedAny` is set whether or not a span was emitted: the text WAS
    // recognized, so it must not fall back to the verbatim-prose path below
    // just because the recognized block turned out to be empty (mt#4058).
    if (prefix.span) prefixSegments.push({ type: "injected", span: prefix.span });
    rest = rest.slice(prefix.consumedLength);
    consumedAny = true;
  }

  if (!consumedAny) {
    // Fast path: nothing turn-start-anchored matched. Hand the ENTIRE
    // original text to the system-reminder scan, which itself returns it
    // verbatim (single segment) when no reminder is present either.
    return splitSystemReminderBlocks(text);
  }
  if (rest.length > 0) {
    prefixSegments.push(...splitSystemReminderBlocks(rest));
  }
  return prefixSegments;
}
