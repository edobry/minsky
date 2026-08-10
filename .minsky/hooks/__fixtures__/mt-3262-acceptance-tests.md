## Acceptance Tests

1. `SemanticEvent.sourceRef` is populated for content-bearing events (adapter test), and a round-trip test asserts the index identity this design rests on: for a fixture transcript, `adaptTranscriptToEvents`'s event at `sourceRef.turnIndex = N` resolves to the same source line as `assembleSessionContextSnapshot`'s block with `turnIndex === N`.
2. Expanding a THINK / SPEAK / WRITE / ASK / tool-call row shows the corresponding real content (live-browser screenshot per verb kind in the PR body, not just unit assertions).
3. The deep-link navigates to the conversation view for that moment.
4. A pre-content-capture / missing-content session degrades gracefully (documented state, no crash).
5. A session ingested BEFORE `CREDENTIAL_SCRUB_CUTOFF_ISO` is refused by the content endpoint with the same 422/`unscrubbed` shape the events endpoint returns, unless `verifiedRescrubbed=true` is passed.
