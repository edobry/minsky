/**
 * Attach admissibility (mt#3095) — may the cockpit attach an input actuator to
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
 * @see ./presence.ts — `derivePresence`, the source of the value this gates on
 * @see mt#3095 — this module
 * @see mt#3038 — the cross-process advisory lock that guards the OTHER writer
 *   class (two cockpit actuators); this function guards the class that lock
 *   cannot see (a `claude` the operator started in a terminal)
 */
import type { ConversationPresence } from "./presence";

/** Why an attach was refused — carried to the caller so the refusal can explain itself. */
export type AttachRefusalReason =
  | "live-writer"
  | "awaiting-human"
  | "possibly-wedged"
  | "no-telemetry";

export type AttachAdmissibility =
  | { admit: true }
  | { admit: false; reason: AttachRefusalReason; message: string };

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
};

/**
 * Decide whether an actuator may attach to a conversation in `presence`.
 *
 * Exhaustive over `ConversationPresence` by construction: the `switch` returns
 * on every member and the function has no trailing fallback, so adding a
 * seventh presence value makes this a compile error rather than a silent
 * admit-by-default. That direction is deliberate — a new presence value must be
 * classified by a human, not absorbed by a `default:` branch.
 */
export function attachAdmissibility(presence: ConversationPresence): AttachAdmissibility {
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
  }
}

function refuse(reason: AttachRefusalReason): AttachAdmissibility {
  return { admit: false, reason, message: REFUSAL_MESSAGES[reason] };
}
