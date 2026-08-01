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
 * The notice Minsky sends when it resumes a conversation whose actuator died
 * mid-turn (mt#3038). Sent verbatim through the input channel.
 */
export const INTERRUPTION_NOTICE_TEXT =
  "[minsky] This conversation was resumed after an unexpected interruption — the previous " +
  "actuator process was terminated (most likely a cockpit daemon restart) potentially " +
  "mid-turn. Before continuing, verify whether your last in-flight action actually " +
  "completed rather than assuming it did.";

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
