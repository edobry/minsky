/**
 * A REAL two-writer divergence, captured 2026-08-04 against claude 2.1.222
 * (mt#3656).
 *
 * Produced deliberately in an isolated scratch cwd, so no synthetic fork
 * entered the principal's corpus: a long-lived
 * `claude -p --resume <id> --input-format stream-json --output-format stream-json`
 * — the exact argv `buildResumeSessionArgs` emits — drove one turn; a separate
 * SHORT-LIVED `claude -p --resume <id>` then advanced the file and re-read the
 * tip correctly; the long-lived process wrote its next turn from its cached
 * step-A tip, forking the tree.
 *
 * `EXTERNAL` (`66856438`) and `LONGLIVED_B` (`0919e084`) are the resulting
 * sibling prompts under one parent, and BOTH carry assistant descendants —
 * the both-answered shape mt#3513 records as never having been observed across
 * 207 real transcripts.
 *
 * uuids, `parentUuid` edges, and file order are verbatim. Message bodies and
 * per-line metadata are stripped because the detector reads none of them; this
 * is a structural projection, not a redacted transcript.
 */
export const WRITER_DIVERGENCE_SPECIMEN: readonly unknown[] = [
  { type: "user", uuid: "260352a6-ca8f-4d8d-846a-84cc729d9b37", parentUuid: null },
  {
    type: "attachment",
    uuid: "b30b3320-c5a9-49e9-a644-01a9947e2b00",
    parentUuid: "260352a6-ca8f-4d8d-846a-84cc729d9b37",
  },
  {
    type: "attachment",
    uuid: "df1acbfc-4ebf-4349-8f79-4fe30663bf80",
    parentUuid: "b30b3320-c5a9-49e9-a644-01a9947e2b00",
  },
  {
    type: "attachment",
    uuid: "c406e56d-8b2e-42ac-b79b-b3445d10e7c4",
    parentUuid: "df1acbfc-4ebf-4349-8f79-4fe30663bf80",
  },
  {
    type: "assistant",
    uuid: "32d6a308-409b-49d4-9f15-e503c002eb57",
    parentUuid: "c406e56d-8b2e-42ac-b79b-b3445d10e7c4",
  },
  { type: "last-prompt", leafUuid: "32d6a308-409b-49d4-9f15-e503c002eb57" },
  {
    type: "user",
    uuid: "21cc2b80-12bb-4fb6-a281-c60eb5e05fce",
    parentUuid: "32d6a308-409b-49d4-9f15-e503c002eb57",
  },
  {
    type: "assistant",
    uuid: "cfaed6eb-5759-4401-b056-174f04e0cb2f",
    parentUuid: "21cc2b80-12bb-4fb6-a281-c60eb5e05fce",
  },
  {
    type: "assistant",
    uuid: "1b0208f8-101d-4eba-bb03-d7e5e425e722",
    parentUuid: "cfaed6eb-5759-4401-b056-174f04e0cb2f",
  },
  // ── the fork: both of these parent to 1b0208f8 ──────────────────────────────
  {
    type: "user",
    uuid: "66856438-b52e-45b3-aed7-0ceb8fdf6724",
    parentUuid: "1b0208f8-101d-4eba-bb03-d7e5e425e722",
  },
  {
    type: "attachment",
    uuid: "98baf71d-61dd-4977-a4e9-7c0c464a2e3b",
    parentUuid: "66856438-b52e-45b3-aed7-0ceb8fdf6724",
  },
  {
    type: "assistant",
    uuid: "38386695-7b1e-4b16-ad55-e2178ed9d1f9",
    parentUuid: "98baf71d-61dd-4977-a4e9-7c0c464a2e3b",
  },
  {
    type: "assistant",
    uuid: "df8b0632-f860-4d1b-b4d2-35ba2bd24f56",
    parentUuid: "38386695-7b1e-4b16-ad55-e2178ed9d1f9",
  },
  { type: "last-prompt", leafUuid: "df8b0632-f860-4d1b-b4d2-35ba2bd24f56" },
  {
    type: "user",
    uuid: "0919e084-b1d7-4dc4-8bea-96cc3a8061f7",
    parentUuid: "1b0208f8-101d-4eba-bb03-d7e5e425e722",
  },
  {
    type: "assistant",
    uuid: "7ee623df-7f59-40f5-8fb8-b611bd9f182b",
    parentUuid: "0919e084-b1d7-4dc4-8bea-96cc3a8061f7",
  },
  {
    type: "assistant",
    uuid: "49eaa830-8b29-4888-8391-dbca7575452c",
    parentUuid: "7ee623df-7f59-40f5-8fb8-b611bd9f182b",
  },
  { type: "last-prompt", leafUuid: "49eaa830-8b29-4888-8391-dbca7575452c" },
];

/** Tip of the branch the short-lived external writer extended. */
export const SPECIMEN_BRANCH_A_TIP = "df8b0632-f860-4d1b-b4d2-35ba2bd24f56";
/** Tip of the branch the long-lived (cockpit-shaped) writer extended. */
export const SPECIMEN_BRANCH_B_TIP = "49eaa830-8b29-4888-8391-dbca7575452c";
/** The pre-fork `last-prompt` leaf — an ancestor of both branches, not a tip. */
export const SPECIMEN_SHARED_ANCESTOR_LEAF = "32d6a308-409b-49d4-9f15-e503c002eb57";
