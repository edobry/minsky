/**
 * Attach admissibility (mt#3095) — may the cockpit attach an input session driver to
 * this conversation right now?
 *
 * ## Why this is a gate and not a hint
 *
 * `claude --resume` provides NO multi-writer safety. Two processes resuming one
 * conversation both succeed, both append to the same transcript file, and both
 * record the SAME `parentUuid` — a silent DAG fork (empirically verified
 * 2026-07-23 on throwaway conversation `dd4f6bd6`; corroborated by the vendor's
 * own documentation, which states that resuming the same session in two
 * terminals without forking interleaves both into one transcript). A later
 * resume then picks one leaf and orphans the other's work.
 *
 * That failure has no error surface. Nothing throws, nothing warns, and the
 * loss is only visible later as missing history. So the ONLY point at which it
 * can be prevented is before attaching — which is what this function decides.
 *
 * ## Why absence of evidence refuses
 *
 * The safe default is REFUSE, not admit. `UNKNOWN` means mt#3201 has no
 * telemetry for this conversation (no hook coverage), NOT that the conversation
 * is quiet — mt#3201 returns it deliberately rather than guessing. Reading
 * "no signal" as "nobody is writing" is exactly the inference that produces the
 * silent fork, so it is refused.
 *
 * `STALLED` refuses for the mirror-image reason: there IS telemetry, and it says
 * the conversation was last observed mid-work and has since gone quiet. A wedged
 * process and a dead one are indistinguishable from outside, and the wedged one
 * still holds the file.
 *
 * ## What `IDLE` does NOT mean (mt#3656)
 *
 * `IDLE` means NO TURN IS IN FLIGHT. It does **not** mean no writer is
 * attached, and this gate cannot make it mean that. An iTerm tab left open
 * while the operator does something else reports `IDLE` — `presence.ts` is
 * explicit that a conversation quiet for a week is still `IDLE`, because
 * silence cannot prove an end — so admitting here can put a cockpit session driver on
 * a file a terminal process still holds. Both then write from their own cached
 * tip (mem#805) and one branch is silently orphaned. No simultaneity is needed:
 * the two writers overlap in ATTACHMENT, not in time.
 *
 * **This gate now has a SECOND, independent signal for exactly that gap**
 * (mt#4869): Claude Code's own live-session roster,
 * `<CLAUDE_CONFIG_DIR|~/.claude>/sessions/<pid>.json` — one file per running
 * `claude` process, which the vendor's own docs describe as existing "to
 * detect concurrent sessions and crashes"
 * (`code.claude.com/docs/en/claude-directory`). Verified 2026-09-01
 * (mem#805, mem#1356) against a live probe: the roster entry for a terminal
 * session persists for the process's whole life, is removed on clean exit,
 * and **tracks the conversation the process currently holds** — after
 * `/clear` the entry's `sessionId` switched to the new id within seconds.
 * Both halves of the premise this comment used to state here — "not an
 * event Minsky observes" and "Claude Code's own roster never fires for a
 * terminal `claude --resume`" — were false. `./claude-code-session-roster.ts`
 * reads this roster with the vendor's own liveness rule (pid alive,
 * `procStart` matched against the live process to guard against pid reuse, a
 * 24h cap) and this function refuses outright when it reports a live holder,
 * carrying that holder's identity into the refusal.
 *
 * The roster is not a replacement for presence — it answers "is a process
 * holding this file", presence answers "is a turn in flight", and both must
 * clear before an attach is admitted (see `attachAdmissibility` below). Nor
 * is it complete: it only sees a `claude` process that registers a roster
 * entry. **Prevention is out of reach only for a writer that does not
 * register** — which writer kinds those are is measured, not assumed; see
 * mt#4869's `## Does NOT cover` for the current answer. For that residual
 * population the `last-prompt` divergence detector
 * (`../transcripts/writer-divergence.ts`) still answers the hazard AFTER the
 * fact, exactly as before this change. The structural alternative (minting a
 * new identity at attach) is mt#3515, whose memo rejects blind forking on
 * every idle attach as disproportionate.
 *
 * @see ./presence.ts — `derivePresence`, the source of the value this gates on
 * @see ./claude-code-session-roster.ts — the roster reader this consults (mt#4869)
 * @see mt#3095 — this module
 * @see mt#4869 — the roster-consulting addition to this module
 * @see mt#3038 — the cross-process advisory lock that guards the OTHER writer
 *   class (two cockpit session drivers); this function guards the class that lock
 *   cannot see (a `claude` the operator started in a terminal)
 */
import type { ConversationPresence } from "./presence";
import type { RosterClassification, RosterHolder } from "./claude-code-session-roster";

/** Why an attach was refused — carried to the caller so the refusal can explain itself. */
export type AttachRefusalReason =
  | "live-writer"
  | "awaiting-human"
  | "possibly-wedged"
  | "no-telemetry"
  // mt#4869: the roster (not presence) is the source of these two.
  | "live-elsewhere"
  | "roster-unknown";

export type AttachAdmissibility =
  | { admit: true }
  | {
      admit: false;
      reason: AttachRefusalReason;
      message: string;
      /** Present when `reason === "live-elsewhere"` — who the roster says is holding it (mt#4869). */
      holder?: RosterHolder;
    };

/**
 * Operator-facing explanation per refusal reason. Kept beside the decision so a
 * caller cannot render a refusal without its cause, and so the wording is
 * asserted by the same tests that pin the decision.
 */
const REFUSAL_MESSAGES: Record<AttachRefusalReason, string> = {
  "live-writer":
    "This conversation is being written to right now. Attaching would fork its history, so the cockpit will not attach until it goes idle.",
  "awaiting-human":
    "This conversation is waiting on a human and still has a writer attached. Attaching now would fork its history.",
  "possibly-wedged":
    "This conversation was last seen mid-work and has gone quiet. Its process may still be running, so the cockpit will not attach — a wedged writer and a dead one look identical from here.",
  "no-telemetry":
    "There is no activity telemetry for this conversation, so the cockpit cannot tell whether something is writing to it. Attaching without that evidence risks forking its history.",
  "live-elsewhere":
    "Another Claude Code process is currently holding this conversation. Attaching here would fork its history, so the cockpit will not attach until that process exits.",
  "roster-unknown":
    "Claude Code's live-session roster could not be read, so the cockpit cannot tell whether another process is holding this conversation. Attaching without that evidence risks forking its history.",
};

/**
 * Narrowing helper: reaching this means a `ConversationPresence` member was
 * added without being classified here. The parameter's `never` type is what
 * turns that omission into a COMPILE error, and the error names the unhandled
 * member — which the bare "function lacks ending return statement" TS2366 that
 * the switch alone produces does not.
 *
 * The throw is unreachable under a correct build. It exists so that a
 * `ConversationPresence` widened at runtime by an untyped caller fails loudly
 * instead of returning `undefined` into a boolean check, where it would read as
 * "not admitted" by luck rather than by decision. (PR #2466 R1.)
 */
function assertNeverPresence(presence: never): never {
  throw new Error(`Unclassified conversation presence for attach: ${String(presence)}`);
}

/**
 * Decide whether a session driver may attach to a conversation.
 *
 * Two independent signals must BOTH clear (mt#4869). `roster` — a FRESH
 * classification from `./claude-code-session-roster.ts`, never a cached one
 * — is checked FIRST: `liveness === "running"` refuses regardless of
 * `presence`, because a live holder forks history no matter what hook
 * telemetry says, and the holder's identity rides along on the decision so a
 * caller can name it. `liveness === "unknown"` refuses for the same reason
 * `UNKNOWN` presence does — absence of evidence is not evidence of absence —
 * with a message that says the roster specifically was unreadable. Only once
 * the roster reports `not_running` does control reach the `presence` switch
 * below.
 *
 * That switch is exhaustive over `ConversationPresence`, enforced two ways:
 * it returns on every member, and `assertNeverPresence` below makes an
 * unhandled member a compile error that names it. A new presence value must
 * be classified by a human, never absorbed by a permissive `default:`.
 *
 * PR #2466 R1 asked for this and reported that the switch alone was not
 * compile-safe. Verified empirically before changing anything: adding a seventh
 * member DOES already fail the build (`TS2366` — "function lacks ending return
 * statement and return type does not include 'undefined'"), so the previous
 * form was not the silent-`undefined` hazard the finding described. The
 * `never` guard is adopted anyway because it is strictly better: it names the
 * offending member in the error instead of pointing at the closing brace, and
 * it keeps holding if the return type is ever widened to include `undefined`,
 * which would silence TS2366.
 */
export function attachAdmissibility(
  presence: ConversationPresence,
  roster: RosterClassification
): AttachAdmissibility {
  if (roster.liveness === "running") {
    return {
      admit: false,
      reason: "live-elsewhere",
      message: REFUSAL_MESSAGES["live-elsewhere"],
      holder: roster.holder ?? undefined,
    };
  }
  if (roster.liveness === "unknown") {
    return refuse("roster-unknown");
  }

  switch (presence) {
    // The designed case: a conversation sitting between turns.
    case "IDLE":
      return { admit: true };
    // An observed `SessionEnd` with no later event — nothing holds the file.
    // Attaching here is precisely Phase 1's resume, which already ships.
    case "ENDED":
      return { admit: true };
    case "LIVE":
      return refuse("live-writer");
    case "NEEDS_INPUT":
      return refuse("awaiting-human");
    case "STALLED":
      return refuse("possibly-wedged");
    case "UNKNOWN":
      return refuse("no-telemetry");
    default:
      return assertNeverPresence(presence);
  }
}

function refuse(reason: AttachRefusalReason): AttachAdmissibility {
  return { admit: false, reason, message: REFUSAL_MESSAGES[reason] };
}
