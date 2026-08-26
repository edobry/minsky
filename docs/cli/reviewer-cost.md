# `observability reviewer-cost`

Reports the reviewer bot's LLM spend from the `review_timing` table.

```bash
minsky observability reviewer-cost [--since <iso>] [--until <iso>] [--json]
```

## Why it exists

`review_timing` is the only place spend is attributable to a **PR**, a **round**, or a **scope
class**. OpenAI's usage dashboard reports by model and project and structurally cannot answer those
questions.

Before this command, every reader of that table resolved its handle from
`MINSKY_PERSISTENCE_POSTGRES_URL` in `process.env` — so measuring reviewer spend meant whoever asked
had to hold a Postgres URL in their shell. This command resolves the persistence provider from the DI
container instead. **No credential is passed by the caller and none appears in any output, including
error paths**: a connection failure reports that it failed, never what it tried to connect to.

## Flags

| Flag            | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `--since <iso>` | Only calls created on/after this timestamp. Omit for no lower bound.     |
| `--until <iso>` | Only calls created before this timestamp. Omit for no upper bound.       |
| `--json`        | Return the full structured report instead of the human-readable summary. |

The structured shape is a **superset** of the text — nothing rendered is absent from it.

## Reading the output

Most of it is self-describing. Three things are not:

**The `Excluded / flagged rows` block is the part that decides whether your number means anything.**

- `iteration_index = 0` — pre-model skip paths (routing-skip, concurrent-inflight). They carry no
  token data and including them skews every split (mem#800). Excluded from every statistic, counted
  here so the exclusion is visible rather than silent.
- `null input_tokens` — a review that started and recorded no token data. Excluded. **See the
  diagnostic below; a non-zero count here is often the most interesting number on the screen.**
- `null cached_tokens` — a real defect (mt#3665: chunked reviews recorded no cached count, and
  `computeCostUsd` priced a null as 0% cached, inflating those rows ~4x). Fixed, but historical rows
  remain. These are **included** in totals and flagged, because a window spanning the fix is not
  comparable to one that does not. A non-zero count means: do not quote a delta from this window.

**The at-cap bucket uses `>= 10` rounds, not `= 10`.** It answers "spent every round available to
it." mt#3526's table buckets by _exact_ round count, and rows exist with 11–36 rounds (chunked
reviews append across calls), so **this command's at-cap share will not reproduce mt#3526's figure**
and is not supposed to. Over 2026-08-18..25 this reports 39.6% of calls / 58.5% of spend against
35.1% / 47.0% for an exact-`= 10` query on the same rows.

**`Per active day` divides by days with at least one call**, not by calendar days in the window. A
window spanning a quiet weekend does not dilute the rate.

## Diagnostic: telling "the reviewer is idle" from "the reviewer is broken"

Discovered 2026-08-25, and it is the reason the `null input_tokens` counter is surfaced.

When reviews stop appearing, health checks are not enough — the service can be up, `inflightCount: 0`,
retriggers accepted, CI green, and still produce nothing. Run this command over the silent window:

- **0 priced calls and 0 null-token rows** → the reviewer genuinely had nothing to do. Idle.
- **0 priced calls but a non-zero null-token count** → reviews are being _attempted_ and consuming
  _no tokens_. That is the fingerprint of the model call failing, and it is visible from the table
  without reading a single log line.

On 2026-08-25 that read `0 priced calls / 27 null-token rows`, which resolved to
`429 You have no credits remaining` (`credit_balance_exhausted`) in the reviewer's deploy logs. The
occurrence is logged on mt#1697; mt#4600 turns it into an alert so the next one pages instead of
waiting to be noticed.

## See also

- **mt#3526** — the round-cap diagnosis this measures.
- **mt#3659** — the production watch that consumes these numbers.
- **mem#800** — reusable query shapes and the `iteration_index = 0` warning.
