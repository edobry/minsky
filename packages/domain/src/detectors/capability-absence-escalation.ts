/**
 * Capability-absence-escalation matcher — mt#3999.
 *
 * Recognizes one narrow, mechanizable slice of the
 * `assertion-without-verification` family (anchor mt#2544):
 *
 *   An ASK ROUTED TO THE OPERATOR whose justification asserts that a named
 *   capability, credential, tool or flag DOES NOT EXIST — "I have no OpenAI
 *   key", "bun doesn't give us this" — in a turn that consulted FEWER THAN TWO
 *   distinct channels.
 *
 * All three conjuncts are machine-checkable. The matcher does NOT judge whether
 * the claim is true. It says: you spent the operator's attention on a premise
 * that rests on one channel, and a second one is cheap.
 *
 * ## Why a THIRD phrase family, beside two that already exist
 *
 * Measured before writing this (mt#3999's planning pass ran both corpora against
 * the two recorded instances): `CAPABILITY_DEFERRAL_PATTERNS`
 * (`operator-deferral-detector.ts`, surface A) matches NEITHER, and
 * {@link ../detectors/negative-existence-claim | NEGATIVE_EXISTENCE_PATTERNS}
 * (mt#3918) matches neither either. The three shapes are genuinely distinct:
 *
 *   - surface A  — deferral of an ACTION      ("requires Railway access")
 *   - mt#3918    — absence of CALLERS         ("nothing calls onProgress")
 *   - here       — absence of a CAPABILITY    ("I have no OpenAI key")
 *
 * Widening either existing family to reach this shape would change a live
 * detector's behavior on a population this one has no business touching.
 *
 * ## Rung placement
 *
 * Rung 1, ADR-024's default stopping point, and on the merits: a phrase match, a
 * field equality on a tool result, and a channel count are all deterministic.
 * The discriminating power is the CONJUNCTION, not the phrase list — an
 * operator-routed ask resting on one channel is already suspicious independent
 * of how the sentence is worded, which is why {@link CAPABILITY_ABSENCE_PATTERNS}
 * is deliberately small.
 *
 * Do NOT answer a paraphrase miss by widening it. That is the arms race
 * ADR-024's `## Context` exists to end; Rung 2 (embedding nomination) is the
 * documented escalation and it is evidence-gated on MEASURED recurring misses,
 * which the evaluation stream exists to produce.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 * @see .minsky/hooks/operator-deferral-detector.ts — the adapter (surface E)
 */

/**
 * Capability-absence claim phrases, each capturing its SUBJECT in group 1.
 *
 * The subject is what makes the advisory actionable: the remedy is not "probe
 * something" but "run the second channel for THIS subject", so the renderer
 * needs the name. A pattern that cannot name its subject does not belong here.
 *
 * Deliberately SMALL, per the rung note above.
 */
export const CAPABILITY_ABSENCE_PATTERNS: readonly RegExp[] = [
  // "I have no OpenAI key", "we have no Railway token"
  /\b(?:I|we)\s+(?:have|had)\s+no\s+([\w.@/-]+(?:\s+[\w.@/-]+){0,2})\s+(?:key|token|credential|credentials|access|permission)\b/i,
  // "there is no <subject> flag/option/endpoint"
  /\bthere(?:\s+is|'s|\s+are)\s+no\s+([\w.@/-]+(?:\s+[\w.@/-]+){0,2})\s+(?:key|token|credential|flag|option|endpoint|api|tool|command)\b/i,
  // "bun doesn't give us this", "the API does not support that"
  /\b([\w.@/-]+)\s+(?:doesn'?t|does\s+not|don'?t|do\s+not)\s+(?:give|have|support|provide|expose|offer)\b/i,
  // "no <subject> credential is configured"
  /\bno\s+([\w.@/-]+)\s+(?:key|token|credential|credentials)\s+(?:is|are)?\s*(?:configured|available|present|set)\b/i,
  // "<subject> is not configured / available / installed"
  /\b([\w.@/-]+)\s+(?:is|are)\s+not\s+(?:configured|available|installed|supported|exposed)\b/i,
];

/**
 * Probe CHANNELS, not probe calls.
 *
 * The distinction is the whole design. `hasProbeEvidence` in the hook asks "did
 * the agent probe at all", and on this task's own anchor instance the answer was
 * YES — the agent called `config_credentials_list`, which is on that function's
 * probe list. That call is precisely what produced the false premise: it
 * returned exit-0, well-formed JSON that silently omitted the provider. So a
 * bare probe test would suppress this detector on the very instance it exists
 * for.
 *
 * What was missing was a SECOND, INDEPENDENT channel — `ai_providers_list` and
 * `ai_validate` both reported the credential present the whole time. Hence:
 * group probe-shaped calls into channel families and require TWO DISTINCT ones.
 * "Single-channel negative promoted to a capability claim" is the family's own
 * description of itself; this counts the channels.
 */
export const PROBE_CHANNEL_RULES: ReadonlyArray<{
  id: string;
  tool?: RegExp;
  command?: RegExp;
}> = [
  // The credential/config store. The channel that lied in the anchor instance.
  { id: "config-store", tool: /^mcp__minsky__config_(get|list|show|doctor|credentials_list)$/ },
  // The provider/validation surface — an INDEPENDENT read of the same fact.
  {
    id: "provider-validate",
    tool: /^mcp__minsky__ai_(providers_list|models_available|models_list|validate)$/,
  },
  { id: "memory", tool: /^mcp__minsky__memory_(search|similar)$/ },
  {
    id: "hosted-client",
    tool: /^(mcp__plugin_(railway|cloudflare)_|mcp__supabase__|mcp__github__get_me)/,
  },
  // Vendor docs / release notes — the second channel for a third-party tool or
  // flag claim, which is the one the bun `--changed` instance never ran.
  { id: "docs-knowledge", tool: /^(WebSearch|WebFetch|mcp__minsky__knowledge_(search|fetch))$/ },
  {
    id: "shell-capability",
    command: /\b(which|command\s+-v|type\s+-p|whoami|--version|--help|auth\s+status)\b/i,
  },
];

/** A tool call in the turn, reduced to what channel classification needs. */
export interface ProbeObservation {
  toolName: string;
  command?: string;
  /** `skill` input of a `Skill` call, when the call is one. */
  skill?: string;
}

/** One matched capability-absence claim. */
export interface AbsenceClaim {
  /** The matched text, capped so a record stays bounded. */
  phrase: string;
  /** The named subject the claim is about — what the second channel must check. */
  subject: string;
  /** Surrounding prose, so a reviewer can tell an assertion from a quotation. */
  excerpt: string;
}

export interface CapabilityAbsenceInput {
  /** The justification text of an operator-routed ask, markdown already elided. */
  justification: string;
  /** Probe-classifiable calls in the same turn. */
  probes: readonly ProbeObservation[];
}

export interface CapabilityAbsenceResult {
  matched: boolean;
  claims: AbsenceClaim[];
  /** The distinct probe channels the turn consulted. */
  channels: string[];
}

/** Longest phrase kept in a record; the excerpt carries the context. */
const MAX_PHRASE_CHARS = 120;

/** Characters of surrounding prose kept on each side of a matched phrase. */
const EXCERPT_CONTEXT_CHARS = 80;

/**
 * Longest subject name embedded in advisory text — see {@link secondChannelFor}.
 * Exported so the guard's `renderWorstCase` poses this axis at its real ceiling
 * instead of guessing one.
 */
export const MAX_SUBJECT_CHARS = 40;

/**
 * Below this many DISTINCT channels, an absence claim is single-channel.
 *
 * Two, not one: one channel is exactly the shape that failed. Not three —
 * that would demand more of an ordinary correct deferral than
 * `user-preferences.mdc §Probe before deferring` itself asks for.
 */
export const MIN_INDEPENDENT_CHANNELS = 2;

/**
 * Hosted-infra skill prefixes whose LOAD is a capability probe.
 *
 * Kept in step with `PROBE_SKILL_PREFIXES` in the hook rather than imported from
 * it: the hook may not import from the domain package's consumers, and this
 * module must stay free of hook imports so it can be tested without a transcript.
 */
export const PROBE_SKILL_PREFIXES: readonly string[] = [
  "railway",
  "cloudflare",
  "supabase",
  "github",
  "gh",
  "vercel",
  "aws",
  "gcloud",
  "fly",
  "heroku",
  "docker",
  "kubectl",
];

/** The channel family `observation` belongs to, or `null` when it is not a probe. */
export function classifyProbeChannel(observation: ProbeObservation): string | null {
  if (typeof observation.skill === "string") {
    const colon = observation.skill.indexOf(":");
    if (
      colon > 0 &&
      PROBE_SKILL_PREFIXES.includes(observation.skill.slice(0, colon).toLowerCase())
    ) {
      return "service-skill";
    }
  }

  for (const rule of PROBE_CHANNEL_RULES) {
    if (rule.tool?.test(observation.toolName)) return rule.id;
    if (
      rule.command &&
      typeof observation.command === "string" &&
      rule.command.test(observation.command)
    ) {
      return rule.id;
    }
  }
  return null;
}

/** The distinct probe channels `probes` consulted, in first-seen order. */
export function distinctProbeChannels(probes: readonly ProbeObservation[]): string[] {
  const seen: string[] = [];
  for (const probe of probes) {
    const channel = classifyProbeChannel(probe);
    if (channel && !seen.includes(channel)) seen.push(channel);
  }
  return seen;
}

/**
 * Every capability-absence claim in `prose`, with its subject and context.
 *
 * ONE match per pattern, following mt#3918's matcher: the record and the
 * advisory both enumerate claims one per line, so an unbounded count is an
 * unbounded render, and a second hit on the SAME pattern adds nothing a reader
 * acts on — the remedy is identical and the excerpt already shows where it sits.
 */
export function extractCapabilityAbsenceClaims(prose: string): AbsenceClaim[] {
  if (!prose) return [];
  const claims: AbsenceClaim[] = [];
  const seen = new Set<string>();

  for (const pattern of CAPABILITY_ABSENCE_PATTERNS) {
    const match = pattern.exec(prose);
    if (!match) continue;
    const phrase = match[0].slice(0, MAX_PHRASE_CHARS);
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    const start = Math.max(0, match.index - EXCERPT_CONTEXT_CHARS);
    const end = Math.min(prose.length, match.index + match[0].length + EXCERPT_CONTEXT_CHARS);
    claims.push({
      phrase,
      subject: (match[1] ?? "").trim(),
      excerpt: prose.slice(start, end),
    });
  }

  return claims;
}

/**
 * True when an `asks_create` RESULT body says the router sent it to the operator.
 *
 * Read from the RESULT, never the input: `asks_create` has no `routingTarget`
 * parameter — routing is computed downstream by `policyFirstRoute` from kind +
 * severity plus a policy phase — so the input side is genuinely blind to it. The
 * result is `RoutedAsk | SuspendedAsk | ElicitationClosedAsk`, and all three
 * carry the field.
 *
 * A policy-covered ask short-circuits to closed with `routingTarget: "policy"`,
 * so it fails this test and is EXCLUDED rather than counted — it never reaches a
 * human and spends none of the attention this detector is about.
 *
 * Parsed leniently on purpose: the body reaches a hook as transcript text that
 * may be a JSON object, a JSON string, or a rendered wrapper around one. A
 * failure to parse falls back to a field scan rather than to `false`, because
 * "this shape is unfamiliar" is evidence about the parser and silently answering
 * "not operator-routed" would make every unfamiliar rendering a silent miss.
 */
export function isOperatorRoutedAskResult(resultText: string): boolean {
  if (typeof resultText !== "string" || resultText.length === 0) return false;
  return /"routingTarget"\s*:\s*"operator"/.test(resultText);
}

/**
 * Combine the conjuncts the matcher owns: a capability-absence claim in the
 * justification, and fewer than {@link MIN_INDEPENDENT_CHANNELS} distinct
 * channels consulted.
 *
 * The routed-outcome conjunct is applied by the caller, which owns the
 * transcript join — see {@link isOperatorRoutedAskResult}.
 */
export function detectCapabilityAbsenceEscalation(
  input: CapabilityAbsenceInput
): CapabilityAbsenceResult {
  const claims = extractCapabilityAbsenceClaims(input.justification);
  const channels = distinctProbeChannels(input.probes);
  return {
    matched: claims.length > 0 && channels.length < MIN_INDEPENDENT_CHANNELS,
    claims,
    channels,
  };
}

/**
 * The second channel to name in the advisory for `subject` — a NAME, not a
 * sentence.
 *
 * Concrete per claim class, because "run a probe" is the failure this detector
 * exists to prevent, restated as advice. The credential branch names the two
 * calls that would have falsified the anchor instance.
 *
 * Deliberately a noun phrase the renderer splices into its own sentence. An
 * earlier draft returned the explanatory clause too, which read as a
 * mid-sentence non-sequitur once spliced ("...reports it configured before it
 * reaches them") and pushed the guard's worst-case render 600 chars past its
 * declared ceiling. The explanation belongs to the renderer, which owns the
 * sentence; this owns the channel.
 */
export function secondChannelFor(subject: string, phrase: string): string {
  // Capped so this string is a BOUNDED axis of the guard's rendered advisory.
  // The subject comes from a regex capture that admits up to three whitespace-
  // separated tokens, which is short in practice and unbounded in principle;
  // without this cap the guard's `renderProbe` could only ever pose a saturated
  // SAMPLE rather than a proved ceiling (`guard-feedback-authoring.mdc`).
  const name = subject ? subject.slice(0, MAX_SUBJECT_CHARS) : "the named capability";
  if (/\b(key|token|credential|credentials|access|permission)\b/i.test(phrase)) {
    return `\`ai_providers_list\` / \`ai_validate --provider ${name}\``;
  }
  return `${name}'s released docs, or \`--help\` on the installed version`;
}
