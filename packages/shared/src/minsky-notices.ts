/**
 * Notices MINSKY itself injects into a conversation's input channel (mt#3396).
 *
 * Distinct from `./harness-markup.ts`, and deliberately a separate module: that
 * file inventories markup the HARNESS emits. The text here is Minsky's own,
 * delivered through the same channel an operator types into — which is exactly
 * why it needs naming. A notice that Minsky wrote, rendered under the
 * operator's label, is Minsky misattributing its own words; mt#3374 fixed that
 * misattribution for harness content, and this closes the case Minsky fully
 * controls.
 *
 * ## Why the constants live in `shared`
 *
 * Two consumers on opposite sides of the browser boundary need the same string:
 * the SENDER (`src/cockpit/driven-session-host.ts`, server-side) and the
 * DETECTOR (`src/cockpit/web/lib/injected-content.ts`, in the browser bundle,
 * which `custom/no-node-import-in-cockpit-web` forbids from importing server
 * code). A second copy in the detector would be a string that silently stops
 * matching the moment the notice is reworded — the same drift
 * `harness-markup.ts` was created to end for tags.
 */

/**
 * The notice Minsky sends when it resumes a conversation whose session driver died
 * mid-turn (mt#3038). Sent verbatim through the input channel.
 *
 * ## Why it names the harness's own marker (mt#4037)
 *
 * The last sentence exists because the notice is not the only thing the resumed
 * model reads about the interruption — its own transcript is, and the transcript
 * says something contradictory. When a turn is interrupted for ANY reason, the
 * harness synthesizes a `tool_result` reading "The user doesn't want to proceed
 * with this tool use. The tool use was rejected", followed by
 * `[Request interrupted by user for tool use]`. That is boilerplate for every
 * interrupt, including one where no human was present.
 *
 * Observed 2026-08-11: a cockpit restart killed a thread's session driver mid-turn at
 * 03:38:43Z. On resume the agent read those markers and reported to the
 * operator that its call had been "rejected" — attributing to them an action
 * they did not take and were asleep for. The notice was already accurate about
 * the cause; it simply never told the model that the louder, more specific
 * evidence sitting in its own context was wrong.
 */
export const INTERRUPTION_NOTICE_TEXT =
  "[minsky] This conversation was resumed after an unexpected interruption — the previous " +
  "session driver process was terminated (most likely a cockpit daemon restart) potentially " +
  "mid-turn. Before continuing, verify whether your last in-flight action actually " +
  "completed rather than assuming it did. Your transcript may show " +
  "'[Request interrupted by user for tool use]' or a tool_result saying the user rejected " +
  "the call — that is the harness's boilerplate for ANY interruption and does NOT mean the " +
  "operator did anything. Do not report it to them as a rejection.";

/**
 * The stable leading clause the detector anchors on.
 *
 * Matching the FULL notice would be brittle — any wording change to the tail
 * (which is guidance prose, the part most likely to be tuned) would silently
 * stop detection. Matching this leading clause survives that.
 *
 * The pairing is enforced, not merely intended:
 * `src/cockpit/web/lib/injected-content.test.ts` asserts
 * `INTERRUPTION_NOTICE_TEXT.startsWith(INTERRUPTION_NOTICE_PREFIX)`, so editing
 * the notice's opening without updating the prefix fails a test instead of
 * quietly disabling the detector.
 */
export const INTERRUPTION_NOTICE_PREFIX =
  "[minsky] This conversation was resumed after an unexpected interruption";
