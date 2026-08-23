/**
 * The reaction emoji the principal channel uses as pipeline-state acks
 * (mt#3486).
 *
 * ## Every one of these is empirically verified, not chosen from a list
 *
 * `ReactionTypeEmoji.emoji` is a FIXED allowlist Telegram controls, and an
 * emoji outside it is rejected with a 400. Because reactions are
 * fire-and-forget by contract, that rejection is SILENT — the ack simply never
 * appears.
 *
 * The set this task was specced with was 👀 / ✅ / ⚠️❌. Probing the live API
 * (2026-08-01) found **✅, ⚠️ and ❌ all rejected** — every emoji except the
 * pickup one. Shipping the specced set unprobed would have produced a channel
 * where the "received" ack worked and the "done" and "error" acks silently did
 * nothing, forever, with no error anywhere.
 *
 * So these three are the ones the live API accepted, and
 * `scripts/principal-channel/verify-reaction-emoji.ts` re-checks them on
 * demand — Telegram can revise the list, and the failure mode is invisible.
 *
 * ## Why these three in particular
 *
 * They have to read as STATUS at a glance on a phone, not as sentiment. The
 * accepted set skews expressive (🎉 🔥 🤬 💩), which is wrong for a marker that
 * appears on every single message: celebratory punctuation on routine work
 * becomes noise the principal learns to ignore, which defeats the ack.
 */

/** The message reached the session driver and a turn is starting. */
export const REACTION_RECEIVED = "👀";

/** The turn completed and the reply was delivered. */
export const REACTION_DONE = "👌";

/**
 * The turn failed.
 *
 * Understated on purpose: the accepted alternatives (😱 🤬 💩 🤯) are alarm
 * emoji, and the principal already receives the failure as prose in the reply
 * itself. This marks WHICH message failed without shouting about it.
 */
export const REACTION_ERROR = "🤨";
